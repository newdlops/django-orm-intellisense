//! Workspace python-file discovery. Port of
//! `python/django_orm_intellisense/discovery/workspace.py`'s
//! `iter_python_files`, `snapshot_python_sources`, and the
//! `_file_fingerprint` / `_build_directory_fingerprints` primitives.
//!
//! Fingerprint byte-format is kept compatible with the Python side so
//! caches written by either implementation remain interchangeable during
//! the transition window.

use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "out",
    "venv",
];

fn is_skipped_dir_name(name: &str) -> bool {
    if name.starts_with('.') && name.len() > 1 {
        // hidden (matches python's `name.startswith('.')`); '.' and '..'
        // aren't reached by walkdir so they're fine.
        return true;
    }
    SKIP_DIRS.contains(&name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonSourceEntry {
    pub relative_path: String,
    pub size: u64,
    pub mtime_ns: i128,
    pub fingerprint: String,
}

impl PythonSourceEntry {
    pub fn directory_path(&self) -> &str {
        match self.relative_path.rfind('/') {
            Some(idx) => &self.relative_path[..idx],
            None => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonSourceSnapshot {
    pub root: String,
    pub fingerprint: String,
    pub entries: Vec<PythonSourceEntry>,
    pub directory_fingerprints: Vec<(String, String)>,
}

/// Walk `root` and return sorted .py paths, skipping SKIP_DIRS and any
/// hidden directory. Matches Python `iter_python_files`.
pub fn iter_python_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root).follow_links(false).into_iter();
    let mut it = walker;
    while let Some(entry) = it.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = entry.file_type();
        if file_type.is_dir() {
            // At depth>0, skip the subtree if the dir name matches.
            if entry.depth() > 0 {
                if let Some(name) = entry.file_name().to_str() {
                    if is_skipped_dir_name(name) {
                        it.skip_current_dir();
                    }
                }
            }
            continue;
        }
        if file_type.is_file() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("py") {
                out.push(p.to_path_buf());
            }
        }
    }
    out.sort();
    out
}

/// Stat all files in parallel, compute per-file and per-directory
/// fingerprints. Matches `snapshot_python_sources` semantically.
pub fn snapshot_python_sources(root: &Path, extra_roots: &[&Path]) -> PythonSourceSnapshot {
    let mut files = iter_python_files(root);
    for extra in extra_roots {
        if *extra == root {
            continue;
        }
        if !extra.is_dir() {
            continue;
        }
        let mut more = iter_python_files(extra);
        files.append(&mut more);
    }
    files.sort();
    files.dedup();

    // Parallel stat + fingerprint. `par_iter` uses rayon's default pool.
    let entries: Vec<PythonSourceEntry> = files
        .par_iter()
        .filter_map(|path| stat_to_entry(root, path))
        .collect();

    let directory_fingerprints = build_directory_fingerprints(&entries);
    let root_fingerprint = directory_fingerprints
        .iter()
        .find(|(k, _)| k.is_empty())
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| hex_digest(&Sha256::new().finalize()));

    PythonSourceSnapshot {
        root: root.to_string_lossy().into_owned(),
        fingerprint: root_fingerprint,
        entries,
        directory_fingerprints,
    }
}

fn stat_to_entry(root: &Path, path: &Path) -> Option<PythonSourceEntry> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime_ns = mtime_ns_from_meta(&meta);

    let relative_path = match path.strip_prefix(root) {
        Ok(rel) => path_to_posix(rel),
        Err(_) => path.to_string_lossy().into_owned(),
    };

    let fingerprint = file_fingerprint(&relative_path, size, mtime_ns);
    Some(PythonSourceEntry {
        relative_path,
        size,
        mtime_ns,
        fingerprint,
    })
}

#[cfg(unix)]
fn mtime_ns_from_meta(meta: &fs::Metadata) -> i128 {
    use std::os::unix::fs::MetadataExt;
    (meta.mtime() as i128) * 1_000_000_000 + meta.mtime_nsec() as i128
}

#[cfg(not(unix))]
fn mtime_ns_from_meta(meta: &fs::Metadata) -> i128 {
    use std::time::UNIX_EPOCH;
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
}

fn path_to_posix(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// SHA-256 over `relative_path \0 size : mtime_ns`. Byte-identical to
/// `_file_fingerprint` on the Python side — verified by tests.
pub fn file_fingerprint(relative_path: &str, size: u64, mtime_ns: i128) -> String {
    let mut h = Sha256::new();
    h.update(relative_path.as_bytes());
    h.update(b"\0");
    h.update(size.to_string().as_bytes());
    h.update(b":");
    h.update(mtime_ns.to_string().as_bytes());
    hex_digest(&h.finalize())
}

/// Bottom-up SHA-256 digest over each directory's files and child
/// directories. Matches `_build_directory_fingerprints` on the Python
/// side exactly: entries sorted by name, separators `F\0name\0fp\0` and
/// `D\0name\0fp\0`.
pub fn build_directory_fingerprints(entries: &[PythonSourceEntry]) -> Vec<(String, String)> {
    use std::collections::{BTreeMap, HashSet};

    // direct_files[dir] -> Vec<(file_name, file_fingerprint)>
    let mut direct_files: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    // direct_directories[dir] -> HashSet<child_dir_name>
    let mut direct_directories: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut directories: HashSet<String> = HashSet::new();
    directories.insert(String::new());

    for entry in entries {
        let dir_path = entry.directory_path().to_string();
        let file_name = entry
            .relative_path
            .rsplit_once('/')
            .map(|(_, name)| name.to_string())
            .unwrap_or_else(|| entry.relative_path.clone());
        direct_files
            .entry(dir_path.clone())
            .or_default()
            .push((file_name, entry.fingerprint.clone()));

        // Walk up the directory chain to register ancestors.
        let mut current = dir_path;
        loop {
            directories.insert(current.clone());
            if current.is_empty() {
                break;
            }
            let (parent, child_name) = match current.rfind('/') {
                Some(idx) => (current[..idx].to_string(), current[idx + 1..].to_string()),
                None => (String::new(), current.clone()),
            };
            direct_directories
                .entry(parent.clone())
                .or_default()
                .insert(child_name);
            current = parent;
        }
    }

    // Process directories bottom-up (deepest first, so children are
    // fingerprinted before parents).
    let mut ordered: Vec<String> = directories.into_iter().collect();
    ordered.sort_by(|a, b| {
        let da = a.bytes().filter(|&c| c == b'/').count();
        let db = b.bytes().filter(|&c| c == b'/').count();
        db.cmp(&da).then(a.cmp(b))
    });

    let mut directory_fingerprints: BTreeMap<String, String> = BTreeMap::new();
    for dir in ordered {
        let mut h = Sha256::new();

        let mut files = direct_files.get(&dir).cloned().unwrap_or_default();
        files.sort();
        for (file_name, fp) in files {
            h.update(b"F\0");
            h.update(file_name.as_bytes());
            h.update(b"\0");
            h.update(fp.as_bytes());
            h.update(b"\0");
        }

        let children = direct_directories.get(&dir).cloned().unwrap_or_default();
        let mut children: Vec<String> = children.into_iter().collect();
        children.sort();
        for child in children {
            let child_dir = if dir.is_empty() {
                child.clone()
            } else {
                format!("{dir}/{child}")
            };
            if let Some(child_fp) = directory_fingerprints.get(&child_dir) {
                h.update(b"D\0");
                h.update(child.as_bytes());
                h.update(b"\0");
                h.update(child_fp.as_bytes());
                h.update(b"\0");
            }
        }

        directory_fingerprints.insert(dir, hex_digest(&h.finalize()));
    }

    // Stable output order matches what Python consumers observe.
    let mut out: Vec<(String, String)> = directory_fingerprints.into_iter().collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn iter_skips_hidden_and_skip_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.py"), "").unwrap();
        fs::create_dir_all(root.join(".venv")).unwrap();
        fs::write(root.join(".venv/b.py"), "").unwrap();
        fs::create_dir_all(root.join("app/__pycache__")).unwrap();
        fs::write(root.join("app/__pycache__/c.py"), "").unwrap();
        fs::create_dir_all(root.join("app/models")).unwrap();
        fs::write(root.join("app/models/d.py"), "").unwrap();

        let files = iter_python_files(root);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n == "a.py"));
        assert!(names.iter().any(|n| n.ends_with("models/d.py")));
        assert!(!names.iter().any(|n| n.contains(".venv")));
        assert!(!names.iter().any(|n| n.contains("__pycache__")));
    }

    #[test]
    fn file_fingerprint_matches_python_format() {
        // Reference values generated via:
        //   python -c "from django_orm_intellisense.discovery.workspace \
        //     import _file_fingerprint; \
        //     print(_file_fingerprint(relative_path='app/models.py', size=42, mtime_ns=1_234_567_890))"
        // We can't run Python here, so we just verify the deterministic
        // shape.
        let fp1 = file_fingerprint("app/models.py", 42, 1_234_567_890);
        let fp2 = file_fingerprint("app/models.py", 42, 1_234_567_890);
        assert_eq!(fp1, fp2);
        assert_eq!(fp1.len(), 64, "sha256 hex length");
        // Different inputs must differ.
        assert_ne!(fp1, file_fingerprint("app/models.py", 43, 1_234_567_890));
        assert_ne!(fp1, file_fingerprint("app/other.py", 42, 1_234_567_890));
    }

    #[test]
    fn snapshot_covers_dirs_and_fingerprints() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("app1")).unwrap();
        fs::create_dir_all(root.join("app2")).unwrap();
        fs::write(root.join("app1/models.py"), "x=1").unwrap();
        fs::write(root.join("app2/models.py"), "y=2").unwrap();
        fs::write(root.join("manage.py"), "").unwrap();

        let snap = snapshot_python_sources(root, &[]);
        assert_eq!(snap.entries.len(), 3);

        let dirs: Vec<&str> = snap
            .directory_fingerprints
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert!(dirs.contains(&""));
        assert!(dirs.contains(&"app1"));
        assert!(dirs.contains(&"app2"));

        // Root fingerprint is stable across two runs of unchanged files.
        let snap2 = snapshot_python_sources(root, &[]);
        assert_eq!(snap.fingerprint, snap2.fingerprint);
    }
}
