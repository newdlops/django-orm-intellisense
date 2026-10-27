"""Compare candidate sharing with source-path sharing held constant."""
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
from django_orm_intellisense.features import orm_members


def sample(owner, files, repetitions, shared):
    @orm_members._with_runtime_source_paths
    def build():
        token = None if shared else orm_members._runtime_callable_candidates.set(None)
        try:
            return [orm_members._runtime_callable_member_items(owner_classes=[owner], workspace_files=files,
                receiver_kind=kind, model_label='sample.Post', manager_name='published',
                default_return_kind='queryset') for kind in ('manager', 'queryset', 'related_manager')]
        finally:
            if token is not None:
                orm_members._runtime_callable_candidates.reset(token)
    expected = build()
    profiler = cProfile.Profile()
    started = time.perf_counter()
    profiler.enable()
    for _ in range(repetitions):
        actual = build()
    profiler.disable()
    elapsed = (time.perf_counter() - started) * 1000
    assert actual == expected
    assert orm_members._runtime_callable_candidates.get() is None
    assert orm_members._runtime_source_paths.get() is None
    rows = [{'function': key[2], 'calls': value[1], 'cumulativeMs': value[3] * 1000}
        for key, value in pstats.Stats(profiler).stats.items()
        if key[2] in {'_workspace_callable_candidate_names', '_workspace_callable_members', 'matches',
                      '_callable_member_target', '_runtime_callable_member_items'}]
    return {'profiledMs': elapsed, 'functions': rows,
        'memberNamesByReceiver': [[item.name for item in values] for values in expected]}, expected


def run(repetitions):
    if not settings.configured:
        settings.configure(INSTALLED_APPS=[], SECRET_KEY='candidate-benchmark')
    django.setup()
    with tempfile.TemporaryDirectory(prefix='djls-callable-candidates-') as folder:
        path = Path(folder) / 'querysets.py'
        source = ('class LocalQuerySet(QuerySet):\n    def recent(self) -> "QuerySet":\n        return self\n'
                  '    @property\n    def total(self) -> int:\n        raise AssertionError("Property invoked")\n')
        path.write_text(source)
        namespace = {'QuerySet': QuerySet}
        exec(compile(source, str(path), 'exec'), namespace)
        files = frozenset({str(path.resolve())})
        profiles = []
        for name, owner in [('DjangoQuerySet', QuerySet), ('LocalQuerySet', namespace['LocalQuerySet'])]:
            before, old = sample(owner, files, repetitions, False)
            after, new = sample(owner, files, repetitions, True)
            assert old == new
            profiles.append({'owner': name, 'sourcePathsOnly': before,
                             'sourcePathsAndCandidates': after, 'equivalent': True})
        return {'repetitions': repetitions, 'profiles': profiles,
            'scope': 'Three receiver callable inspections per build with actual installed Django and a compiled local subclass. Both sides share source paths; baseline disables only candidate sharing. Namespace/code guards and live annotation/visibility work are included. Excludes full surface, discovery, RPC, UI and SQL.',
            'note': 'Instrumented wall time depends on host/background activity. No stable complete-RPC speedup claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions), indent=2))
