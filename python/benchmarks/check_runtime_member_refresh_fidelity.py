"""Production refresh records versus independent fresh full/named reflection."""
import argparse
import json
import multiprocessing
import os
import py_compile
import sys
import tempfile
import threading
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from benchmarks.check_surface_worker_runtime_fidelity import SOURCE, _member_wire
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.runtime.source_imports import current_workspace_source_imports
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app, runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


@orm_members._with_runtime_source_paths
def complete_wire(static_index, runtime, model_graph, manager_names):
    surface = orm_members.prebuild_member_surface_cache(static_index, runtime, model_graph)
    for label, names in manager_names.items():
        for name in names:
            for kind in ('manager', 'queryset', 'related_manager'):
                orm_members._surface_cache.get_list(static_index, runtime, model_graph, label, kind, name)
    return surface, _member_wire(orm_members._surface_cache)


def fresh_oracle(root, names):
    import django
    static, runtime, graph = app._worker_static_index, app._worker_runtime, app._worker_model_graph
    static._runtime_member_snapshot = None
    os.environ['DJANGO_SETTINGS_MODULE'] = runtime.settings_module
    with current_workspace_source_imports((root,)):
        django.setup()
        fresh_runtime = inspect_runtime(runtime.settings_module)
        assert fresh_runtime.bootstrap_status == 'ready', fresh_runtime.bootstrap_error
        fresh_graph = build_model_graph(static, fresh_runtime)
        labels = orm_members._build_static_to_graph_label_map(static, fresh_graph)
        for label, managers in names.items():
            node = fresh_graph.node_for_model(labels.get(label, label))
            assert tuple(sorted(node.manager_names)) == managers
        return complete_wire(static, fresh_runtime, fresh_graph, names)


def run(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-runtime-refresh-fidelity-') as temporary:
        root = Path(temporary).resolve()
        package = root / 'runtime_surface'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'apps.py').write_text('from django.apps import AppConfig\n'
            'class RuntimeSurfaceConfig(AppConfig):\n    name="runtime_surface"\n    label="custom_runtime"\n')
        source = package / 'models.py'
        source.write_text(SOURCE + '\nPost.add_to_class("special", ProjectManager())\n'
            'class Unchanged(models.Model):\n    title=models.CharField(max_length=30)\n'
            'def stable_instance(self) -> Unchanged:\n    return self\n'
            'Unchanged.stable_instance=stable_instance\n')
        bytecode = Path(py_compile.compile(str(source), doraise=True))
        original_bytecode = bytecode.read_bytes()
        (root / 'runtime_surface_settings.py').write_text('INSTALLED_APPS=["runtime_surface"]\n'
            'SECRET_KEY="refresh-fidelity"\nDEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        sys.path.insert(0, str(root))
        static = build_static_index(root)
        with current_workspace_source_imports((root,)):
            runtime = inspect_runtime('runtime_surface_settings')
        assert runtime.bootstrap_status == 'ready', runtime.bootstrap_error
        from django.apps import apps
        parent_model = apps.get_model('custom_runtime', 'Post')
        original_method = parent_model.attached_instance
        graph = build_model_graph(static, runtime)
        previous_surface = orm_members.prebuild_member_surface_cache(static, runtime, graph)
        previous_fingerprints = orm_members.fingerprint_surface_index(previous_surface)
        previous_prefix, previous_manager = 'attached', 'special'
        for prefix, manager in (('modified', 'another'), ('replaced', 'revised'), ('adjusted', 'primary')):
            stamp = source.stat()
            text = source.read_text().replace(previous_prefix + '_', prefix + '_')
            text = text.replace('"' + previous_manager + '"', '"' + manager + '"')
            if prefix == 'replaced':
                text = text.replace('stable_instance', 'unseen_instance')
            assert len(text.encode()) == stamp.st_size
            source.write_text(text)
            os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            previous_static = static
            static, _, _ = reindex_single_file(root, source, static)
            orm_members.invalidate_runtime_members(previous_static, static, runtime, {'runtime_surface.Post'})
            graph = build_model_graph(static, runtime)
            result = runtime_members.refresh_in_process(static, runtime, graph, root, (), lambda: True,
                threading.Event(), frozenset(previous_surface.keys() & previous_fingerprints.keys()))
            snapshot = result.snapshot
            transported_surface, fingerprints = runtime_members.compose_runtime_member_surface(
                static, graph, result, previous_surface, previous_fingerprints)
            assert snapshot.manager_names['runtime_surface.Post'] == tuple(sorted(('objects', manager)))
            orm_members.install_runtime_members(static, runtime, graph, snapshot)
            surface, wire = complete_wire(static, runtime, graph, snapshot.manager_names)
            assert surface == transported_surface
            assert fingerprints == orm_members.fingerprint_surface_index(surface)
            with app.surface_worker_state_file(static, runtime, graph) as path:
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                        initializer=app._init_bg_worker_from_file, initargs=(path,)) as pool:
                    expected_surface, expected_wire = pool.submit(fresh_oracle, str(root),
                        snapshot.manager_names).result(timeout=30)
            assert surface == expected_surface
            assert wire == expected_wire
            if prefix == 'replaced':
                assert set(result.surface) == {'custom_runtime.Post', 'custom_runtime.Unchanged'}
                assert 'unseen_instance' in surface['custom_runtime.Unchanged']['instance']
            if prefix == 'adjusted':
                assert set(result.surface) == {'custom_runtime.Post'}
                assert transported_surface['custom_runtime.Unchanged'] is previous_surface['custom_runtime.Unchanged']
            assert apps.get_model('custom_runtime', 'Post') is parent_model
            assert parent_model.attached_instance is original_method and not hasattr(parent_model, prefix + '_instance')
            assert bytecode.read_bytes() == original_bytecode
            payload = output_dir / (prefix + '-payload.json')
            payload.write_text(json.dumps({'surface': surface, 'everyDefaultAndNamedMemberWire': wire}, sort_keys=True) + '\n')
            rows.append({'phase': prefix, 'completeSurfaceEqualToIndependentFreshReflection': True,
                'everyDefaultAndNamedMemberWireEqual': True, 'memberCacheGroups': len(wire),
                'parentDjangoClassesUnchanged': True, 'canonicalLabel': 'custom_runtime.Post',
                'rebuiltSurfaceKeys': sorted(result.surface), 'partialRefresh': not result.complete,
                'freshManagerNames': list(snapshot.manager_names['runtime_surface.Post']), 'payload': str(payload)})
            previous_prefix, previous_manager = prefix, manager
            previous_surface, previous_fingerprints = transported_surface, fingerprints
    return {'productionRefreshWorkerUsed': True, 'rows': rows,
        'scope': 'Actual production fresh worker/private full-state/result transport and a separate independent '
            'fresh Django reflection oracle for each of three edits across two models. Complete published surface, fingerprints and '
            'every bound member field including signatures/locations/source/return/manager metadata agree for '
            'default and all named manager/queryset/related receivers under a custom AppConfig label. Parent '
            'Django classes and original timestamp pyc remain unchanged. Second edit changes a model omitted '
            'from the invalidation set; full fresh comparison still rebuilds it. Third edit shares the unchanged '
            'model entry while rebuilding only the edited model. Not a daemon scheduling, race or latency proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir), indent=2))
