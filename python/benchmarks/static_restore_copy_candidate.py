"""Candidate-only read-only record hydration without exact-dict copies."""
import importlib.util
import sys
from pathlib import Path

from django_orm_intellisense.static_index import indexer


def candidate_module():
    source = Path(indexer.__file__).read_text()
    calls = [('DefinitionLocation', 'location'), ('ImportBinding', 'binding'),
        ('ModelCandidate', 'candidate'), ('PendingFieldCandidate', 'field'), ('ModuleIndex', 'module_payload')]
    for name, value in calls:
        old = f'{name}.from_dict(dict({value}))'
        new = f'{name}.from_dict({value} if type({value}) is dict else dict({value}))'
        assert old in source
        source = source.replace(old, new)
    name = 'django_orm_intellisense.static_index._restore_copy_candidate'
    spec = importlib.util.spec_from_file_location(name, indexer.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(indexer.__file__) + ':restore_copy', 'exec'), module.__dict__)
    return module
