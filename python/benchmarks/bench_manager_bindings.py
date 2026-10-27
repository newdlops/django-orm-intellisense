"""Profile static manager declaration reuse across one build's receivers."""
from __future__ import annotations

import argparse
import cProfile
import json
import pstats
import tempfile
import time
from pathlib import Path

from django_orm_intellisense.features.orm_members import (
    _manager_binding_definitions, _static_manager_bindings, _with_runtime_source_paths)
from django_orm_intellisense.static_index.indexer import build_static_index


def sample(index, repetitions, shared):
    candidate = index.find_model_candidate('blog.Post')
    @_with_runtime_source_paths
    def build():
        return [_manager_binding_definitions(index, candidate) for _ in range(4)]
    function = build if shared else build.__wrapped__
    expected = function()
    profiler = cProfile.Profile()
    started = time.perf_counter()
    profiler.enable()
    for _ in range(repetitions):
        actual = function()
    profiler.disable()
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert actual == expected
    assert _static_manager_bindings.get() is None
    rows = [{'function': key[2], 'calls': value[1], 'selfMs': value[2] * 1000,
             'cumulativeMs': value[3] * 1000}
            for key, value in pstats.Stats(profiler).stats.items()
            if key[2] in {'_manager_binding_definitions', '_manager_assignment_metadata',
                          '_expression_text', '_parse_class_node', 'unparse'}
            or key[2] == '<built-in method posix.stat>']
    return {'profiledMs': elapsed_ms, 'functions': rows, 'declarations': expected[0]}, expected


def run(repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-manager-binding-') as folder:
        root = Path(folder)
        app = root / 'blog'
        app.mkdir()
        (app / '__init__.py').write_text('')
        common = ('from django.db import models\n'
                  'class PostQuerySet(models.QuerySet):\n    pass\n'
                  'class Post(models.Model):\n' + ''.join(
                      f'    field_{number} = models.CharField(max_length=30)\n' for number in range(15)))
        profiles = []
        for name, suffix in [('DefaultManager', ''), ('TwoDeclaredManagers',
            '    objects = PostQuerySet.as_manager()\n'
            '    active: object = models.Manager.from_queryset(PostQuerySet)()\n')]:
            (app / 'models.py').write_text(common + suffix)
            index = build_static_index(root)
            before, old = sample(index, repetitions, False)
            after, new = sample(index, repetitions, True)
            assert old == new
            profiles.append({'fixture': name, 'legacy': before, 'sharedDeclarations': after, 'equivalent': True})
        return {'repetitions': repetitions, 'profiles': profiles,
                'scope': 'Four static manager declaration inspections per build, 15 scalar fields and zero/two declared managers. Includes source stat checks and AST metadata resolution; excludes complete surface construction, runtime callable inspection, discovery, daemon RPC, editor rendering and SQL.',
                'note': 'Legacy uses the same function without the batch wrapper; no mock dispatch overhead. Profiled wall time includes instrumentation and shared-host scheduling, so no stable full-RPC speedup percentage is inferred.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions), indent=2))
