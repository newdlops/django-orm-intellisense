"""Verify first-response source fidelity across actual fresh daemon processes."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client


def run() -> dict:
    with tempfile.TemporaryDirectory(prefix='djls-source-restart-') as temporary:
        base = Path(temporary)
        root = base / 'project'
        root.mkdir()
        cache = base / 'cache'
        package = root / 'blog'
        package.mkdir()
        (package / '__init__.py').write_text('')
        source = package / 'models.py'
        source.write_text('from django.db import models\nclass Record(models.Model):\n    value = models.CharField()\n')
        rows = []

        def initialize(phase: str, expected: str | None) -> None:
            client = Client(root, cache)
            try:
                result, elapsed = client.request('initialize', {'workspaceRoot': str(root), 'deferRuntime': True})
                fallback = result.get('staticFallback') or {}
                record = fallback.get('blog.Record') or {}
                field = (record.get('fieldDetails') or {}).get('value') or {}
                assert field.get('fieldKind') == expected, (phase, field)
                if expected is None:
                    assert 'blog.Record' not in fallback and 'Record' not in result['modelNames']
                rows.append({'phase': phase, 'initializeRpcMs': elapsed,
                    'firstResponseFieldKind': field.get('fieldKind'), 'modelNames': result['modelNames'],
                    'expected': expected, 'firstResponseVerified': True})
            finally:
                client.close()

        initialize('cold', 'CharField')
        initialize('cached_unchanged', 'CharField')
        stamp = source.stat()
        source.write_text(source.read_text().replace('CharField', 'DateField'))
        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        initialize('cached_same_size_restored_mtime_edit', 'DateField')
        source.unlink()
        initialize('cached_model_deleted', None)
        source.write_text('from django.db import models\nclass Record(models.Model):\n    value = models.TextField()\n')
        initialize('cached_model_recreated', 'TextField')
        return {'date': '2026-10-09', 'rows': rows, 'allFirstResponsesVerified': True,
            'scope': 'Actual fresh Python daemon processes sharing one cache. First initialize response is checked without waiting for verification, runtime warmup, reindex or notifications. Covers cold/unchanged restart, equal-size preserved-mtime scalar edit, model deletion and recreation. Settings-free; excludes configured runtime, editor/LSP/native prewarm, large-workspace stability, whole/peak heap and SQL.'}


if __name__ == '__main__':
    print(json.dumps(run(), indent=2))
