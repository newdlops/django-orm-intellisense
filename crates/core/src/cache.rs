//! Binary cache layer used by the Django ORM Intellisense extension.
//!
//! Replaces the JSON/dataclass round-trip in `python/django_orm_intellisense/
//! cache/store.py` with a bincode-encoded envelope over a length-prefixed
//! payload. A versioned header makes stale-format detection a single read
//! rather than a full parse.
//!
//! Schema version v14 — incompatible with the JSON v13 used prior to the
//! Rust migration. Old caches are ignored (consumer's responsibility to
//! call `load` which returns `Miss`).

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use memmap2::Mmap;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Current cache schema version. Bump on any envelope or payload layout
/// change. Writers stamp this; readers reject mismatches.
pub const CACHE_SCHEMA_VERSION: u32 = 14;

/// Magic bytes to detect truncated or foreign files cheaply.
const MAGIC: [u8; 4] = *b"DORM";

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("encode error: {0}")]
    Encode(#[from] bincode::error::EncodeError),
    #[error("decode error: {0}")]
    Decode(#[from] bincode::error::DecodeError),
    #[error("schema mismatch: file={file} runtime={runtime}")]
    SchemaMismatch { file: u32, runtime: u32 },
    #[error("bad magic: file does not look like a cache envelope")]
    BadMagic,
    #[error("metadata mismatch")]
    MetadataMismatch,
}

pub type CacheResult<T> = Result<T, CacheError>;

/// On-disk header. Fixed layout, written before the bincoded metadata and
/// payload blobs. Readers can reject a stale cache after 12 bytes.
#[repr(C)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, bincode::Encode, bincode::Decode)]
struct EnvelopeHeader {
    magic: [u8; 4],
    schema_version: u32,
    metadata_len: u32,
}

/// Load result. `Hit` carries the decoded metadata and payload. `Miss`
/// covers missing file, schema drift, truncation, or a caller-rejected
/// metadata comparison.
#[derive(Debug)]
pub enum CacheLoad<M, P> {
    Hit { metadata: M, payload: P },
    Miss,
}

/// Serialize and write the envelope atomically. Writes to a sibling `.tmp`
/// file and renames into place so crashes never leave a half-written
/// cache.
pub fn save<M, P>(path: &Path, metadata: &M, payload: &P) -> CacheResult<()>
where
    M: Serialize,
    P: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let metadata_bytes = bincode::serde::encode_to_vec(metadata, bincode::config::standard())?;
    let payload_bytes = bincode::serde::encode_to_vec(payload, bincode::config::standard())?;

    let header = EnvelopeHeader {
        magic: MAGIC,
        schema_version: CACHE_SCHEMA_VERSION,
        metadata_len: u32::try_from(metadata_bytes.len())
            .map_err(|_| std::io::Error::other("metadata exceeds u32::MAX"))?,
    };
    let header_bytes = bincode::encode_to_vec(header, bincode::config::standard())?;

    let tmp_path = tmp_sibling(path);
    {
        let mut file = File::create(&tmp_path)?;
        file.write_all(&header_bytes)?;
        file.write_all(&metadata_bytes)?;
        file.write_all(&payload_bytes)?;
        file.sync_data()?;
    }
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Persist byte blobs in the existing `Vec<u8>` envelope without joining or
/// encoding a second complete payload. Chunks are borrowed only for this call.
pub fn save_byte_chunks<T: AsRef<[u8]>>(
    path: &Path,
    metadata: &[u8],
    chunks: &[T],
) -> CacheResult<()> {
    let payload_len = chunks.iter().try_fold(0usize, |length, chunk| {
        length
            .checked_add(chunk.as_ref().len())
            .ok_or_else(|| std::io::Error::other("payload length overflow"))
    })?;
    let metadata_bytes = bincode::encode_to_vec(metadata, bincode::config::standard())?;
    let header = EnvelopeHeader {
        magic: MAGIC,
        schema_version: CACHE_SCHEMA_VERSION,
        metadata_len: u32::try_from(metadata_bytes.len())
            .map_err(|_| std::io::Error::other("metadata exceeds u32::MAX"))?,
    };
    let header_bytes = bincode::encode_to_vec(header, bincode::config::standard())?;
    let payload_prefix = bincode::encode_to_vec(payload_len, bincode::config::standard())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    // Unique owned siblings prevent concurrent writers from truncating each
    // other's temporary envelope. Failed writes/flushes/renames clean up on drop.
    let mut temporary = tempfile::Builder::new()
        .prefix(".dorm-cache-")
        .tempfile_in(parent)?;
    {
        let mut writer = BufWriter::with_capacity(64 * 1024, temporary.as_file_mut());
        write_byte_chunks(
            &mut writer,
            &header_bytes,
            &metadata_bytes,
            &payload_prefix,
            chunks,
        )?;
    }
    temporary.as_file().sync_data()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn write_byte_chunks<T: AsRef<[u8]>, W: Write>(
    writer: &mut W,
    header: &[u8],
    metadata: &[u8],
    payload_prefix: &[u8],
    chunks: &[T],
) -> std::io::Result<()> {
    writer.write_all(header)?;
    writer.write_all(metadata)?;
    writer.write_all(payload_prefix)?;
    for chunk in chunks {
        writer.write_all(chunk.as_ref())?;
    }
    writer.flush()
}

/// Load the envelope via mmap. Metadata is deserialized eagerly so the
/// caller can compare against expected values; payload is deserialized
/// only if `accept_metadata` returns `Ok(())`.
pub fn load<M, P, F>(path: &Path, accept_metadata: F) -> CacheResult<CacheLoad<M, P>>
where
    M: DeserializeOwned,
    P: DeserializeOwned,
    F: FnOnce(&M) -> bool,
{
    let file = match File::open(path) {
        Ok(f) => f,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(CacheLoad::Miss),
        Err(err) => return Err(err.into()),
    };

    let mmap = unsafe { Mmap::map(&file)? };
    let bytes: &[u8] = &mmap;

    // Decode header (fixed-size bincode).
    let (header, header_len): (EnvelopeHeader, usize) =
        bincode::decode_from_slice(bytes, bincode::config::standard())?;

    if header.magic != MAGIC {
        return Err(CacheError::BadMagic);
    }
    if header.schema_version != CACHE_SCHEMA_VERSION {
        // Stale schema — caller treats as miss; delete is their choice.
        let _ = fs::remove_file(path);
        return Ok(CacheLoad::Miss);
    }

    let metadata_end = header_len
        .checked_add(header.metadata_len as usize)
        .ok_or_else(|| std::io::Error::other("metadata length overflow"))?;
    if metadata_end > bytes.len() {
        return Err(CacheError::Decode(bincode::error::DecodeError::Other(
            "truncated metadata",
        )));
    }

    let (metadata, _): (M, usize) = bincode::serde::decode_from_slice(
        &bytes[header_len..metadata_end],
        bincode::config::standard(),
    )?;

    if !accept_metadata(&metadata) {
        return Ok(CacheLoad::Miss);
    }

    let (payload, _): (P, usize) =
        bincode::serde::decode_from_slice(&bytes[metadata_end..], bincode::config::standard())?;

    Ok(CacheLoad::Hit { metadata, payload })
}

/// Compute the per-workspace cache directory. Matches the layout
/// previously used by `_workspace_cache_dir` in the Python side — same
/// name and hash derivation, so co-existence is well-defined during the
/// migration window. Format: `<cache_root>/<safe_name>-<hash[..16]>`.
pub fn workspace_cache_dir(cache_root: &Path, workspace_root: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(workspace_root.to_string_lossy().as_bytes());
    let digest = hex_16(&hasher.finalize());

    let name = workspace_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe_name = safe_name.trim_matches('-');
    let safe_name = if safe_name.is_empty() {
        "workspace"
    } else {
        safe_name
    };

    cache_root.join(format!("{safe_name}-{digest}"))
}

fn hex_16(digest: &[u8]) -> String {
    let mut out = String::with_capacity(16);
    for b in digest.iter().take(8) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone)]
    struct Meta {
        schema: u32,
        workspace: String,
        fingerprint: String,
    }

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone)]
    struct Payload {
        models: Vec<(String, Vec<String>)>,
    }

    fn sample_payload(n: usize) -> Payload {
        Payload {
            models: (0..n)
                .map(|i| {
                    let name = format!("app{}.Model{i}", i / 100);
                    let fields = (0..20).map(|f| format!("field_{f}")).collect();
                    (name, fields)
                })
                .collect(),
        }
    }

    #[test]
    fn round_trip_hit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.bin");
        let meta = Meta {
            schema: 14,
            workspace: "/tmp/x".into(),
            fingerprint: "abc".into(),
        };
        let payload = sample_payload(10);

        save(&path, &meta, &payload).unwrap();
        let loaded: CacheLoad<Meta, Payload> = load(&path, |m| m == &meta).unwrap();
        match loaded {
            CacheLoad::Hit {
                metadata,
                payload: got,
            } => {
                assert_eq!(metadata, meta);
                assert_eq!(got, payload);
            }
            CacheLoad::Miss => panic!("expected hit"),
        }
    }

    #[test]
    fn metadata_rejection_is_miss() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.bin");
        let meta = Meta {
            schema: 14,
            workspace: "/tmp/x".into(),
            fingerprint: "abc".into(),
        };
        save(&path, &meta, &sample_payload(5)).unwrap();

        let loaded: CacheLoad<Meta, Payload> = load(&path, |_| false).unwrap();
        assert!(matches!(loaded, CacheLoad::Miss));
    }

    #[test]
    fn missing_file_is_miss() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.bin");
        let loaded: CacheLoad<Meta, Payload> = load(&path, |_| true).unwrap();
        assert!(matches!(loaded, CacheLoad::Miss));
    }

    #[test]
    fn workspace_cache_dir_is_stable() {
        let root = Path::new("/tmp/cache");
        let ws = Path::new("/Users/alice/project-django");
        let a = workspace_cache_dir(root, ws);
        let b = workspace_cache_dir(root, ws);
        assert_eq!(a, b);
        assert!(a.starts_with(root));
        let name = a.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("project-django-"));
        assert_eq!(name.rsplit_once('-').unwrap().1.len(), 16);
    }

    #[test]
    fn byte_chunks_match_existing_envelope_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir.path().join("previous.bin");
        let current = dir.path().join("current.bin");
        for length in [0, 1, 250, 251, 255, 256, 65535, 65536, 131079] {
            let metadata: Vec<u8> = (0..length.min(1024))
                .map(|index| (index % 256) as u8)
                .collect();
            let payload: Vec<u8> = (0..length).map(|index| (index % 256) as u8).collect();
            save(&previous, &metadata, &payload).unwrap();
            for chunk_size in [1, 17, 65536] {
                let mut chunks: Vec<&[u8]> = payload.chunks(chunk_size).collect();
                chunks.insert(0, &[]);
                chunks.push(&[]);
                save_byte_chunks(&current, &metadata, &chunks).unwrap();
                assert_eq!(
                    fs::read(&previous).unwrap(),
                    fs::read(&current).unwrap(),
                    "existing Vec envelope differs for length{length}/chunk{chunk_size}"
                );
                let result: CacheLoad<Vec<u8>, Vec<u8>> =
                    load(&current, |value| value == &metadata).unwrap();
                match result {
                    CacheLoad::Hit {
                        metadata: got_metadata,
                        payload: got_payload,
                    } => {
                        assert_eq!(got_metadata, metadata);
                        assert_eq!(got_payload, payload);
                    }
                    CacheLoad::Miss => panic!("streamed byte envelope missed"),
                }
            }
        }
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            2,
            "owned temporary files leaked"
        );
    }

    #[test]
    fn byte_chunks_own_temporary_files_and_clean_failed_replace() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("cache.bin");
        fs::create_dir(&target).unwrap();
        let retained = target.join("retained");
        fs::write(&retained, b"old owner").unwrap();
        let unrelated = dir.path().join("cache.bin.tmp");
        fs::write(&unrelated, b"unrelated writer").unwrap();
        assert!(save_byte_chunks(&target, b"metadata", &[b"payload".as_slice()]).is_err());
        assert_eq!(fs::read(&retained).unwrap(), b"old owner");
        assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated writer");
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            2,
            "failed persist leaked owned sibling"
        );
    }

    #[test]
    fn concurrent_byte_chunk_writers_publish_complete_owned_envelopes() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("cache.bin");
        save_byte_chunks(&target, &[0], &[vec![0; 4096]]).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        std::thread::scope(|scope| {
            for tag in [1u8, 2u8] {
                let barrier = Arc::clone(&barrier);
                let target = &target;
                scope.spawn(move || {
                    let bytes = vec![tag; 4096];
                    let chunks = vec![bytes.as_slice(); 32];
                    barrier.wait();
                    for _ in 0..30 {
                        save_byte_chunks(target, &[tag], &chunks).unwrap();
                    }
                });
            }
            barrier.wait();
            for _ in 0..100 {
                let result: CacheLoad<Vec<u8>, Vec<u8>> = load(&target, |_| true).unwrap();
                match result {
                    CacheLoad::Hit { metadata, payload } => {
                        assert_eq!(metadata.len(), 1);
                        assert!([0, 1, 2].contains(&metadata[0]));
                        assert!(payload.iter().all(|byte| *byte == metadata[0]));
                        assert_eq!(payload.len(), if metadata[0] == 0 { 4096 } else { 131072 });
                    }
                    CacheLoad::Miss => panic!("atomic target disappeared"),
                }
            }
        });
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "concurrent siblings leaked"
        );
    }

    #[test]
    fn byte_chunk_writer_handles_short_writes_and_propagates_io_errors() {
        struct LimitedWriter {
            bytes: Vec<u8>,
            remaining: usize,
            fail_flush: bool,
            zero_on_exhaustion: bool,
        }
        impl Write for LimitedWriter {
            fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
                if self.remaining == 0 {
                    return if self.zero_on_exhaustion {
                        Ok(0)
                    } else {
                        Err(std::io::Error::other("injected write failure"))
                    };
                }
                let written = input.len().min(self.remaining).min(3);
                self.bytes.extend_from_slice(&input[..written]);
                self.remaining -= written;
                Ok(written)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                if self.fail_flush {
                    Err(std::io::Error::other("injected flush failure"))
                } else {
                    Ok(())
                }
            }
        }
        let chunks = [b"payload-one".as_slice(), &[], b"payload-two".as_slice()];
        let mut short = LimitedWriter {
            bytes: vec![],
            remaining: usize::MAX,
            fail_flush: false,
            zero_on_exhaustion: false,
        };
        write_byte_chunks(&mut short, b"header", b"meta", b"len", &chunks).unwrap();
        assert_eq!(short.bytes, b"headermetalenpayload-onepayload-two");
        for zero in [false, true] {
            let mut failing = LimitedWriter {
                bytes: vec![],
                remaining: 18,
                fail_flush: false,
                zero_on_exhaustion: zero,
            };
            let error =
                write_byte_chunks(&mut failing, b"header", b"meta", b"len", &chunks).unwrap_err();
            assert_eq!(failing.bytes, short.bytes[..18]);
            assert_eq!(
                error.kind(),
                if zero {
                    std::io::ErrorKind::WriteZero
                } else {
                    std::io::ErrorKind::Other
                }
            );
        }
        let mut failing = LimitedWriter {
            bytes: vec![],
            remaining: usize::MAX,
            fail_flush: true,
            zero_on_exhaustion: false,
        };
        assert!(write_byte_chunks(&mut failing, b"header", b"meta", b"len", &chunks).is_err());
        assert_eq!(failing.bytes, short.bytes);
    }
}
