"""Measure warmed source-path membership after model creation/deletion.

This is an indexer/membership benchmark, not full daemon RPC latency.
"""
from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features.orm_members import _workspace_files
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


def run(model_count: int, file_count: int) -> dict:
    with tempfile.TemporaryDirectory(prefix='djls-source-paths-') as temporary:
        root = Path(temporary)
        generate_synthetic_project(root, model_count)
        generated_count = len(list(root.rglob('*.py')))
        assert file_count >= generated_count
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - generated_count):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        index = build_static_index(root)
        started = time.perf_counter()
        original_paths = _workspace_files(index)
        cold_ms = (time.perf_counter() - started) * 1000
        assert len(original_paths) == file_count
        events = []
        path = root / 'new_entry.py'
        original_resolve = Path.resolve
        for event in ('create', 'delete'):
            if event == 'create':
                path.write_text('from django.db import models\nclass NewEntry(models.Model):\n    value = models.TextField()\n')
            else:
                path.unlink()
            calls = []

            def resolve(changed, *args, **kwargs):
                calls.append(str(changed))
                return original_resolve(changed, *args, **kwargs)

            with mock.patch.object(Path, 'resolve', new=resolve):
                started = time.perf_counter()
                updated, _, _ = reindex_single_file(root, path, index)
                indexer_ms = (time.perf_counter() - started) * 1000
                started = time.perf_counter()
                updated_paths = _workspace_files(updated)
                membership_ms = (time.perf_counter() - started) * 1000
            assert len(calls) <= 1, calls
            assert len(updated_paths) == file_count + (event == 'create')
            assert _workspace_files(index) != updated_paths
            events.append({'event': event, 'indexerMs': indexer_ms,
                'nextMembershipMs': membership_ms, 'canonicalResolveCalls': len(calls),
                'cachedPaths': len(updated_paths)})
            index = updated
        return {'pythonFiles': file_count, 'models': model_count,
            'coldMembershipMs': cold_ms, 'events': events,
            'scope': 'Static indexer and warmed source-path membership; excludes daemon RPC, commit and serialization'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--files', type=int, default=10000)
    arguments = parser.parse_args()
    print(json.dumps(run(arguments.models, arguments.files), indent=2))
