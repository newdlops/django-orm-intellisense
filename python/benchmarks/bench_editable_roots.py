"""Verify editable discovery feeds external sources into complete daemon RPCs."""
from __future__ import annotations
import argparse
import json
import os
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client


def run(metadata_count, source_files, relative_legacy=False):
    with tempfile.TemporaryDirectory(prefix='djls-editable-roots-') as folder:
        base = Path(folder).resolve() if relative_legacy else Path(folder)
        root = base / 'workspace'
        blog = root / 'blog'
        blog.mkdir(parents=True)
        (blog / '__init__.py').write_text('')
        (blog / 'models.py').write_text('from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        source = base / 'editable'
        shared = source / 'shared'
        shared.mkdir(parents=True)
        (shared / '__init__.py').write_text('')
        path = shared / 'models.py'
        path.write_text('from django.db import models\nclass Shared(models.Model):\n    value = models.CharField()\n')
        for number in range(source_files - 2):
            (source / f'helper_{number}.py').write_text(f'value = {number}\n')
        packages = root / '.venv/lib/python3.12/site-packages'
        packages.mkdir(parents=True)
        (root / '.venv/pyvenv.cfg').write_text('version = 3.12.13\n')
        for number in range(metadata_count):
            metadata = packages / f'package_{number}-1.0.dist-info'
            metadata.mkdir()
            if not relative_legacy:
                (metadata / 'direct_url.json').write_text(json.dumps({'url': source.as_uri(), 'dir_info': {'editable': True}}))
        if relative_legacy:
            (packages / 'legacy.egg-link').write_text(os.path.relpath(source, packages) + '\n.')
        expected_installs = 1 if relative_legacy else metadata_count
        client = Client(root, base / 'cache')
        try:
            initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root), 'deferRuntime': True})
            assert initialized['modelNames'] == ['Post', 'Shared'], initialized['modelNames']
            assert len(initialized['venvInfo']['editableInstalls']) == expected_installs
            if relative_legacy:
                assert initialized['venvInfo']['editableInstalls'] == [
                    {'name': 'legacy', 'path': str(source), 'kind': 'egg-link'}]
            fallback = initialized['staticFallback']['shared.Shared']
            assert fallback['fieldDetails']['value']['fieldKind'] == 'CharField'
            log = Path(client.log.name).read_text()
            assert f'editable_installs count={expected_installs} roots=1 ' in log, log
            path.write_text(path.read_text().replace('CharField', 'IntegerField'))
            edited, edit_ms = client.request('reindexFile', {'filePath': str(path)})
            assert 'error' not in edited, edited
            value, _ = client.request('resolveLookupPath', {'baseModelLabel': 'shared.Shared',
                'value': 'value__gte', 'method': 'filter'})
            assert value['resolved'] and value['terminalType']['outputFieldKind'] == 'IntegerField', value
            path.unlink()
            (shared / '__init__.py').unlink()
            shared.rmdir()
            delete_started = time.perf_counter()
            listing, listing_ms = client.request('deletedSourceFiles', {'filePath': str(shared)})
            assert {Path(file).resolve() for file in listing['filePaths']} == {path.resolve(), (shared / '__init__.py').resolve()}, listing
            for file in listing['filePaths']:
                deleted, _ = client.request('reindexFile', {'filePath': file})
                assert 'error' not in deleted, deleted
            delete_ms = (time.perf_counter() - delete_started) * 1000
            missing, _ = client.request('resolveLookupPath', {'baseModelLabel': 'shared.Shared',
                'value': 'value__gte', 'method': 'filter'})
            assert not missing['resolved'], missing
            return {'metadataDirectories': metadata_count, 'sourceFiles': source_files,
                'metadataFormat': 'relative-legacy-only' if relative_legacy else 'modern-direct-url',
                'editableInstalls': expected_installs,
                'editableEntriesPreserved': True, 'uniqueSourceRoots': 1,
                'externalModelInitialized': True, 'externalSaveLookupResolved': True,
                'initializeRpcMs': initialize_ms, 'externalEditRpcMs': edit_ms,
                'externalPackageDeleteRpcMs': delete_ms,
                'deletedSourceExpansionRpcMs': listing_ms,
                'deletedSourcesReindexed': len(listing['filePaths']),
                'externalDeletedModelLookupUnresolved': True,
                'changedLabels': edited.get('changedLabels'),
                'scope': 'Complete deferred-runtime daemon RPC with source discovery/static graph/transport. '
                    + ('One relative legacy egg-link among ordinary metadata directories. ' if relative_legacy else 'Repeated modern editable paths across all metadata directories. ')
                    + 'All install entries remain, external field save is resolved, and missing indexed source expansion plus two reindex RPCs after whole-package deletion remove the model. Excludes configured Django runtime, editor debounce/rendering and SQL.'}
        finally:
            client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--metadata', type=int, default=500)
    parser.add_argument('--files', type=int, default=1000)
    parser.add_argument('--relative-legacy', action='store_true')
    args = parser.parse_args()
    if args.metadata < 1 or args.files < 2:
        parser.error('Metadata count must be positive and source files at least two')
    print(json.dumps(run(args.metadata, args.files, args.relative_legacy), indent=2))
