"""Reproduce a source edit after the initial scan and before cache adoption."""
import json
import os
import tempfile
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import save_static_index
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _write_blog_models


with tempfile.TemporaryDirectory(prefix='djls-initialize-scan-race-') as temporary:
    root = Path(temporary).resolve() / 'workspace'
    root.mkdir()
    _write_blog_models(root)
    source = root / 'blog' / 'models.py'
    before = snapshot_python_sources(root, max_workers=1)
    index = build_static_index(root, before.files)
    with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root.parent / 'cache')}):
        save_static_index(root, before, index)
        server = _make_server(root)
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 1:
                stamp = source.stat()
                source.write_text(source.read_text().replace('CharField', 'DateField'))
                os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan), \
                mock.patch.object(server, '_start_runtime_warmup'), \
                mock.patch.object(server, '_start_runtime_field_registry_prewarm'), \
                mock.patch.object(server, '_schedule_surface_index_idle_load'):
            result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
        actual = snapshot_python_sources(root, max_workers=1)
        field_kind = result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind']
        report = {'sourceFieldKind': 'DateField', 'firstResponseFieldKind': field_kind,
                  'initialScans': len(scans), 'publishedSnapshotMatchesCurrentSource':
                  server.source_snapshot.fingerprint == actual.fingerprint,
                  'scope': 'Deterministic same-size field edit with restored mtime after scan returns and before cached adoption. Runtime/background disabled, actual static cache. No claim about untested race points or atomic whole source filesystem.'}
        print(json.dumps(report, indent=2))
        assert field_kind == 'DateField' and report['publishedSnapshotMatchesCurrentSource'], report
