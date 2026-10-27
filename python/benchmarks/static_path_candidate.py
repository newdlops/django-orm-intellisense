"""Benchmark-only alternate indexer with shared lexical source identities."""
import importlib.util
import sys
from pathlib import Path

from django_orm_intellisense.static_index import indexer

OLD_IDENTITY = '''        try:
            relative_path = python_file.relative_to(root).as_posix()
        except ValueError:
            relative_path = str(python_file)
        module_name = _module_name_from_path(root, python_file)'''

NEW_IDENTITY = '''        parts = python_file.parts
        if (root_parts is not None and len(parts) > len(root_parts) and parts[:len(root_parts)] == root_parts
                and (root_parts or not python_file.anchor)):
            relative_parts = parts[len(root_parts):]
            relative_path = '/'.join(relative_parts) or '.'
            module_parts = relative_parts[:-1]
            if python_file.name != '__init__.py':
                module_parts += (python_file.stem,)
            module_name = '.'.join(module_parts)
        else:
            try:
                relative_path = python_file.relative_to(root).as_posix()
            except ValueError:
                relative_path = str(python_file)
            module_name = _module_name_from_path(root, python_file)'''

ROOT_MARKER = '    source_files = list(python_files) if python_files is not None else iter_python_files(root)'
ROOT_PARTS = "    root_parts = root.parts if os.name == 'posix' else None\n"


def alternate_module(*, previous=False):
    source = Path(indexer.__file__).read_text()
    if previous:
        assert source.count(NEW_IDENTITY) == 1 and ROOT_PARTS in source
        source = source.replace(NEW_IDENTITY, OLD_IDENTITY).replace(ROOT_PARTS, '')
        suffix = 'previous'
    else:
        assert source.count(OLD_IDENTITY) == 1
        source = source.replace('import ast\n', 'import ast\nimport os\n')
        source = source.replace(OLD_IDENTITY, NEW_IDENTITY).replace(ROOT_MARKER, ROOT_PARTS + ROOT_MARKER)
        suffix = 'candidate'
    name = f'django_orm_intellisense.static_index._path_{suffix}'
    spec = importlib.util.spec_from_file_location(name, indexer.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(indexer.__file__) + ':' + suffix, 'exec'), module.__dict__)
    return module
