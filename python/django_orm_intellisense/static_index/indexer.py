from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from ..discovery.workspace import iter_python_files


@dataclass(frozen=True)
class StaticIndexSummary:
    python_file_count: int
    package_init_count: int
    reexport_module_count: int
    star_import_count: int
    explicit_all_count: int
    model_candidate_count: int

    def to_dict(self) -> dict[str, int]:
        return {
            'pythonFileCount': self.python_file_count,
            'packageInitCount': self.package_init_count,
            'reexportModuleCount': self.reexport_module_count,
            'starImportCount': self.star_import_count,
            'explicitAllCount': self.explicit_all_count,
            'modelCandidateCount': self.model_candidate_count,
        }


def build_static_index(root: Path) -> StaticIndexSummary:
    python_file_count = 0
    package_init_count = 0
    reexport_module_count = 0
    star_import_count = 0
    explicit_all_count = 0
    model_candidate_count = 0

    for python_file in iter_python_files(root):
        python_file_count += 1

        if python_file.name == '__init__.py':
            package_init_count += 1

        try:
            module = ast.parse(python_file.read_text(encoding='utf-8'))
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue

        module_star_imports = 0
        module_has_explicit_all = False
        module_has_reexport = False

        for node in ast.walk(module):
            if isinstance(node, ast.ImportFrom):
                if any(alias.name == '*' for alias in node.names):
                    module_star_imports += 1

                if python_file.name == '__init__.py':
                    module_has_reexport = True

            if isinstance(node, (ast.Assign, ast.AnnAssign)) and _targets_all(node):
                module_has_explicit_all = True

            if isinstance(node, ast.ClassDef) and _looks_like_model_candidate(node):
                model_candidate_count += 1

        star_import_count += module_star_imports
        explicit_all_count += 1 if module_has_explicit_all else 0

        if python_file.name == '__init__.py' and (
            module_has_reexport or module_has_explicit_all or module_star_imports
        ):
            reexport_module_count += 1

    return StaticIndexSummary(
        python_file_count=python_file_count,
        package_init_count=package_init_count,
        reexport_module_count=reexport_module_count,
        star_import_count=star_import_count,
        explicit_all_count=explicit_all_count,
        model_candidate_count=model_candidate_count,
    )


def _targets_all(node: ast.Assign | ast.AnnAssign) -> bool:
    if isinstance(node, ast.Assign):
        return any(isinstance(target, ast.Name) and target.id == '__all__' for target in node.targets)

    return isinstance(node.target, ast.Name) and node.target.id == '__all__'


def _looks_like_model_candidate(node: ast.ClassDef) -> bool:
    return any(_is_model_base(base) for base in node.bases)


def _is_model_base(expression: ast.expr) -> bool:
    dotted_name = _dotted_name(expression)
    return dotted_name.endswith('models.Model') or dotted_name.endswith('.Model') or dotted_name == 'Model'


def _dotted_name(expression: ast.expr) -> str:
    if isinstance(expression, ast.Name):
        return expression.id

    if isinstance(expression, ast.Attribute):
        prefix = _dotted_name(expression.value)
        return f'{prefix}.{expression.attr}' if prefix else expression.attr

    if isinstance(expression, ast.Subscript):
        return _dotted_name(expression.value)

    return ''
