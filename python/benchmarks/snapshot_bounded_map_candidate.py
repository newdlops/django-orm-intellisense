"""Candidate-only bounded submissions around the existing stat batch loop."""
import importlib.util
import sys
from collections import deque
from pathlib import Path

from django_orm_intellisense.discovery import workspace


def bounded_batches(executor, function, offsets, limit):
    pending = deque()
    iterator = iter(offsets)
    exhausted = False
    while pending or not exhausted:
        while not exhausted and len(pending) < limit:
            try:
                offset = next(iterator)
            except StopIteration:
                exhausted = True
                break
            pending.append(executor.submit(function, offset))
        if pending:
            yield pending.popleft().result()


def candidate_module():
    source = Path(workspace.__file__).read_text()
    old = 'for batch in executor.map(_stat_batch, range(0, len(python_files), 64)):'
    new = 'for batch in _bounded_batches(executor, _stat_batch, range(0, len(python_files), 64), max(1, max_workers*2)):'
    assert source.count(old) == 1
    source = source.replace(old, new)
    name = 'django_orm_intellisense.discovery._bounded_stat_candidate'
    spec = importlib.util.spec_from_file_location(name, workspace.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(workspace.__file__) + ':bounded_stat_map', 'exec'), module.__dict__)
    module._bounded_batches = bounded_batches
    return module
