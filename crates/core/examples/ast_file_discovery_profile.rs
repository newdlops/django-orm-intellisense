//! Isolate the file-list preparation used by NAPI AST builds. The snapshot
//! variant computes metadata that those builds discard. Same-process ABBA
//! pairs compare path equality; this is not a whole AST/editor startup SLO.

use std::hint::black_box;
use std::path::PathBuf;
use std::time::Instant;

use django_orm_core::discovery::{iter_python_files, snapshot_python_sources};
use serde_json::json;

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("workspace root"));
    let expected = iter_python_files(&root);
    assert_eq!(expected.len(), 5000);
    let mut rows = Vec::new();
    for cycle in 0..42 {
        for mode in ["snapshot", "paths", "paths", "snapshot"] {
            let start = Instant::now();
            let files = if mode == "snapshot" {
                let snapshot = snapshot_python_sources(&root, &[]);
                snapshot.entries.iter().map(|entry| root.join(&entry.relative_path)).collect()
            } else {
                iter_python_files(&root)
            };
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(files, expected);
            black_box(&files);
            rows.push(json!({"cycle": cycle, "warmup": cycle < 2, "mode": mode,
                "wallMs": elapsed_ms, "files": files.len()}));
        }
    }
    println!("{}", json!({"root": root, "files": expected.len(), "order": "ABBA",
        "cycles": 42, "measuredCycles": 40, "rows": rows,
        "scope": "Component-only source enumeration on one fixed warm5000-file fixture. Two warmup and40 measured same-process ABBA cycles. Snapshot mode includes metadata/fingerprint preparation, extraction and disposal; paths mode only enumerates. Every result must match exactly in membership/order. Uncontrolled host, no parsing or whole-call/editor/RPC/memory SLO claim."}));
}
