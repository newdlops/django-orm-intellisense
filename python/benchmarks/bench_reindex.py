"""
Django ORM Intellisense — Python Daemon Benchmark

Measures static indexing and incremental reindex performance using
synthetic Django model files.

Usage:
    python -m benchmarks.bench_reindex [--models N] [--json]

Run from the python/ directory:
    cd python && python -m benchmarks.bench_reindex
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Ensure the package is importable when running from python/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import (
    build_static_index,
    reindex_single_file,
)

# ---------------------------------------------------------------------------
# Synthetic project generation
# ---------------------------------------------------------------------------

MODEL_TEMPLATE = """\
from django.db import models


class {class_name}(models.Model):
{fields}
    class Meta:
        app_label = '{app_label}'
"""

FIELD_TEMPLATES = [
    "    {name} = models.CharField(max_length=255)",
    "    {name} = models.IntegerField(default=0)",
    "    {name} = models.BooleanField(default=False)",
    "    {name} = models.DateTimeField(auto_now_add=True)",
    "    {name} = models.FloatField(default=0.0)",
    "    {name} = models.DecimalField(max_digits=10, decimal_places=2)",
    "    {name} = models.UUIDField()",
    "    {name} = models.DateField(auto_now=True)",
]


def generate_synthetic_project(root: Path, model_count: int) -> list[Path]:
    """Generate a synthetic Django project with N models across multiple apps."""
    files: list[Path] = []
    models_per_app = 50

    for i in range(model_count):
        app_idx = i // models_per_app
        app_name = f"app{app_idx}"
        app_dir = root / app_name
        app_dir.mkdir(parents=True, exist_ok=True)

        # Ensure __init__.py exists
        init_file = app_dir / "__init__.py"
        if not init_file.exists():
            init_file.write_text("")

        class_name = f"Model{i}"
        fields_lines: list[str] = []

        # 15 scalar fields
        for f in range(15):
            tmpl = FIELD_TEMPLATES[f % len(FIELD_TEMPLATES)]
            fields_lines.append(tmpl.format(name=f"field_{f}"))

        # 2 FK relations
        for r in range(2):
            target_idx = (i + r + 1) % model_count
            target_app = f"app{target_idx // models_per_app}"
            target_class = f"Model{target_idx}"
            fields_lines.append(
                f"    fk_{r} = models.ForeignKey("
                f"'{target_app}.{target_class}', "
                f"on_delete=models.CASCADE, "
                f"related_name='reverse_fk_{r}_from_{class_name.lower()}')"
            )

        model_file = app_dir / f"model_{i}.py"
        model_file.write_text(
            MODEL_TEMPLATE.format(
                class_name=class_name,
                fields="\n".join(fields_lines),
                app_label=app_name,
            )
        )
        files.append(model_file)

    return files


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


def format_ms(seconds: float) -> str:
    ms = seconds * 1000
    return f"{ms:.1f}ms" if ms >= 1 else f"{ms * 1000:.0f}µs"


def run_benchmark(model_count: int, json_mode: bool = False) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="django_bench_")
    root = Path(tmpdir)
    results: dict = {"model_count": model_count}

    try:
        # --- 1. Generate synthetic project ---
        t0 = time.perf_counter()
        files = generate_synthetic_project(root, model_count)
        gen_time = time.perf_counter() - t0
        results["generate_project_s"] = gen_time
        if not json_mode:
            print(f"Generate project ({model_count} models, {len(files)} files): {format_ms(gen_time)}")

        # --- 2. snapshot_python_sources ---
        t1 = time.perf_counter()
        snapshot = snapshot_python_sources(root)
        snapshot_time = time.perf_counter() - t1
        results["snapshot_python_sources_s"] = snapshot_time
        results["snapshot_file_count"] = snapshot.file_count
        if not json_mode:
            print(f"snapshot_python_sources: {format_ms(snapshot_time)} ({snapshot.file_count} files)")

        # --- 3. build_static_index (full) ---
        t2 = time.perf_counter()
        static_index = build_static_index(root, list(snapshot.files))
        build_time = time.perf_counter() - t2
        results["build_static_index_s"] = build_time
        results["model_candidate_count"] = len(static_index.model_candidates)
        results["field_count"] = len(static_index.fields)
        if not json_mode:
            print(
                f"build_static_index (full): {format_ms(build_time)} "
                f"({len(static_index.model_candidates)} candidates, "
                f"{len(static_index.fields)} fields)"
            )

        # --- 4. reindex_single_file — fast path (non-model file change) ---
        # Create a non-model file and reindex it
        utils_file = root / "app0" / "utils.py"
        utils_file.write_text("def helper():\n    pass\n")
        t3 = time.perf_counter()
        new_idx, old_labels, new_labels = reindex_single_file(root, utils_file, static_index)
        fast_path_time = time.perf_counter() - t3
        results["reindex_fast_path_s"] = fast_path_time
        results["reindex_fast_path_affected"] = len(old_labels | new_labels)
        if not json_mode:
            print(
                f"reindex_single_file (fast path, non-model): {format_ms(fast_path_time)} "
                f"(affected: {len(old_labels | new_labels)})"
            )

        # --- 5. reindex_single_file — slow path (model field change) ---
        model_file = files[0]
        original_content = model_file.read_text()
        model_file.write_text(
            original_content + "\n    new_field = models.TextField(blank=True)\n"
        )
        t4 = time.perf_counter()
        new_idx2, old_labels2, new_labels2 = reindex_single_file(root, model_file, static_index)
        slow_path_time = time.perf_counter() - t4
        results["reindex_slow_path_s"] = slow_path_time
        results["reindex_slow_path_affected"] = len(old_labels2 | new_labels2)
        if not json_mode:
            print(
                f"reindex_single_file (slow path, model changed): {format_ms(slow_path_time)} "
                f"(affected: {len(old_labels2 | new_labels2)})"
            )

        # Restore original content
        model_file.write_text(original_content)

        # --- 6. reindex_single_file — batch of 10 files ---
        reindex_timings: list[float] = []
        for f in files[:10]:
            content = f.read_text()
            f.write_text(content + "\n    extra = models.IntegerField(null=True)\n")
            t = time.perf_counter()
            reindex_single_file(root, f, static_index)
            reindex_timings.append(time.perf_counter() - t)
            f.write_text(content)  # restore

        reindex_timings.sort()
        results["reindex_batch_p50_s"] = reindex_timings[len(reindex_timings) // 2]
        results["reindex_batch_p95_s"] = reindex_timings[int(len(reindex_timings) * 0.95)]
        results["reindex_batch_total_s"] = sum(reindex_timings)
        if not json_mode:
            print(
                f"reindex_single_file (batch of {len(reindex_timings)}): "
                f"p50={format_ms(results['reindex_batch_p50_s'])} "
                f"p95={format_ms(results['reindex_batch_p95_s'])} "
                f"total={format_ms(results['reindex_batch_total_s'])}"
            )

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return results


# ---------------------------------------------------------------------------
# Budget checks
# ---------------------------------------------------------------------------

BUDGETS = {
    "reindex_fast_path_s": 0.020,   # 20ms
    "reindex_slow_path_s": 0.050,   # 50ms (includes _resolve_fields)
}


def check_budgets(results: dict) -> list[dict]:
    checks = []
    for metric, budget in BUDGETS.items():
        actual = results.get(metric, float("inf"))
        checks.append({
            "metric": metric,
            "actual_ms": actual * 1000,
            "budget_ms": budget * 1000,
            "pass": actual <= budget,
        })
    return checks


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Django ORM Intellisense Python benchmark")
    parser.add_argument("--models", type=int, default=500, help="Number of synthetic models")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if not args.json:
        print(f"\n{'=' * 60}")
        print(f"Python Daemon Benchmark: {args.models} models")
        print(f"{'=' * 60}\n")

    results = run_benchmark(args.models, json_mode=args.json)
    checks = check_budgets(results)

    if args.json:
        import platform
        output = {
            "timestamp": __import__("datetime").datetime.now().isoformat(),
            "python_version": sys.version,
            "platform": platform.system(),
            "results": results,
            "checks": checks,
            "all_passed": all(c["pass"] for c in checks),
        }
        print(json.dumps(output, indent=2))
    else:
        print(f"\n{'=' * 60}")
        print("  BUDGET CHECK")
        print(f"{'=' * 60}")
        all_passed = True
        for c in checks:
            status = "PASS" if c["pass"] else "FAIL"
            if not c["pass"]:
                all_passed = False
            print(
                f"  {c['metric']:<30s} "
                f"{c['actual_ms']:>8.1f}ms  "
                f"<{c['budget_ms']:.0f}ms  "
                f"{status}"
            )
        print(f"\n  Overall: {'ALL PASSED' if all_passed else 'SOME FAILED'}")
        print(f"{'=' * 60}\n")

    sys.exit(0 if all(c["pass"] for c in checks) else 1)


if __name__ == "__main__":
    main()
