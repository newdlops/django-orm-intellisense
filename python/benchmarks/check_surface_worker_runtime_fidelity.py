"""Compare actual spawned prebuild against the configured parent's full surface."""
import argparse
import dataclasses
import hashlib
import json
import multiprocessing
import os
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


SOURCE = '''from django.db import models

class ProjectQuerySet(models.QuerySet):
    pass

def attached_query(self) -> models.QuerySet:
    return self

ProjectQuerySet.attached_query = attached_query

class ProjectManager(models.Manager.from_queryset(ProjectQuerySet)):
    pass

class Post(models.Model):
    title = models.CharField(max_length=30)
    objects = ProjectManager()

def attached_instance(self) -> Post:
    return self

def attached_class(cls) -> Post:
    return cls()

Post.attached_instance = attached_instance
Post.attached_class = classmethod(attached_class)
'''


def _member_wire(cache):
    return {repr(key): [item.to_dict() for item in items]
            for key, items in cache._list_cache.items()}


def _worker_probe(members_path):
    original = orm_members._MemberSurfaceCache
    caches = []
    def create():
        cache = original()
        caches.append(cache)
        return cache
    with mock.patch.object(orm_members, '_MemberSurfaceCache', create):
        surface = app._bg_prebuild_surface_index(members_path)
    cache = caches[-1] if caches else orm_members._surface_cache
    from django.apps import apps
    return surface, _member_wire(cache), apps.ready, os.getpid()


def run(legacy=False):
    with tempfile.TemporaryDirectory(prefix='djls-surface-runtime-fidelity-') as temporary:
        root = Path(temporary).resolve()
        package = root / 'runtime_surface'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text(SOURCE)
        (root / 'runtime_surface_settings.py').write_text(
            'INSTALLED_APPS = ["runtime_surface"]\nSECRET_KEY = "surface-runtime-probe"\n'
            'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"\n'
            'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n')
        sys.path.insert(0, str(root))
        static = build_static_index(root)
        runtime = inspect_runtime('runtime_surface_settings')
        assert runtime.bootstrap_status == 'ready', runtime.bootstrap_error
        graph = build_model_graph(static, runtime)
        inline = orm_members.prebuild_member_surface_cache(static, runtime, graph)
        inline_members = _member_wire(orm_members._surface_cache)
        members = None if legacy else orm_members.capture_runtime_member_surface(static, runtime)
        with app.surface_worker_state_file(static, runtime, graph) as name, \
                app.runtime_member_state_file(members) as members_path:
            with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                    initializer=app._init_bg_worker_from_file, initargs=(name,)) as pool:
                spawned, spawned_members, child_apps_ready, worker_pid = pool.submit(_worker_probe, members_path).result(timeout=30)
                reused_worker_current_capture = False
                if members is not None:
                    second = dict(members)
                    key = ('runtime_surface.Post', 'instance', None)
                    second[key] = tuple(dataclasses.replace(item, name='modified_instance')
                        if item.name == 'attached_instance' else item for item in second[key])
                    with app.runtime_member_state_file(second) as second_path:
                        newer, _, _, newer_pid = pool.submit(_worker_probe, second_path).result(timeout=30)
                    assert worker_pid == newer_pid
                    assert 'modified_instance' in newer['runtime_surface.Post']['instance']
                    assert 'attached_instance' not in newer['runtime_surface.Post']['instance']
                    reused_worker_current_capture = True
        label = 'runtime_surface.Post'
        expected_names = {'instance': {'attached_instance', 'attached_class'},
            'model_class': {'attached_class'}, 'manager': {'attached_query'},
            'queryset': {'attached_query'}}
        for receiver, names in expected_names.items():
            assert names <= inline[label][receiver].keys(), (receiver, inline[label][receiver])
        differences = {
            receiver: {'missingFromSpawn': sorted(inline[label].get(receiver, {}).keys()
                - spawned.get(label, {}).get(receiver, {}).keys()),
                'extraInSpawn': sorted(spawned.get(label, {}).get(receiver, {}).keys()
                - inline[label].get(receiver, {}).keys())}
            for receiver in set(inline[label]) | set(spawned.get(label, {}))}
        digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        return {'runtimeStatus': runtime.bootstrap_status, 'legacyWorkerWithoutRuntimeCapture': legacy,
            'completeSurfaceEqual': inline == spawned, 'differences': differences,
            'everyMemberWireEqual': inline_members == spawned_members,
            'spawnedDjangoAppsReady': child_apps_ready,
            'runtimeItemsCaptured': sum(map(len, members.values())) if members is not None else 0,
            'reusedWorkerUsesCurrentCapture': reused_worker_current_capture,
            'inlineSha256': digest(inline), 'spawnedSha256': digest(spawned),
            'inlineSurface': inline, 'spawnedSurface': spawned,
            'scope': 'Actual configured Django parent and fresh spawn/full private state/actual '
                'prebuild/whole result/shutdown. Dynamically attached instance/class/queryset '
                'methods originate in the workspace source. No SQL execution, editor or '
                'performance/SLO claim.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    result = run(args.legacy)
    print(json.dumps(result, indent=2))
    assert result['completeSurfaceEqual'], 'Spawned full surface omits configured runtime members'
    assert result['everyMemberWireEqual'], 'Spawned bound member metadata differs from the parent'


if __name__ == '__main__':
    main()
