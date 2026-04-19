//! Compare the Rust static-index build against Python's
//! `build_static_index`. Generates projects shaped like
//! `python/benchmarks/bench_reindex.py` and measures end-to-end.

use std::fs;
use std::time::Instant;

use django_orm_core::static_index::build_static_index;

const MODEL_TEMPLATE: &str = "from django.db import models\n\n\nclass {class_name}(models.Model):\n{fields}\n    class Meta:\n        app_label = '{app_label}'\n";

const FIELD_TEMPLATES: &[&str] = &[
    "    {name} = models.CharField(max_length=255)",
    "    {name} = models.IntegerField(default=0)",
    "    {name} = models.BooleanField(default=False)",
    "    {name} = models.DateTimeField(auto_now_add=True)",
    "    {name} = models.FloatField(default=0.0)",
    "    {name} = models.DecimalField(max_digits=10, decimal_places=2)",
    "    {name} = models.UUIDField()",
    "    {name} = models.DateField(auto_now=True)",
];

fn fill_fields(lines: &mut Vec<String>, class_name: &str, model_count: usize, i: usize) {
    for f in 0..15 {
        let tmpl = FIELD_TEMPLATES[f % FIELD_TEMPLATES.len()];
        lines.push(tmpl.replace("{name}", &format!("field_{f}")));
    }
    for r in 0..2 {
        let target_idx = (i + r + 1) % model_count;
        let target_app = format!("app{}", target_idx / 50);
        let target_class = format!("Model{target_idx}");
        lines.push(format!(
            "    fk_{r} = models.ForeignKey('{target_app}.{target_class}', on_delete=models.CASCADE, related_name='reverse_fk_{r}_from_{}')",
            class_name.to_ascii_lowercase()
        ));
    }
}

fn make_project(root: &std::path::Path, model_count: usize) -> Vec<std::path::PathBuf> {
    let mut out = Vec::with_capacity(model_count);
    let models_per_app = 50;
    for i in 0..model_count {
        let app_idx = i / models_per_app;
        let app_dir = root.join(format!("app{app_idx}"));
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("__init__.py"), "").unwrap();

        let class_name = format!("Model{i}");
        let mut lines: Vec<String> = Vec::new();
        fill_fields(&mut lines, &class_name, model_count, i);
        let body = lines.join("\n");
        let content = MODEL_TEMPLATE
            .replace("{class_name}", &class_name)
            .replace("{fields}", &body)
            .replace("{app_label}", &format!("app{app_idx}"));

        let p = app_dir.join(format!("model_{i}.py"));
        fs::write(&p, content).unwrap();
        out.push(p);
    }
    out
}

fn p50_p95(mut v: Vec<u128>) -> (f64, f64) {
    v.sort_unstable();
    let p = |q: f64| v[((v.len() as f64 - 1.0) * q) as usize] as f64 / 1_000_000.0;
    (p(0.50), p(0.95))
}

fn run(scale: usize, runs: usize) {
    let dir = tempfile::tempdir().unwrap();
    let files = make_project(dir.path(), scale);

    // warm-up
    let _ = build_static_index(dir.path(), &files);

    let mut ns = Vec::with_capacity(runs);
    let mut models = 0usize;
    let mut pending = 0usize;
    for _ in 0..runs {
        let t = Instant::now();
        let idx = build_static_index(dir.path(), &files);
        ns.push(t.elapsed().as_nanos());
        models = idx.model_candidates.len();
        pending = idx.modules.iter().map(|m| m.pending_fields.len()).sum();
    }
    let (p50, p95) = p50_p95(ns);
    println!(
        "scale={scale:>6} files={files:>5} models={models:>5} fields={pending:>6}  \
         build p50={p50:>7.2}ms p95={p95:>7.2}ms",
        files = files.len()
    );
}

fn main() {
    let runs = 10;
    println!("--- rust build_static_index bench (runs={runs}) ---");
    for scale in [100, 500, 1500, 5000] {
        run(scale, runs);
    }
    // Heavier scales, fewer runs to keep total time reasonable.
    for scale in [15000usize] {
        run(scale, 5);
    }
}
