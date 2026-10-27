//! Versioned source identities for comparison with Python source snapshots.
//!
//! This describes filesystem state only. A metadata payload must separately be
//! bound to the producer's validated source/runtime generation. Taking a fresh
//! snapshot when an older payload is saved does not establish that binding.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::Path;

use rayon::prelude::*;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::discovery::is_skipped_dir_name;

pub const FINGERPRINT_VERSION: u32 = 2;
pub const MEMBERSHIP_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceIdentity {
    pub size: u64,
    pub mtime_ns: i128,
    pub ctime_ns: i128,
    pub device: u64,
    pub inode: u64,
}

#[derive(Debug, Clone)]
pub struct SourceEntry {
    pub relative_path: String,
    pub identity: SourceIdentity,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct SourceSnapshot {
    pub root: String,
    pub fingerprint: String,
    pub entries: Vec<SourceEntry>,
    pub directory_fingerprints: Vec<(String, String)>,
}

struct SourcePath {
    text: String,
    parts: Vec<String>,
}

// Match pathlib's lexical POSIX spelling, including '..' and the distinct
// exactly-two-leading-slashes anchor. Never canonicalize a file symlink.
fn source_path(path: &Path) -> io::Result<SourcePath> {
    let text = path.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Source path is not valid UTF-8")
    })?;
    let anchor = if text.starts_with("//") && !text.starts_with("///") {
        "//"
    } else if text.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts: Vec<String> = text
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
        .collect();
    let mut normalized = format!("{anchor}{}", parts.join("/"));
    if !anchor.is_empty() {
        parts.insert(0, anchor.into());
    }
    if normalized.is_empty() {
        normalized.push('.');
    }
    Ok(SourcePath {
        text: normalized,
        parts,
    })
}

fn source_files(root: &SourcePath) -> io::Result<Vec<SourcePath>> {
    if !fs::metadata(&root.text)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Source root is not a directory",
        ));
    }
    let mut files = Vec::new();
    let mut walker = WalkDir::new(&root.text)
        .follow_links(false)
        .follow_root_links(true)
        .into_iter();
    while let Some(entry) = walker.next() {
        let entry = entry.map_err(|error| {
            io::Error::other(format!("Source inventory is incomplete: {error}"))
        })?;
        let name = entry.file_name().to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Source name is not valid UTF-8")
        })?;
        let kind = entry.file_type();
        if kind.is_dir() {
            if entry.depth() > 0 && is_skipped_dir_name(name) {
                walker.skip_current_dir();
            }
            continue;
        }
        // Python includes hidden files and the filename '.py'. It excludes
        // directory symlinks, but includes individual symlinks to files.
        if !name.ends_with(".py") {
            continue;
        }
        if kind.is_symlink() {
            let target = fs::metadata(entry.path())?;
            if target.is_dir() {
                continue;
            }
            if !target.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Source link does not point to a regular file",
                ));
            }
        } else if !kind.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Source is not a regular file",
            ));
        }
        files.push(source_path(entry.path())?);
    }
    Ok(files)
}

#[cfg(unix)]
fn source_identity(metadata: &fs::Metadata) -> io::Result<SourceIdentity> {
    use std::os::unix::fs::MetadataExt;
    Ok(SourceIdentity {
        size: metadata.len(),
        mtime_ns: i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec()),
        ctime_ns: i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()),
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
fn source_identity(_metadata: &fs::Metadata) -> io::Result<SourceIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Python source identity v2 is not supported on this platform",
    ))
}

pub fn file_fingerprint(relative_path: &str, identity: &SourceIdentity) -> String {
    let mut digest = Sha256::new();
    digest.update(relative_path.as_bytes());
    digest.update(b"\0");
    digest.update(
        format!(
            "{}:{}:{}:{}:{}",
            identity.size, identity.mtime_ns, identity.ctime_ns, identity.device, identity.inode
        )
        .as_bytes(),
    );
    format!("{:x}", digest.finalize())
}

fn directory_fingerprints(entries: &[SourceEntry]) -> Vec<(String, String)> {
    let mut files: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut children: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut directories = HashSet::from([String::new()]);
    for entry in entries {
        if entry.relative_path.starts_with('/') {
            // Python treats external editable sources as distinct root leaves.
            files
                .entry(String::new())
                .or_default()
                .insert(entry.relative_path.clone(), entry.fingerprint.clone());
            continue;
        }
        let (directory, name) = entry
            .relative_path
            .rsplit_once('/')
            .unwrap_or(("", &entry.relative_path));
        files
            .entry(directory.into())
            .or_default()
            .insert(name.into(), entry.fingerprint.clone());
        let mut current = directory;
        while directories.insert(current.into()) {
            let (parent, child) = current.rsplit_once('/').unwrap_or(("", current));
            children
                .entry(parent.into())
                .or_default()
                .insert(child.into());
            current = parent;
        }
    }
    let mut ordered: Vec<String> = directories.into_iter().collect();
    ordered.sort_by_key(|name| {
        std::cmp::Reverse(
            name.bytes().filter(|&byte| byte == b'/').count() + usize::from(!name.is_empty()),
        )
    });
    let mut fingerprints: BTreeMap<String, String> = BTreeMap::new();
    for directory in ordered {
        let mut digest = Sha256::new();
        if let Some(entries) = files.get(&directory) {
            for (name, fingerprint) in entries {
                digest.update(format!("F\0{name}\0{fingerprint}\0").as_bytes());
            }
        }
        if let Some(names) = children.get(&directory) {
            for name in names {
                let child = if directory.is_empty() {
                    name.clone()
                } else {
                    format!("{directory}/{name}")
                };
                let fingerprint = &fingerprints[&child];
                digest.update(format!("D\0{name}\0{fingerprint}\0").as_bytes());
            }
        }
        fingerprints.insert(directory, format!("{:x}", digest.finalize()));
    }
    fingerprints.into_iter().collect()
}

/// Build a complete readable source inventory using Python's v2 identity
/// encoding. Errors reject the entire result instead of returning partial
/// evidence. Unsupported platforms must use an authoritative Python check;
/// the legacy native snapshot is never a substitute for a v2 result.
pub fn snapshot_python_sources(root: &Path, extra_roots: &[&Path]) -> io::Result<SourceSnapshot> {
    if !cfg!(unix) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Python source identity v2 is not supported on this platform",
        ));
    }
    let root = source_path(root)?;
    let mut files = source_files(&root)?;
    let mut roots = HashSet::from([root.text.clone()]);
    for extra in extra_roots {
        let extra = source_path(extra)?;
        if roots.insert(extra.text.clone()) {
            files.extend(source_files(&extra)?);
        }
    }
    files.sort_by(|a, b| a.parts.cmp(&b.parts));
    files.dedup_by(|a, b| a.text == b.text);
    let entries: io::Result<Vec<SourceEntry>> = files
        .par_iter()
        .map(|file| {
            let metadata = fs::metadata(&file.text)?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Source file changed type during snapshot",
                ));
            }
            let identity = source_identity(&metadata)?;
            let relative_path = if file.parts.starts_with(&root.parts) {
                file.parts[root.parts.len()..].join("/")
            } else {
                file.text.clone()
            };
            let fingerprint = file_fingerprint(&relative_path, &identity);
            Ok(SourceEntry {
                relative_path,
                identity,
                fingerprint,
            })
        })
        .collect();
    let entries = entries?;
    let directory_fingerprints = directory_fingerprints(&entries);
    let fingerprint = directory_fingerprints
        .iter()
        .find(|(name, _)| name.is_empty())
        .expect("The root directory is always included")
        .1
        .clone();
    Ok(SourceSnapshot {
        root: root.text,
        fingerprint,
        entries,
        directory_fingerprints,
    })
}

/// Python's separate canonical-membership witness. Stat identity alone cannot
/// distinguish a file link retargeted between two names of the same inode.
/// This never changes the v2 source fingerprint or follows directory links.
pub fn membership_fingerprint(snapshot: &SourceSnapshot) -> io::Result<String> {
    let root = fs::canonicalize(&snapshot.root)?;
    if !fs::metadata(&root)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Source root changed type",
        ));
    }
    let text = |path: &Path| {
        path.to_str().map(str::to_owned).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Canonical source path is not valid UTF-8",
            )
        })
    };
    let mut digest = Sha256::new();
    digest.update(b"django-orm-source-membership-v1\0");
    digest.update(format!("R\0{}\0", text(&root)?).as_bytes());
    let mut entries: Vec<_> = snapshot.entries.iter().collect();
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let mut parents = BTreeMap::new();
    for entry in entries {
        let path = Path::new(&snapshot.root).join(&entry.relative_path);
        let metadata = fs::symlink_metadata(&path)?;
        let canonical = if metadata.file_type().is_symlink() {
            let canonical = fs::canonicalize(&path)?;
            if !fs::metadata(&canonical)?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Source link changed type",
                ));
            }
            canonical
        } else if metadata.is_file() {
            let parent = path.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Source path has no parent")
            })?;
            if !parents.contains_key(parent) {
                parents.insert(parent.to_path_buf(), fs::canonicalize(parent)?);
            }
            parents[parent].join(path.file_name().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Source path has no filename")
            })?)
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Source changed type",
            ));
        };
        digest.update(format!("F\0{}\0{}\0", entry.relative_path, text(&canonical)?).as_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn canonical_membership_distinguishes_hardlink_retargets_and_rejects_missing_files() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        fs::create_dir(&root).unwrap();
        let old = directory.path().join("old.py");
        let new = directory.path().join("new.py");
        fs::write(&old, "model = 1").unwrap();
        fs::hard_link(&old, &new).unwrap();
        let file = root.join("model.py");
        symlink(&old, &file).unwrap();
        let before = snapshot_python_sources(&root, &[]).unwrap();
        let before_membership = membership_fingerprint(&before).unwrap();
        fs::remove_file(&file).unwrap();
        symlink(&new, &file).unwrap();
        let after = snapshot_python_sources(&root, &[]).unwrap();
        assert_eq!(before.fingerprint, after.fingerprint);
        assert_ne!(before_membership, membership_fingerprint(&after).unwrap());
        fs::remove_file(&file).unwrap();
        assert!(membership_fingerprint(&after).is_err());
    }

    #[test]
    fn fingerprint_matches_independent_python_v2_vectors_without_rounding() {
        for (path, identity, expected) in [
            (
                "app/models.py",
                SourceIdentity {
                    size: 42,
                    mtime_ns: 1234567890,
                    ctime_ns: 9876543210,
                    device: 7,
                    inode: 99,
                },
                "a56b1c782cf6c8dab258be9c099c2f7deb14e3abdc46da663ab646adfef06a25",
            ),
            (
                "외부/모델.py",
                SourceIdentity {
                    size: u64::MAX,
                    mtime_ns: -1234567890,
                    ctime_ns: -9876543210,
                    device: u64::MAX,
                    inode: u64::MAX,
                },
                "3a9ae380d003ba4cfd6be4f1126e4abdc348af8c4842076783061270c8219fbb",
            ),
        ] {
            assert_eq!(file_fingerprint(path, &identity), expected);
        }
    }

    #[test]
    fn lexical_paths_preserve_python_posix_anchors_and_parent_parts() {
        for (input, expected) in [
            ("", "."),
            ("./app//../models/", "app/../models"),
            ("//app/./models", "//app/models"),
            ("///app/models", "/app/models"),
        ] {
            assert_eq!(source_path(Path::new(input)).unwrap().text, expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_files_are_included_and_directory_links_are_not_followed() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app/model.py"), "model = 1").unwrap();
        fs::write(root.join(".py"), "hidden = 1").unwrap();
        symlink(root.join("app/model.py"), root.join("linked.py")).unwrap();
        symlink(root.join("app"), root.join("linked-directory")).unwrap();
        let snapshot = snapshot_python_sources(&root, &[]).unwrap();
        let paths: Vec<&str> = snapshot
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect();
        assert_eq!(paths, vec![".py", "app/model.py", "linked.py"]);
    }

    #[cfg(unix)]
    #[test]
    fn missing_sources_cannot_return_partial_evidence() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("valid.py"), "valid = 1").unwrap();
        symlink(
            directory.path().join("missing"),
            directory.path().join("broken.py"),
        )
        .unwrap();
        assert!(snapshot_python_sources(directory.path(), &[]).is_err());
        assert!(snapshot_python_sources(&directory.path().join("absent"), &[]).is_err());
    }
}
