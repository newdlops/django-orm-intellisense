"""Same-daemon diagnostics after topology edits, checked against fresh Django."""
import argparse
import dataclasses
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path
from unittest import mock

from benchmarks.bench_daemon_lifecycle import Client


def assert_catalogue_matches(actual, expected, labels):
    """Compare every reachable descriptor while allowing owner-local type IDs."""
    pairs = []
    for label in labels:
        for key in ('fields', 'expressionFields'):
            left = actual.get(key, {}).get(label, {})
            right = expected.get(key, {}).get(label, {})
            assert left.keys() == right.keys(), (label, key, sorted(left.keys() - right.keys()),
                sorted(right.keys() - left.keys()))
            pairs.extend((left[name], right[name]) for name in right)
        assert actual.get('relationPaths', {}).get(label, {}) == expected.get('relationPaths', {}).get(label, {}), (label, 'relationPaths')
    visited = set()
    while pairs:
        first, second = pairs.pop()
        if (first, second) in visited:
            continue
        visited.add((first, second))
        if first is None or second is None:
            assert first is second, (first, second)
            continue
        left, right = actual['types'][first], expected['types'][second]
        assert {key: value for key, value in left.items() if key not in ('transforms', 'dynamicTransform')} == {
            key: value for key, value in right.items() if key not in ('transforms', 'dynamicTransform')}, (first, second, left, right)
        assert left['transforms'].keys() == right['transforms'].keys(), (first, second, 'transforms')
        pairs.extend((left['transforms'][name], right['transforms'][name]) for name in right['transforms'])
        left, right = left.get('dynamicTransform') or {}, right.get('dynamicTransform') or {}
        assert {key: value for key, value in left.items() if key not in ('outputType', 'sliceType')} == {
            key: value for key, value in right.items() if key not in ('outputType', 'sliceType')}, (first, second, 'dynamicTransform')
        pairs.extend((left.get(key), right.get(key)) for key in ('outputType', 'sliceType'))
    return len(visited)


def source(phase):
    growing = phase == 'grown'
    initial = phase == 'initial'
    text = 'from django.db import models\n'
    text += 'class Author(models.Model):\n    code = models.UUIDField(primary_key=True)\n'
    if initial:
        text += 'class Gone(models.Model):\n    value = models.TextField()\n'
    elif growing:
        text += 'class Added(models.Model):\n    value = models.IntegerField()\n'
    text += 'class Post(models.Model):\n'
    text += '    title = models.' + ('CharField(max_length=30)' if initial else
        'DateField()' if growing else 'IntegerField()') + '\n'
    text += ('    author = models.ForeignKey(Author, on_delete=models.CASCADE, '
        'related_name="posts", related_query_name="post_query")\n' if initial else
        '    author = models.OneToOneField(Author, on_delete=models.CASCADE, '
        'related_name="current_post", related_query_name="current_query")\n')
    if growing:
        text += '    enabled = models.BooleanField(default=True)\n'
    if initial or growing:
        text += ('    tags = models.ManyToManyField(Author, '
            'related_name="tagged", related_query_name="tag_query")\n')
    text += '    objects = models.Manager()\n    ' + {
        'initial': 'special', 'grown': 'another', 'shrunk': 'revised'}[phase] + ' = models.Manager()\n'
    text += f'    def {phase}_marker(self):\n        return self\n'
    for number in range(12):
        text += f'class ZZ{number:02}(models.Model):\n    value = models.CharField(max_length=10)\n'
        if growing and number == 11:
            text += '    objects = models.Manager()\n    archive = models.Manager()\n'
    return text


def oracle(root, settings, output, baseline_inspector=None, include_surface=False):
    from django_orm_intellisense.runtime import inspector
    from django_orm_intellisense.runtime.source_imports import current_workspace_source_imports
    sys.path.insert(0, str(root))
    with current_workspace_source_imports((root,)):
        old = None
        if baseline_inspector:
            module = types.ModuleType('django_orm_intellisense.runtime._health_baseline_oracle')
            module.__file__ = str(baseline_inspector)
            module.__package__ = 'django_orm_intellisense.runtime'
            sys.modules[module.__name__] = module
            raw = gzip.decompress(baseline_inspector.read_bytes())
            exec(compile(raw, str(baseline_inspector), 'exec'), module.__dict__)
            old = module.inspect_runtime(settings)
            assert old.bootstrap_status == 'ready', old.bootstrap_error
        current = inspector.inspect_runtime(settings)
        assert current.bootstrap_status == 'ready', current.bootstrap_error
        if old is not None:
            assert old.to_cache_dict() == current.to_cache_dict(), 'Cold inspector whole output changed'
            assert module._RUNTIME_FIELD_REGISTRY.keys() == inspector._RUNTIME_FIELD_REGISTRY.keys()
            assert all(module._RUNTIME_FIELD_REGISTRY[key] is value
                for key, value in inspector._RUNTIME_FIELD_REGISTRY.items()), 'Cold field aliases changed'
            assert module._RUNTIME_LOOKUP_FIELD_ALIASES == inspector._RUNTIME_LOOKUP_FIELD_ALIASES
        expected = (old or current).to_dict()
        expected.pop('pythonPath')
        count_checks = []
        original_registry = inspector._RUNTIME_FIELD_REGISTRY
        for limit in (0, 1, 10, 100):
            with mock.patch.object(inspector, 'RuntimeModelSummary', wraps=inspector.RuntimeModelSummary) as rows:
                metadata = inspector.collect_runtime_model_metadata(model_limit=limit)
            expected_limit = {**expected, 'modelPreview': expected['modelPreview'][:limit]}
            subset = {key: expected_limit[key] for key in metadata.to_health_dict()}
            assert metadata.to_health_dict() == subset, (limit, metadata.to_health_dict(), subset)
            assert rows.call_count == min(limit, current.model_count), (limit, rows.call_count)
            assert inspector._RUNTIME_FIELD_REGISTRY is original_registry
            count_checks.append({'limit': limit, 'rowsConstructed': rows.call_count,
                'allCountsEqual': True})
        reference = {(model.module, model.label.rsplit('.', 1)[-1]): model for model in current.model_catalog}
        with mock.patch.object(inspector, 'RuntimeModelSummary', wraps=inspector.RuntimeModelSummary) as rows:
            metadata = inspector.collect_runtime_model_metadata(model_limit=10, model_reference=reference)
        assert rows.call_count == min(10, current.model_count)
        assert metadata.to_health_dict() == {key: expected[key] for key in metadata.to_health_dict()}
        if len(reference) > 10:
            key = list(reference)[-1]
            reference[key] = dataclasses.replace(reference[key], manager_names=['obsolete_manager'])
            with mock.patch.object(inspector, 'RuntimeModelSummary', wraps=inspector.RuntimeModelSummary) as rows:
                metadata = inspector.collect_runtime_model_metadata(model_limit=10, model_reference=reference)
            assert rows.call_count == 11, rows.call_count
            assert metadata.models[-1] == current.model_catalog[-1]
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY', {}), \
                mock.patch.object(inspector, '_RUNTIME_LOOKUP_FIELD_ALIASES', {}), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', None):
            inspector._ensure_runtime_field_registry(settings)
            assert inspector._RUNTIME_FIELD_REGISTRY.keys() == original_registry.keys(), 'Lazy/cold aliases differ'
            assert all(inspector._RUNTIME_FIELD_REGISTRY[key] is value for key, value in original_registry.items())
    result = {'runtime': expected, 'coldInspection': current.to_cache_dict(),
        'baselineWholeColdOutputEqual': old is not None,
        'baselineInspectorSha256': hashlib.sha256(baseline_inspector.read_bytes()).hexdigest()
            if baseline_inspector else None,
        'boundedPreviewChecks': count_checks}
    result['lazyAndColdRegistryAliasesEqual'] = True
    result['referenceConstructsOnlyPreviewAndChangedModels'] = True
    if include_surface:
        from django_orm_intellisense.static_index.indexer import build_static_index
        from django_orm_intellisense.semantic.graph import build_model_graph
        from django_orm_intellisense.features.orm_members import prebuild_member_surface_cache
        from django_orm_intellisense.features.relation_targets import list_relation_targets
        with current_workspace_source_imports((root,)):
            static = build_static_index(root)
            graph = build_model_graph(static, current)
            result['surface'] = prebuild_member_surface_cache(static, current, graph)
            result['relationTargets'] = list_relation_targets(model_graph=graph)
    output.write_text(json.dumps(result, sort_keys=True) + '\n')


def run(output_dir, baseline_inspector=None, daemon_pythonpath=None, check_surface=False):
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-health-topology-') as temporary:
        root = Path(temporary).resolve() / 'project'
        for package in ('coreapp', 'extraapp'):
            (root / package).mkdir(parents=True)
            (root / package / '__init__.py').write_text('')
        (root / 'coreapp' / 'apps.py').write_text('from django.apps import AppConfig\n'
            'class CoreConfig(AppConfig):\n    name="coreapp"\n    label="custom_core"\n')
        (root / 'health_settings.py').write_text('INSTALLED_APPS=["coreapp", "extraapp"]\n'
            'SECRET_KEY="health-refresh"\nDEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        model_source = root / 'coreapp' / 'models.py'
        extra = root / 'extraapp' / 'models.py'
        helper = root / 'helper.py'
        model_source.write_text(source('initial'))
        extra.write_text('')
        environment = {'PYTHONPATH': str(daemon_pythonpath)} if daemon_pythonpath else None
        client = Client(root, root.parent / 'cache', keep_log=True, worker_environment=environment)
        try:
            initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                'settingsModule': 'health_settings', 'deferRuntime': False})
            full = initialized if initialized.get('surfaceIndex') else client.wait_for_notification(
                'surfaceIndexChanged', lambda value: bool(value.get('surfaceIndex')))
            runtime_phase = 'initial'
            started_at = full['health']['startedAt']
            for phase in ('initial', 'grown', 'shrunk', 'helper_created', 'helper_deleted'):
                replies = []
                if phase != 'initial':
                    if phase in ('grown', 'shrunk'):
                        runtime_phase = phase
                        model_source.write_text(source(phase))
                        extra.write_text('from django.db import models\nclass Extra(models.Model):\n'
                            '    post = models.ForeignKey("custom_core.Post", on_delete=models.CASCADE, '
                            'related_name="extras", related_query_name="extra_query")\n' if phase == 'grown' else '')
                        changed = (model_source, extra)
                    elif phase == 'helper_created':
                        helper.write_text('value = 1\n')
                        changed = (helper,)
                    else:
                        helper.unlink()
                        changed = (helper,)
                    # Restrict acceptance to notifications received for this save.
                    client.notifications.clear()
                    started = time.perf_counter()
                    for path in changed:
                        reply, elapsed = client.request('reindexFile', {'filePath': str(path)})
                        assert reply.get('runtimeMembersPending') is True, reply
                        replies.append({'path': str(path.relative_to(root)), 'rpcMs': elapsed, 'reply': reply})
                    full = client.wait_for_notification('surfaceIndexChanged', lambda value:
                        value.get('runtimeMembersPending') is False and runtime_phase + '_marker' in
                        value.get('surfaceIndex', {}).get('custom_core.Post', {}).get('instance', {}))
                    ready_ms = (time.perf_counter() - started) * 1000
                else:
                    ready_ms = initialize_ms
                health, rpc_ms = client.request('health', {})
                assert health == full['health'], 'health RPC and complete notification differ'
                expected_path = output_dir / (phase + '-oracle.json')
                command = [sys.executable, '-m', 'benchmarks.check_runtime_health_refresh', '--oracle',
                    '--root', str(root), '--output-dir', str(expected_path)]
                if baseline_inspector:
                    command += ['--baseline-inspector', str(baseline_inspector.resolve())]
                if check_surface:
                    command += ['--check-surface']
                check = subprocess.run(command, capture_output=True, text=True, timeout=30)
                assert check.returncode == 0, check.stderr
                expected = json.loads(expected_path.read_text())
                payload = output_dir / (phase + '-payload.json')
                payload.write_text(json.dumps({'full': full, 'health': health, 'reindexReplies': replies},
                    sort_keys=True) + '\n')
                sources = output_dir / (phase + '-sources.json')
                sources.write_text(json.dumps({str(path.relative_to(root)): path.read_text()
                    for path in sorted(root.rglob('*.py'))}, sort_keys=True) + '\n')
                assert health['runtime'] == expected['runtime'], (phase, health['runtime'], expected['runtime'])
                if check_surface:
                    expected_surface = expected['surface']
                    assert full['surfaceIndex'].keys() == expected_surface.keys(), (
                        phase, sorted(full['surfaceIndex'].keys() - expected_surface.keys()),
                        sorted(expected_surface.keys() - full['surfaceIndex'].keys()))
                    assert full['surfaceIndex'] == expected_surface, (phase, 'whole cold surface differs')
                    assert_catalogue_matches(full['lookupCatalog'], expected['coldInspection']['lookupCatalog'], expected_surface)
                expected_models = {'initial': 15, 'grown': 16, 'shrunk': 14}[runtime_phase]
                assert health['runtime']['modelCount'] == expected_models
                assert health['runtime']['appCount'] == (2 if runtime_phase == 'grown' else 1)
                assert len(health['runtime']['modelPreview']) == 10
                assert health['semanticGraph']['runtimeModelCount'] == expected_models
                assert health['staticIndex']['pythonFileCount'] == len(list(root.rglob('*.py')))
                assert health['semanticGraph']['moduleCount'] == health['staticIndex']['pythonFileCount']
                assert health['semanticGraph']['modelCandidateCount'] == health['staticIndex']['modelCandidateCount']
                assert health['startedAt'] == started_at
                rows.append({'phase': phase, 'healthRpcMs': rpc_ms, 'readyMs': ready_ms,
                    'modelCount': expected_models, 'appCount': health['runtime']['appCount'],
                    'runtimeEqualsFreshOracle': True, 'notificationMatchesHealthRpc': True,
                    'wholeSurfaceEqualsFreshOracle': check_surface, 'reachableCatalogueEqualsFreshOracle': check_surface,
                    'payload': str(payload), 'sourceArchive': str(sources), 'oracle': str(expected_path)})
        finally:
            client.close()
            (output_dir / 'daemon.log').write_bytes(Path(client.log.name).read_bytes())
        assert client.process.returncode == 0, client.process.returncode
    return {'rows': rows, 'daemonExitCode': client.process.returncode,
        'scope': 'Same daemon; fields, FK/one-to-one/M2M and reverse query/accessor aliases, '
            'manager names including one outside the preview, model/app counts and helper create/delete. '
            'Independent fresh-process cold inspector checks complete diagnostic dictionaries; optional '
            'archived pre-change inspector also checks whole cold cache output and actual registry aliases. '
            'No SQL, editor or stable latency/memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--baseline-inspector', type=Path)
    parser.add_argument('--daemon-pythonpath', type=Path)
    parser.add_argument('--oracle', action='store_true')
    parser.add_argument('--root', type=Path)
    parser.add_argument('--check-surface', action='store_true')
    args = parser.parse_args()
    if args.oracle:
        oracle(args.root, 'health_settings', args.output_dir, args.baseline_inspector, args.check_surface)
    else:
        print(json.dumps(run(args.output_dir, args.baseline_inspector, args.daemon_pythonpath, args.check_surface), indent=2))
