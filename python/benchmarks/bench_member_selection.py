"""Real Django callable inspection only; excludes complete surface/RPC/SQL costs."""
from __future__ import annotations
import argparse
import cProfile
import inspect
import json
import pstats
import tempfile
import time
from pathlib import Path
from unittest import mock

import django
from django.conf import settings
from django.db.models import QuerySet
from django_orm_intellisense.features.orm_members import _runtime_callable_member_items


def sample(owner, workspace_files, repetitions, legacy=False):
    arguments = dict(owner_classes=[owner], workspace_files=workspace_files, receiver_kind='queryset',
        model_label='sample.Post', manager_name=None, default_return_kind='queryset')
    profiler = cProfile.Profile()
    patcher = mock.patch('django_orm_intellisense.features.orm_members._workspace_callable_members',
        side_effect=lambda cls, resolver: inspect.getmembers_static(cls)) if legacy else None
    if patcher:
        patcher.start()
    try:
        expected = _runtime_callable_member_items(**arguments)
        started = time.perf_counter()
        profiler.enable()
        for _ in range(repetitions):
            result = _runtime_callable_member_items(**arguments)
        profiler.disable()
        elapsed = (time.perf_counter() - started) * 1000
        assert result == expected
    finally:
        if patcher:
            patcher.stop()
    rows = [{'function': key[2], 'calls': value[1], 'cumulativeMs': value[3] * 1000}
        for key, value in pstats.Stats(profiler).stats.items()
        if key[2] in {'_runtime_callable_member_items', '_workspace_callable_members',
                      'getmembers_static', 'getattr_static', '_getmembers', '_shadowed_dict'}]
    return {'profiledMs': elapsed, 'calls': rows, 'memberNames': [item.name for item in expected]}, expected


def run(repetitions):
    if not settings.configured:
        settings.configure(INSTALLED_APPS=[], SECRET_KEY='member-benchmark')
    django.setup()
    with tempfile.TemporaryDirectory(prefix='djls-member-profile-') as folder:
        path = Path(folder) / 'querysets.py'
        source = ('class LocalBase(QuerySet):\n    def inherited(self) -> "QuerySet":\n        return self\n'
                  '    def hidden(self):\n        return self\n'
                  'class LocalQuerySet(LocalBase):\n    hidden = None\n'
                  '    @property\n    def total(self) -> int:\n        raise AssertionError("Property invoked")\n'
                  '    @staticmethod\n    def count_hint() -> int:\n        return 1\n')
        path.write_text(source)
        namespace = {'QuerySet': QuerySet}
        exec(compile(source, str(path), 'exec'), namespace)
        files = frozenset({str(path.resolve())})
        result = []
        for label, owner in [('DjangoQuerySet', QuerySet), ('LocalQuerySet', namespace['LocalQuerySet'])]:
            before, old_items = sample(owner, files, repetitions, legacy=True)
            after, new_items = sample(owner, files, repetitions)
            assert old_items == new_items
            result.append({'owner': label, 'legacy': before, 'selected': after, 'equivalent': True})
        return {'repetitions': repetitions, 'profiles': result,
            'scope': 'Installed Django QuerySet plus a compiled temporary project subclass. Callable inspection and source/annotation metadata only; no complete surface rebuild, project discovery, RPC, UI or SQL.',
            'note': 'Legacy selector reproduces the previous complete inspect.getmembers_static path; mock dispatch adds small baseline overhead. Shared-host profile timing is not a stable full-RPC improvement percentage.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions), indent=2))
