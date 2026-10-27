"""Measure source-path sharing across real Django receiver member inspection."""
from __future__ import annotations
import argparse
import cProfile
import json
import pstats
import tempfile
import time
from pathlib import Path

import django
from django.conf import settings
from django.db.models import QuerySet
from django_orm_intellisense.features.orm_members import (
    _runtime_callable_member_items, _runtime_source_paths, _runtime_callable_candidates, _with_runtime_source_paths)


def sample(owner, workspace_files, repetitions, legacy):
    @_with_runtime_source_paths
    def build():
        # Hold candidate selection constant so this remains a path-only
        # comparison after build-scoped candidate sharing was introduced.
        token = _runtime_callable_candidates.set(None)
        try:
            return [_runtime_callable_member_items(owner_classes=[owner], workspace_files=workspace_files,
                receiver_kind=kind, model_label='sample.Post', manager_name=None,
                default_return_kind='queryset')
                for kind in ('manager', 'queryset', 'related_manager')]
        finally:
            _runtime_callable_candidates.reset(token)
    function = build.__wrapped__ if legacy else build
    expected = function()
    profiler = cProfile.Profile()
    started = time.perf_counter()
    profiler.enable()
    for _ in range(repetitions):
        actual = function()
    profiler.disable()
    elapsed = (time.perf_counter() - started) * 1000
    assert actual == expected
    assert _runtime_source_paths.get() is None
    assert _runtime_callable_candidates.get() is None
    rows = [{'file': key[0], 'function': key[2], 'calls': value[1],
             'cumulativeMs': value[3] * 1000}
            for key, value in pstats.Stats(profiler).stats.items()
            if key[2] in {'resolve', '_runtime_callable_member_items', '_workspace_callable_members'}
            or key[2] == '__call__' and key[0].endswith('orm_members.py')]
    return {'profiledMs': elapsed, 'calls': rows,
            'memberNamesByReceiver': [[item.name for item in surface] for surface in expected]}, expected


def run(repetitions):
    if not settings.configured:
        settings.configure(INSTALLED_APPS=[], SECRET_KEY='surface-path-benchmark')
    django.setup()
    with tempfile.TemporaryDirectory(prefix='djls-surface-path-profile-') as folder:
        root = Path(folder)
        path = root / 'querysets.py'
        alias = root / 'alias.py'
        source = ('class LocalQuerySet(QuerySet):\n    def recent(self) -> "QuerySet":\n        return self\n'
                  '    @property\n    def total(self) -> int:\n        raise AssertionError("Property invoked")\n')
        path.write_text(source)
        alias.symlink_to(path)
        namespace = {'QuerySet': QuerySet}
        exec(compile(source, str(alias), 'exec'), namespace)
        workspace_files = frozenset({str(path.resolve())})
        profiles = []
        for name, owner in [('DjangoQuerySet', QuerySet), ('LocalQuerySet', namespace['LocalQuerySet'])]:
            before, old_items = sample(owner, workspace_files, repetitions, True)
            after, new_items = sample(owner, workspace_files, repetitions, False)
            assert old_items == new_items
            profiles.append({'owner': name, 'legacy': before, 'sharedPaths': after, 'equivalent': True})
        return {'repetitions': repetitions, 'profiles': profiles,
                'scope': 'Three receiver callable inspections per build using installed Django and a temporary local queryset compiled through a symlink. Includes source/annotation metadata; excludes complete surface, discovery, daemon RPC, UI and SQL.',
                'note': 'Legacy calls the same function without its batch wrapper. No mock dispatch overhead. Timing depends on host scheduling; no stable full-RPC speedup claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions), indent=2))
