"""Small source declarations; no ASTs or resolved import owners are retained."""
from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass
from functools import lru_cache
from typing import NamedTuple

from .source_coordinates import prepare_source_columns, source_column


class FunctionDeclaration(NamedTuple):
    name: str
    member_kind: str
    detail: str
    annotation: str
    line: int
    column: int


class ManagerCall(NamedTuple):
    function: str
    nested_function: str | None
    queryset_symbol: str | None


class AssignmentDeclaration(NamedTuple):
    name: str
    call: ManagerCall | None
    line: int
    column: int


class BaseDeclaration(NamedTuple):
    expression: str
    from_queryset: bool
    queryset_symbol: str | None


class ClassDeclaration(NamedTuple):
    functions: tuple[FunctionDeclaration, ...]
    assignments: tuple[AssignmentDeclaration, ...]
    bases: tuple[BaseDeclaration, ...]


def expression_text(expression):
    if expression is None:
        return ''
    try:
        return ast.unparse(expression)
    except Exception:
        return ''


def member_source_hash(text: str) -> str:
    # Cold reads use universal newlines; reindex reads decode the original bytes.
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')
    return hashlib.blake2s(normalized.encode('utf-8'), digest_size=16).hexdigest()


@lru_cache(maxsize=256)
def _shared_manager_call(function, nested_function, queryset_symbol):
    # Only small immutable strings are shared; source trees/indexes/classes
    # never enter this bounded cache. Pickle preserves the shared identities.
    return ManagerCall(function, nested_function, queryset_symbol)


def make_manager_call(function, nested_function, queryset_symbol):
    values = function, nested_function, queryset_symbol
    if all(value is None or type(value) is str and len(value) <= 256 for value in values):
        return _shared_manager_call(*values)
    return ManagerCall(*values)


@lru_cache(maxsize=256)
def _shared_assignment(name, call, line, column):
    return AssignmentDeclaration(name, call, line, column)


def make_assignment_declaration(name, call, line, column):
    # Share only primitive facts. Module resolution and file ownership stay
    # with the consumer; string subclasses may carry arbitrary owners.
    if (type(name) is str and len(name) <= 256
            and type(line) is int and 0 < line < 2**31
            and type(column) is int and 0 < column < 2**31
            and (call is None or type(call) is ManagerCall
                and all(value is None or type(value) is str and len(value) <= 256 for value in call))):
        return _shared_assignment(name, call, line, column)
    return AssignmentDeclaration(name, call, line, column)


def manager_call(expression) -> ManagerCall | None:
    if not isinstance(expression, ast.Call):
        return None
    nested = expression.func if isinstance(expression.func, ast.Call) else None
    return make_manager_call(expression_text(expression.func),
        expression_text(nested.func) if nested is not None else None,
        expression_text(nested.args[0]).split('.')[-1] if nested is not None and nested.args else None)


def class_declaration(node: ast.ClassDef) -> ClassDeclaration:
    functions, assignments, bases = [], [], []
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and not child.name.startswith('_'):
            decorators = {expression_text(value).split('.')[-1] for value in child.decorator_list}
            detail = ('Django model property' if 'property' in decorators else
                'Django static method' if 'staticmethod' in decorators else
                'Django class method' if 'classmethod' in decorators else 'Django method')
            functions.append(FunctionDeclaration(child.name, 'property' if 'property' in decorators else 'method',
                detail, expression_text(child.returns), child.lineno, source_column(child)))
        target = value = None
        if isinstance(child, ast.Assign) and len(child.targets) == 1 and isinstance(child.targets[0], ast.Name):
            target, value = child.targets[0].id, child.value
        elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
            target, value = child.target.id, child.value
        if target is not None and value is not None:
            assignments.append(make_assignment_declaration(target, manager_call(value), child.lineno, source_column(child)))
    for base in node.bases:
        from_queryset = isinstance(base, ast.Call) and expression_text(base.func).endswith('.from_queryset')
        bases.append(BaseDeclaration(expression_text(base), from_queryset,
            expression_text(base.args[0]).split('.')[-1] if from_queryset and base.args else None))
    return ClassDeclaration(tuple(functions), tuple(assignments), tuple(bases))


@dataclass(frozen=True, slots=True)
class SourceMemberDeclarations:
    source_hash: str
    classes: dict[str, ClassDeclaration]

    @classmethod
    def from_source(cls, tree: ast.Module, text: str | None):
        if text is None:
            return None
        prepare_source_columns(tree, text)
        classes = {}
        # Match the original member parser: first direct class wins, with no
        # nested/TYPE_CHECKING class promoted into the module namespace.
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name not in classes:
                classes[node.name] = class_declaration(node)
        return cls(member_source_hash(text), classes) if classes else None

    def to_dict(self):
        return {'sourceHash': self.source_hash, 'classes': {
            name: [
                [list(function) for function in declaration.functions],
                [[assignment.name, list(assignment.call) if assignment.call is not None else None,
                    assignment.line, assignment.column] for assignment in declaration.assignments],
                [list(base) for base in declaration.bases],
            ] for name, declaration in self.classes.items()}}

    @classmethod
    def from_dict(cls, payload):
        # Validate each declaration as it is hydrated. Keep the complete
        # optional-record contract: a malformed value falls back to parsing
        # source, rather than being replaced by an empty or partial class.
        if not isinstance(payload, dict) or set(payload) != {'sourceHash', 'classes'}:
            return None
        digest, raw_classes = payload['sourceHash'], payload['classes']
        if not isinstance(digest, str) or len(digest) != 32 or any(c not in '0123456789abcdef' for c in digest):
            return None
        if not isinstance(raw_classes, dict):
            return None
        classes = {}
        try:
            for name, raw in raw_classes.items():
                if not isinstance(name, str) or not isinstance(raw, (list, tuple)) or len(raw) != 3:
                    return None
                functions = []
                for value in raw[0]:
                    item = FunctionDeclaration(*value)
                    if (not isinstance(item.name, str) or not isinstance(item.member_kind, str)
                            or not isinstance(item.detail, str) or not isinstance(item.annotation, str)
                            or item.member_kind not in {'method', 'property'}
                            or type(item.line) is not int or type(item.column) is not int):
                        return None
                    functions.append(item)
                assignments = []
                for value in raw[1]:
                    if not isinstance(value, (list, tuple)) or len(value) != 4:
                        return None
                    member, raw_call, line, column = value
                    if not isinstance(member, str) or type(line) is not int or type(column) is not int:
                        return None
                    call, share_call = None, True
                    if raw_call is not None:
                        if not isinstance(raw_call, (list, tuple)) or len(raw_call) != 3:
                            return None
                        function, nested, queryset = raw_call
                        if (not isinstance(function, str)
                                or nested is not None and not isinstance(nested, str)
                                or queryset is not None and not isinstance(queryset, str)):
                            return None
                        share_call = (type(function) is str and len(function) <= 256
                            and (nested is None or type(nested) is str and len(nested) <= 256)
                            and (queryset is None or type(queryset) is str and len(queryset) <= 256))
                        call = (_shared_manager_call(function, nested, queryset) if share_call
                            else ManagerCall(function, nested, queryset))
                    # Inputs above are already validated. Preserve the same
                    # primitive/size/location pool bounds without asking both
                    # public factories to validate these values again.
                    shared = (share_call and type(member) is str and len(member) <= 256
                        and 0 < line < 2**31 and 0 < column < 2**31)
                    assignments.append(_shared_assignment(member, call, line, column) if shared
                        else AssignmentDeclaration(member, call, line, column))
                bases = []
                for value in raw[2]:
                    item = BaseDeclaration(*value)
                    if (not isinstance(item.expression, str) or type(item.from_queryset) is not bool
                            or item.queryset_symbol is not None and not isinstance(item.queryset_symbol, str)):
                        return None
                    bases.append(item)
                classes[name] = ClassDeclaration(tuple(functions), tuple(assignments), tuple(bases))
        except (TypeError, ValueError, IndexError, KeyError):
            return None
        return cls(digest, classes)
