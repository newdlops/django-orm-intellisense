//! Bincode cache save/load throughput vs. the Python JSON baseline
//! (bench/baseline-python.json).
//!
//! No criterion dep — this is a plain-text microbench so CI can pick up
//! the numbers with zero extra deps.

use std::time::Instant;

use django_orm_core::cache::{load, save, CacheLoad};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, PartialEq, Eq, Clone)]
struct Meta {
    schema: u32,
    workspace_root: String,
    fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Field {
    name: String,
    kind: String,
    nullable: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Model {
    app_label: String,
    object_name: String,
    module: String,
    file_path: String,
    fields: Vec<Field>,
    bases: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Payload {
    models: Vec<Model>,
}

fn make_payload(n: usize) -> Payload {
    let fields: Vec<Field> = (0..20)
        .map(|f| Field {
            name: format!("field_{f}"),
            kind: "CharField".into(),
            nullable: false,
        })
        .collect();
    Payload {
        models: (0..n)
            .map(|i| Model {
                app_label: format!("app{}", i / 50),
                object_name: format!("Model{i}"),
                module: format!("app{}.models", i / 50),
                file_path: format!("/ws/app{}/model_{i}.py", i / 50),
                fields: fields.clone(),
                bases: vec!["models.Model".into()],
            })
            .collect(),
    }
}

fn run(scale: usize, runs: usize) {
    let dir = tempfile::tempdir().expect("tmpdir");
    let path = dir.path().join("bench.bin");
    let meta = Meta {
        schema: 14,
        workspace_root: "/ws".into(),
        fingerprint: "abc".into(),
    };
    let payload = make_payload(scale);

    // warm-up
    save(&path, &meta, &payload).unwrap();

    let mut save_ns = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        save(&path, &meta, &payload).unwrap();
        save_ns.push(t.elapsed().as_nanos());
    }

    let mut load_ns = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        let result: CacheLoad<Meta, Payload> = load(&path, |m| m == &meta).unwrap();
        match result {
            CacheLoad::Hit { .. } => {}
            CacheLoad::Miss => panic!("unexpected miss"),
        }
        load_ns.push(t.elapsed().as_nanos());
    }

    let file_bytes = std::fs::metadata(&path).unwrap().len();

    fn p50_p95(mut v: Vec<u128>) -> (f64, f64) {
        v.sort_unstable();
        let p = |q: f64| v[((v.len() as f64 - 1.0) * q) as usize] as f64 / 1_000_000.0;
        (p(0.50), p(0.95))
    }

    let (save_p50, save_p95) = p50_p95(save_ns);
    let (load_p50, load_p95) = p50_p95(load_ns);

    println!(
        "scale={scale:>6} size={file_bytes:>10}B  save p50={save_p50:>6.2}ms p95={save_p95:>6.2}ms  load p50={load_p50:>6.2}ms p95={load_p95:>6.2}ms"
    );
}

fn main() {
    let runs = 50;
    println!("--- bincode cache bench (runs={runs}) ---");
    for scale in [100, 500, 1500, 5000, 15000] {
        run(scale, runs);
    }
}
