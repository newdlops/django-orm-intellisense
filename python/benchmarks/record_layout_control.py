"""Benchmark-only import transform for the previous unslotted record layout."""
import ast
import importlib.machinery
import sys

MODULES = {
    'django_orm_intellisense.discovery.workspace',
    'django_orm_intellisense.static_index.indexer',
    'django_orm_intellisense.runtime.inspector',
    'django_orm_intellisense.semantic.graph',
}


class PreviousLayoutLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):
        path = self.get_filename(fullname)
        tree = ast.parse(self.get_data(path), filename=path)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                # The previous dict layout used normal object pickle state,
                # before the compact record tuple methods were introduced.
                if any(isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name)
                       and decorator.func.id == 'dataclass'
                       and any(keyword.arg == 'slots' for keyword in decorator.keywords)
                       for decorator in node.decorator_list):
                    node.body = [child for child in node.body
                                 if not (isinstance(child, ast.FunctionDef)
                                         and child.name in {'__getstate__', '__setstate__'})]
                for decorator in node.decorator_list:
                    if (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name)
                            and decorator.func.id == 'dataclass'):
                        decorator.keywords = [keyword for keyword in decorator.keywords
                                              if keyword.arg != 'slots']
        return compile(tree, path, 'exec')


class PreviousLayoutFinder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname not in MODULES:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec and type(spec.loader) is importlib.machinery.SourceFileLoader:
            spec.loader = PreviousLayoutLoader(fullname, spec.origin)
        return spec


def install_previous_layout():
    assert not any(name in sys.modules for name in MODULES), 'Record modules already imported'
    finder = PreviousLayoutFinder()
    position = sys.meta_path.index(importlib.machinery.PathFinder)
    sys.meta_path.insert(position, finder)
    return finder
