"""Candidate-only one bounded membership table, original walk/stat unchanged."""
import importlib.util
import sys
from pathlib import Path

from django_orm_intellisense.discovery import workspace


def candidate_module(previous=False):
    source = Path(workspace.__file__).read_text()
    old = '''    expected = {str(path) for path in previous_snapshot.files}
    current = set()'''
    new = '''    expected = dict.fromkeys(map(str, previous_snapshot.files), False)
    observed = 0'''
    old_head, new_head = old, new
    old = '''                    if path not in expected:
                        return None
                    current.add(path)
    return previous_snapshot.files if current == expected else None'''
    new = '''                    seen = expected.get(path)
                    if seen is None:
                        return None
                    if not seen:
                        expected[path] = True
                        observed += 1
    return previous_snapshot.files if observed == len(expected) else None'''
    if old_head in source:
        assert source.count(old_head) == source.count(old) == 1
        if not previous:
            source = source.replace(old_head, new_head).replace(old, new)
    else:
        assert source.count(new_head) == source.count(new) == 1
        if previous:
            source = source.replace(new_head, old_head).replace(new, old)
    name = 'django_orm_intellisense.discovery._inventory_sets_previous' if previous else 'django_orm_intellisense.discovery._inventory_marks_candidate'
    spec = importlib.util.spec_from_file_location(name, workspace.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(workspace.__file__) + ':inventory_marks', 'exec'), module.__dict__)
    return module
