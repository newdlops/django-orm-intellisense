//! Discovery throughput benchmark. Generates synthetic project trees
//! matching `python/benchmarks/bench_reindex.py`'s shape and measures
//! end-to-end snapshot time.

use std::fs;
use std::time::Instant;

use django_orm_core::discovery::snapshot_python_sources;

const MODEL_FILE: &str = "from django.db import models\n\nclass Model0(models.Model):\n    a = models.CharField(max_length=255)\n    b = models.IntegerField(default=0)\n";

fn make_project(root: &std::path::Path, model_count: usize) {
    let models_per_app = 50;
    for i in 0..model_count {
        let app_idx = i / models_per_app;
        let app_dir = root.join(format!("app{app_idx}"));
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("__init__.py"), "").unwrap();
        fs::write(app_dir.join(format!("model_{i}.py")), MODEL_FILE).unwrap();
    }
}

fn p50_p95(mut v: Vec<u128>) -> (f64, f64) {
    v.sort_unstable();
    let p = |q: f64| v[((v.len() as f64 - 1.0) * q) as usize] as f64 / 1_000_000.0;
    (p(0.50), p(0.95))
}

fn run(scale: usize, runs: usize) {
    let dir = tempfile::tempdir().unwrap();
    make_project(dir.path(), scale);

    let mut ns = Vec::with_capacity(runs);
    let mut file_count = 0usize;
    for _ in 0..runs {
        let t = Instant::now();
        let snap = snapshot_python_sources(dir.path(), &[]);
        ns.push(t.elapsed().as_nanos());
        file_count = snap.entries.len();
    }
    let (p50, p95) = p50_p95(ns);
    println!("scale={scale:>6} files={file_count:>6}  snapshot p50={p50:>7.2}ms p95={p95:>7.2}ms");
}

fn main() {
    let runs = 20;
    println!("--- rust snapshot_python_sources bench (runs={runs}) ---");
    for scale in [100, 500, 1500, 5000, 15000] {
        run(scale, runs);
    }
}
