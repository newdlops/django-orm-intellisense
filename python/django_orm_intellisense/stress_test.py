#!/usr/bin/env python3
"""
Django ORM Intellisense — IPC Stress Test (100K models)

Generates a temporary Django project with 100K models across 100 apps,
boots the daemon against it, then fires concurrent IPC requests to
measure throughput and latency under realistic load.

Usage:
    python -m django_orm_intellisense.stress_test [--models N] [--services N] [--workers N]

Defaults: 100_000 models, 100_000 services, 8 workers
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from statistics import mean, quantiles

# ---------------------------------------------------------------------------
# Project generator
# ---------------------------------------------------------------------------

FIELD_TEMPLATES = [
    "models.CharField(max_length=255)",
    "models.IntegerField(default=0)",
    "models.BooleanField(default=False)",
    "models.DateTimeField(auto_now_add=True)",
    "models.TextField(blank=True)",
    "models.FloatField(default=0.0)",
    "models.DecimalField(max_digits=10, decimal_places=2, default=0)",
    "models.UUIDField(null=True, blank=True)",
    "models.DateField(null=True, blank=True)",
    "models.JSONField(default=dict)",
    "models.EmailField(blank=True)",
    "models.SlugField(max_length=200, blank=True)",
]

def generate_project(
    root: Path,
    model_count: int = 100_000,
    service_count: int = 100_000,
    app_count: int = 100,
    seed: int = 42,
) -> Path:
    """Generate a Django project with *model_count* models."""
    rng = random.Random(seed)
    project_dir = root / "stress_project"
    project_dir.mkdir(parents=True, exist_ok=True)

    # manage.py
    (project_dir / "manage.py").write_text(textwrap.dedent("""\
        #!/usr/bin/env python
        import os, sys
        os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
        from django.core.management import execute_from_command_line
        execute_from_command_line(sys.argv)
    """))

    # config/settings.py
    config = project_dir / "config"
    config.mkdir(exist_ok=True)
    (config / "__init__.py").write_text("")
    installed_apps = [f"app{i}" for i in range(app_count)]
    (config / "settings.py").write_text(textwrap.dedent(f"""\
        SECRET_KEY = 'stress-test-key'
        INSTALLED_APPS = {installed_apps!r}
        DATABASES = {{'default': {{'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}}}
        DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
    """))

    # Generate apps and models
    all_labels: list[str] = []
    models_per_app: dict[int, list[tuple[str, str]]] = {i: [] for i in range(app_count)}

    for m in range(model_count):
        app_idx = m % app_count
        model_name = f"Model{m}"
        label = f"app{app_idx}.{model_name}"
        all_labels.append(label)
        models_per_app[app_idx].append((model_name, label))

    for app_idx in range(app_count):
        app_dir = project_dir / f"app{app_idx}"
        app_dir.mkdir(exist_ok=True)
        (app_dir / "__init__.py").write_text("")

        lines = ["from django.db import models\n\n"]
        for model_name, label in models_per_app[app_idx]:
            field_count = rng.randint(5, 30)
            fields: list[str] = []
            for f_idx in range(field_count):
                fields.append(f"    field_{f_idx} = {rng.choice(FIELD_TEMPLATES)}")

            # FK relations: 1~3
            fk_count = rng.randint(1, 3)
            for fk_idx in range(fk_count):
                target = rng.choice(all_labels) if all_labels else label
                target_app, target_model = target.split(".")
                fields.append(
                    f"    fk_{fk_idx} = models.ForeignKey("
                    f"'{target_app}.{target_model}', "
                    f"on_delete=models.CASCADE, null=True, related_name='+')"
                )

            lines.append(f"class {model_name}(models.Model):\n")
            lines.append("\n".join(fields))
            lines.append("\n    class Meta:\n        app_label = " + repr(f"app{app_idx}") + "\n\n")

        (app_dir / "models.py").write_text("".join(lines))

    # Generate service files
    svc_dir = project_dir / "services"
    svc_dir.mkdir(exist_ok=True)
    (svc_dir / "__init__.py").write_text("")

    for s in range(min(service_count, model_count)):
        app_idx = s % app_count
        model_name = f"Model{s}"
        svc_file = svc_dir / f"service_{s}.py"
        target_fk = rng.choice(all_labels) if all_labels else f"app0.Model0"
        target_app, target_model = target_fk.split(".")
        svc_file.write_text(textwrap.dedent(f"""\
            from app{app_idx}.models import {model_name}

            def get_{model_name.lower()}():
                return {model_name}.objects.filter(
                    field_0__icontains='test',
                    fk_0__{target_model.lower()}__field_1__gte=10,
                ).order_by('-field_2').first()

            def list_{model_name.lower()}(ids):
                return {model_name}.objects.filter(pk__in=ids).values(
                    'field_0', 'field_1', 'fk_0_id'
                )
        """))

    print(
        f"[gen] {model_count} models in {app_count} apps, "
        f"{min(service_count, model_count)} services",
        file=sys.stderr,
    )
    return project_dir


# ---------------------------------------------------------------------------
# IPC client (talks to daemon via stdin/stdout)
# ---------------------------------------------------------------------------

class DaemonClient:
    """Minimal IPC client for the daemon process."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self._seq = 0
        self._lock = threading.Lock()
        self._pending: dict[str, threading.Event] = {}
        self._results: dict[str, dict] = {}
        self._reader_thread = threading.Thread(
            target=self._read_stdout, daemon=True
        )
        self._reader_thread.start()

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            rid = msg.get("id")
            if rid and rid in self._pending:
                self._results[rid] = msg
                self._pending[rid].set()

    def request(
        self,
        method: str,
        params: dict,
        *,
        background: bool = False,
        timeout: float = 30.0,
    ) -> dict:
        with self._lock:
            self._seq += 1
            rid = f"req-{self._seq}"

        event = threading.Event()
        self._pending[rid] = event

        msg: dict = {"id": rid, "method": method, "params": params}
        if background:
            msg["background"] = True

        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

        if not event.wait(timeout=timeout):
            self._pending.pop(rid, None)
            raise TimeoutError(f"{method}#{rid} timed out after {timeout}s")

        self._pending.pop(rid, None)
        result = self._results.pop(rid)
        if "error" in result:
            raise RuntimeError(f"{method}: {result['error']}")
        return result.get("result", {})


# ---------------------------------------------------------------------------
# Stress test scenarios
# ---------------------------------------------------------------------------

def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values_sorted = sorted(values)
    idx = int(len(values_sorted) * p)
    return values_sorted[min(idx, len(values_sorted) - 1)]


def scenario_concurrent_resolve(
    client: DaemonClient,
    model_labels: list[str],
    count: int,
    workers: int,
) -> dict:
    """Fire *count* resolveLookupPath calls concurrently."""
    rng = random.Random(123)
    tasks = []
    for _ in range(count):
        label = rng.choice(model_labels)
        field = f"field_{rng.randint(0, 10)}"
        tasks.append((label, field, "filter"))

    latencies: list[float] = []
    errors = 0

    def call(label: str, field: str, method: str) -> float:
        t0 = time.perf_counter()
        try:
            client.request(
                "resolveLookupPath",
                {"baseModelLabel": label, "value": field, "method": method},
                background=True,
            )
        except Exception:
            nonlocal errors
            errors += 1
        return time.perf_counter() - t0

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(call, *t) for t in tasks]
        for f in as_completed(futures):
            latencies.append(f.result())
    elapsed = time.perf_counter() - started

    return {
        "name": f"concurrent_resolve({count}x{workers}w)",
        "total_s": round(elapsed, 3),
        "rps": round(count / elapsed, 1),
        "p50_ms": round(percentile(latencies, 0.5) * 1000, 1),
        "p95_ms": round(percentile(latencies, 0.95) * 1000, 1),
        "p99_ms": round(percentile(latencies, 0.99) * 1000, 1),
        "max_ms": round(max(latencies) * 1000, 1),
        "errors": errors,
    }


def scenario_batch_resolve(
    client: DaemonClient,
    model_labels: list[str],
    batch_size: int,
) -> dict:
    """Single batch call with *batch_size* items."""
    rng = random.Random(456)
    items = []
    for _ in range(batch_size):
        label = rng.choice(model_labels)
        items.append({
            "baseModelLabel": label,
            "value": f"field_{rng.randint(0, 10)}",
            "method": "filter",
        })

    t0 = time.perf_counter()
    result = client.request(
        "resolveLookupPathBatch",
        {"items": items},
        background=True,
        timeout=120.0,
    )
    elapsed = time.perf_counter() - t0
    results = result.get("results", [])

    return {
        "name": f"batch_resolve({batch_size})",
        "total_s": round(elapsed, 3),
        "items_per_s": round(batch_size / elapsed, 1),
        "resolved": sum(1 for r in results if r.get("resolved")),
        "total": batch_size,
    }


def scenario_hover_under_load(
    client: DaemonClient,
    model_labels: list[str],
    bg_count: int,
    hover_count: int,
    workers: int,
) -> dict:
    """
    Fire bg_count background requests, then measure hover latency.
    This tests that hover (foreground) is not blocked by background work.
    """
    rng = random.Random(789)
    hover_latencies: list[float] = []
    bg_done = threading.Event()

    def bg_load() -> None:
        """Fire background requests continuously."""
        for _ in range(bg_count):
            if bg_done.is_set():
                break
            label = rng.choice(model_labels)
            try:
                client.request(
                    "resolveLookupPath",
                    {"baseModelLabel": label, "value": f"field_{rng.randint(0, 10)}", "method": "filter"},
                    background=True,
                    timeout=10.0,
                )
            except Exception:
                pass

    # Start background load
    bg_pool = ThreadPoolExecutor(max_workers=workers)
    bg_futures = [bg_pool.submit(bg_load) for _ in range(workers)]

    # Small delay to let background fill up
    time.sleep(0.5)

    # Measure hover latency (foreground, main thread)
    for _ in range(hover_count):
        label = rng.choice(model_labels)
        t0 = time.perf_counter()
        try:
            client.request(
                "resolveOrmMember",
                {
                    "modelLabel": label,
                    "receiverKind": "manager",
                    "name": "filter",
                },
                background=False,  # foreground = hover
                timeout=10.0,
            )
        except Exception:
            pass
        hover_latencies.append(time.perf_counter() - t0)

    bg_done.set()
    bg_pool.shutdown(wait=True)

    return {
        "name": f"hover_under_load(bg={bg_count},hover={hover_count})",
        "hover_p50_ms": round(percentile(hover_latencies, 0.5) * 1000, 1),
        "hover_p95_ms": round(percentile(hover_latencies, 0.95) * 1000, 1),
        "hover_max_ms": round(max(hover_latencies) * 1000, 1) if hover_latencies else 0,
        "hover_count": hover_count,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="IPC stress test")
    parser.add_argument("--models", type=int, default=100_000)
    parser.add_argument("--services", type=int, default=100_000)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--keep", action="store_true", help="Keep generated project")
    args = parser.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="doi_stress_"))
    print(f"[stress] tmp={tmp}", file=sys.stderr)

    try:
        # 1. Generate project
        t0 = time.perf_counter()
        project = generate_project(
            tmp, model_count=args.models, service_count=args.services
        )
        gen_elapsed = time.perf_counter() - t0
        print(f"[stress] generate: {gen_elapsed:.1f}s", file=sys.stderr)

        # 2. Start daemon
        python = sys.executable
        daemon_cmd = [
            python, "-m", "django_orm_intellisense",
            "--stdio", "--workspace", str(project),
        ]
        # Determine the package root so the daemon module is importable
        pkg_root = Path(__file__).resolve().parent.parent
        env = os.environ.copy()
        env["PYTHONPATH"] = str(pkg_root) + os.pathsep + env.get("PYTHONPATH", "")

        proc = subprocess.Popen(
            daemon_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            env=env,
            cwd=str(project),
        )
        client = DaemonClient(proc)

        # 3. Initialize
        print("[stress] initializing daemon...", file=sys.stderr)
        t1 = time.perf_counter()
        init_result = client.request(
            "initialize",
            {
                "workspaceRoot": str(project),
                "settingsModule": "config.settings",
            },
            timeout=300.0,
        )
        init_elapsed = time.perf_counter() - t1
        model_count = init_result.get("modelCount", "?")
        print(
            f"[stress] initialized: {model_count} models in {init_elapsed:.1f}s",
            file=sys.stderr,
        )

        # Collect model labels for scenarios
        # The init result contains surfaceIndex keys
        surface = init_result.get("surfaceIndex", {})
        model_labels = list(surface.keys()) if surface else [f"app0.Model{i}" for i in range(min(1000, args.models))]
        if not model_labels:
            print("[stress] WARNING: no model labels found, using synthetic labels", file=sys.stderr)
            model_labels = [f"app{i % 100}.Model{i}" for i in range(min(1000, args.models))]

        # 4. Run scenarios
        print(f"\n{'=' * 70}", file=sys.stderr)
        print("  STRESS TEST RESULTS", file=sys.stderr)
        print(f"{'=' * 70}", file=sys.stderr)

        results = []

        # Scenario 1: Concurrent individual resolves
        r = scenario_concurrent_resolve(
            client, model_labels, count=1000, workers=args.workers
        )
        results.append(r)
        print(f"\n  {r['name']}", file=sys.stderr)
        for k, v in r.items():
            if k != "name":
                print(f"    {k}: {v}", file=sys.stderr)

        # Scenario 2: Batch resolve
        r = scenario_batch_resolve(client, model_labels, batch_size=500)
        results.append(r)
        print(f"\n  {r['name']}", file=sys.stderr)
        for k, v in r.items():
            if k != "name":
                print(f"    {k}: {v}", file=sys.stderr)

        # Scenario 3: Hover under background load
        r = scenario_hover_under_load(
            client, model_labels,
            bg_count=500, hover_count=50, workers=args.workers
        )
        results.append(r)
        print(f"\n  {r['name']}", file=sys.stderr)
        for k, v in r.items():
            if k != "name":
                print(f"    {k}: {v}", file=sys.stderr)

        print(f"\n{'=' * 70}\n", file=sys.stderr)

        # Output JSON for CI
        json.dump(results, sys.stdout, indent=2)
        print()

        # Cleanup daemon
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)

    finally:
        if not args.keep:
            print(f"[stress] cleaning up {tmp} ...", file=sys.stderr)
            shutil.rmtree(tmp, ignore_errors=True)
            print("[stress] cleanup done", file=sys.stderr)
        else:
            print(f"[stress] kept: {tmp}", file=sys.stderr)


if __name__ == "__main__":
    main()
