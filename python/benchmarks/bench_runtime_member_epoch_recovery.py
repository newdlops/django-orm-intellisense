"""Fresh VS Code sessions with complete prefilled caches and scheduling controls.

Application fixtures/caches remain under /private/tmp. Each host also runs the
existing complete cold/save/new-model foreground test. No source changes are
allowed while a host is live; before/after package hashes verify ownership.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture
from benchmarks.bench_initial_lookup_catalog import sha, tree


def run(output: Path, inline_values: list[str], executable: str):
    repo = Path(__file__).resolve().parents[2]
    baseline_path = repo / 'bench/runtime-member-epoch-recovery-baseline.json'
    baseline = json.loads(baseline_path.read_text())
    output.mkdir(parents=True, exist_ok=False)
    package = repo / 'python/django_orm_intellisense'
    worker = {path.relative_to(package).as_posix(): sha(path) for path in sorted(package.rglob('*.py'))}
    measured = set(baseline['verifiedPreviousHashes']) | {str(Path(__file__).relative_to(repo)),
        'python/benchmarks/bench_cached_initialize_surface_daemon.py',
        'scripts/probe-cached-initialize-surface.cjs', 'python/tests/test_initialize_cached_surface.py',
        'python/tests/test_surface_index_background_load.py', 'python/tests/test_async_runtime_members.py'}
    sources = {name: sha(repo / name) for name in sorted(measured)}
    reproduction = Path(tempfile.mkdtemp(prefix='djls-runtime-member-epoch-recovery-', dir='/private/tmp'))
    probe = repo / 'scripts/probe-initial-lookup-catalog.cjs'
    rows = []
    for index, inline in enumerate(inline_values):
        idle = 'default'
        folder = output / f'{index}-inline-{inline}'
        folder.mkdir()
        root = reproduction / f'{index}-fixture'
        root.mkdir()
        create_fixture(root, 500, 5000)
        uuid = root / 'app0/model_1.py'
        uuid.write_text(uuid.read_text().replace('class Model1(models.Model):',
            'class Model1(models.Model):\n    key = models.UUIDField(primary_key=True)'))
        query = root / 'helpers/helper_0.py'
        assert query.exists()
        query.write_text('from app0.models import Model0\nModel0.objects.filter(field_14__exact="value")\n')
        source_tree, paths = tree(root)
        before_files = {path.relative_to(root).as_posix(): sha(path) for path in paths}
        assert len(before_files) == 5000
        cache = reproduction / f'{index}-cache'
        seed_folder = folder / 'seed'
        seed_folder.mkdir()
        seed_manifest = {'root': str(root), 'cache': str(cache), 'python': sys.executable,
            'pythonPath': str(repo / 'python'), 'workerModule': 'django_orm_intellisense', 'variant': 'current',
            'models': 500, 'pythonFiles': 5000, 'idleMs': 2000, 'transportVersion': 1,
            'sourceTreeSha256': source_tree, 'workerPackageSha256': worker, 'probeSha256': sha(probe)}
        seed_manifest_path = seed_folder / 'manifest.json'
        seed_manifest_path.write_text(json.dumps(seed_manifest, indent=2) + '\n')
        seeded = subprocess.run(['node', str(probe), str(seed_manifest_path), str(seed_folder)],
            cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        (seed_folder / 'node-stdout.log').write_text(seeded.stdout)
        (seed_folder / 'node-stderr.log').write_text(seeded.stderr)
        assert seeded.returncode == 0, (folder, seeded.stderr)
        seed_result = json.loads(seeded.stdout)
        (seed_folder / 'result.json').write_text(json.dumps(seed_result, indent=2) + '\n')
        assert tree(root)[0] == source_tree
        manifest = {**seed_manifest, 'queryPath': str(query), 'sourceBeforeFiles': before_files,
            'sourceBeforeHashes': sources, 'workerBeforeHashes': worker, 'editorIdleMs': idle, 'inlineCachedSurface': inline,
            'seedResult': str(seed_folder / 'result.json'), 'seedResultSha256': sha(seed_folder / 'result.json'),
            'driverSha256': sha(Path(__file__)), 'vscodeTestConfigSha256': sha(repo / '.vscode-test.mjs'),
            'fixtureGeneratorSha256': sha(repo / 'python/benchmarks/bench_async_runtime_member_refresh.py')}
        manifest_path = folder / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        env = dict(os.environ)
        env.update({'DJLS_E2E_VSCODE_EXECUTABLE': executable, 'DJLS_E2E_DJANGO_MAJOR': '6',
            'DJLS_E2E_BASE_PYTHON': sys.executable, 'DJLS_E2E_CPU_PROFILE': '0',
            'DJLS_E2E_CACHED_STARTUP_MANIFEST': str(manifest_path),
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(cache), 'DJLS_SURFACE_CACHE_LOAD_MODE': 'idle',
            'DJLS_SURFACE_PREBUILD_ON_MISS': '1', 'DJLS_RUNTIME_REGISTRY_MODE': 'full',
            'DJLS_INLINE_CACHED_SURFACE': inline})
        env.pop('DJLS_SURFACE_CACHE_IDLE_MS', None)
        if idle != 'default':
            env['DJLS_SURFACE_CACHE_IDLE_MS'] = idle
        log_path = folder / 'vscode.log'
        with log_path.open('w') as log:
            completed = subprocess.run([str(repo / 'node_modules/.bin/vscode-test'), '--grep',
                'uses cached lookup metadata before the parent runtime registry finishes|profiles live foreground requests across complete large runtime saves'],
                cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
        # All source/code hashes are checked after the process is terminal.
        assert all(sha(repo / name) == digest for name, digest in sources.items())
        assert all(sha(package / name) == digest for name, digest in worker.items())
        collect_cohort(rows, folder, manifest, completed.returncode, log_path)
        print(f'[runtime-member-epoch-recovery] {index} idle={idle} inline={inline} seedExit0 editorExit0', file=sys.stderr, flush=True)
    return {'models': 500, 'pythonFiles': 5000, 'inlineOrder': inline_values, 'rows': rows,
        'reproductionRoot': str(reproduction), 'baseline': str(baseline_path), 'baselineSha256': sha(baseline_path),
        'sourceBeforeAndAfterHashes': sources, 'workerBeforeAndAfterHashes': worker, 'driverSha256': sha(Path(__file__)),
        'scope': 'Fresh VSCode host starts against complete cache populated by terminated ordinary CLI daemons. '
            'First actual all-provider hover overlaps full publication; own callbacks are retained separately. '
            'Heavy full-data oracles and archive IO follow that timing window. All installed-extension controls '
            'remain as recorded by the harness. Another test covers full cold/save/new-model metadata. '
            'Inline flags are per-process controls; no installed settings changes, physical paint, stable SLO '
            'or aggregate-memory claim. Fixture/cache roots remain private for reproduction.'}


def collect_cohort(rows, folder, manifest, exit_code, log_path):
    log = log_path.read_text()
    initial_paths = re.findall(r'\[initial-catalog-native\] (.*)', log)
    foreground_paths = re.findall(r'\[live-surface-foreground\] (.*)', log)
    row = {'index': len(rows), 'idleMs': manifest['editorIdleMs'], 'inlineCachedSurface': manifest['inlineCachedSurface'], 'manifest': str(folder / 'manifest.json'),
        'editorExitCode': exit_code, 'log': str(log_path), 'logSha256': sha(log_path)}
    if initial_paths:
        row['initialArtifact'] = json.loads(initial_paths[-1])['artifact']
    if foreground_paths:
        row['foregroundArtifact'] = json.loads(foreground_paths[-1])['artifact']
    rows.append(row)
    (folder.parent / 'partial-results.json').write_text(json.dumps(rows, indent=2) + '\n')
    assert exit_code == 0 and '2 passing' in log and 'Exit code:   0' in log, row
    editor = json.loads(Path(row['initialArtifact']).read_text())
    foreground = json.loads(Path(row['foregroundArtifact']).read_text())
    assert not editor.get('failure') and not foreground.get('failure')
    assert editor['startupMode'] == 'fresh-editor-prefilled-cache'
    assert editor['startupManifest'] == str(folder / 'manifest.json')
    initial_path = next(name for name in editor['snapshots'] if name.endswith('-cached-initial.json.gz'))
    initial_payload = json.loads(gzip.decompress(Path(initial_path).read_bytes()))
    initial_models = len(initial_payload['surfaceIndex'])
    assert initial_models == (500 if manifest['inlineCachedSurface'] == '1' else 0)
    row['initialSurfaceModels'] = initial_models
    expected_idle = None if manifest['editorIdleMs'] == 'default' else manifest['editorIdleMs']
    for artifact in [editor, foreground]:
        assert artifact['environment']['surfaceCacheIdleMs'] == expected_idle
        assert artifact['environment']['inlineCachedSurface'] == manifest['inlineCachedSurface']
        assert artifact['environment']['extraDisabledExtensions'] == []
        for name, digest in artifact['measuredSha256'].items():
            assert sha(Path(name)) == digest
    initial = [item for item in editor['initializations'] if item['phase'] == 'cached']
    full = [item for item in editor['fullStates'] if item['phase'] == 'cached']
    assert len(initial) == len(full) == 1
    acks = [item for item in editor['publications'] if item['phase'] == 'cached'
        and item.get('surfaceModels') == 500 and item['reply']['applied']]
    assert acks, editor['publications']
    origin = initial[0]['startedMs']
    hover = editor['startupHover']
    callbacks = hover['providerCallbacks']
    row['cachedInitializeMs'] = initial[0]['responseMs'] - origin
    row['cachedFullStateObservedMs'] = full[0]['observedMs'] - origin
    row['cachedFullLspAckMs'] = min(item['finishedMs'] for item in acks) - origin
    row['firstAllProviderHoverMs'] = hover['finishedMs'] - hover['startedMs']
    row['ownHoverCallbackMs'] = [item['finishedMs'] - item['startedMs'] for item in callbacks]
    row['coldFullStateObservedMs'] = foreground['windows'][0]['fullReadyAtMs']
    row['foregroundProbes'] = sum(len(item.get('probes', [])) for item in foreground['windows'])
    row['foregroundHoverCallbacks'] = sum(probe['method'] == 'vscodeHover'
        for item in foreground['windows'] for probe in item.get('probes', []))
    row['cachedEarlyQueriesBeforeRegistryMarker'] = editor['cachedRawQueriesFinishedBeforeRegistryMarker']
    root = Path(manifest['root'])
    after = {path.relative_to(root).as_posix(): sha(path) for path in sorted(root.rglob('*.py'))}
    assert set(after) == set(manifest['sourceBeforeFiles'])
    assert {name for name in after if after[name] != manifest['sourceBeforeFiles'][name]} == {'app0/model_0.py'}
    assert editor['sourceEdit']['before'] != editor['sourceEdit']['after']
    readiness = editor['sourceEditMemberReadiness']
    assert readiness['missingAfterWait'] == []
    assert readiness['verifiedReceiverKinds'] == ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    assert len(editor['sourceEditMemberResolutions']) == 7
    assert 'attached_query' in editor['editedEditorMemberCompletion']['labels']
    origin = editor['sourceEdit']['requestedMs']
    row['sourceEditLookupReadyMs'] = readiness['lookupReadyMs'] - origin
    row['sourceEditFullVerifiedMs'] = readiness['fullVerifiedMs'] - origin
    row['sourceEditFullLspAckMs'] = readiness['lspMembersAcknowledgedMs'] - origin
    row['sourceEditMissingMembersBeforeWait'] = readiness['missingBeforeWait']
    row['sourceEditCompleteMembersPythonClientLspAndEditorChecked'] = True
    row['sourceAfterFiles'] = after
    row['sourceAndWorkerHashesUnchangedDuringEditor'] = True
    (folder / 'result.json').write_text(json.dumps(row, indent=2) + '\n')
    (folder.parent / 'partial-results.json').write_text(json.dumps(rows, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--inline', nargs='+', choices=['0', '1'], default=['0', '1', '1', '0'])
    parser.add_argument('--vscode-executable', default=os.environ.get('DJLS_E2E_VSCODE_EXECUTABLE'))
    args = parser.parse_args()
    assert args.vscode_executable, '--vscode-executable is required'
    print(json.dumps(run(args.output_dir.resolve(), args.inline, args.vscode_executable), indent=2))
