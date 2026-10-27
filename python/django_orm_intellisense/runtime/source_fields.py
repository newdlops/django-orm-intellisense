"""Lookup metadata from current field declarations, without executing source."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

from ..static_index.indexer import FieldCandidate
from ..static_index.field_declarations import DeclarationContext, ImportedReference, class_declaration_contexts, class_field_contexts, normalize_declaration, source_stat_key
from ..static_index.source_cache import latest_source_cache


@latest_source_cache(maxsize=256, stamp_index=1)
def _source_module(file_path: str, source_stamp: tuple[int, ...], module_name: str) -> tuple[ast.Module, dict[ast.ClassDef, DeclarationContext]]:
    tree = ast.parse(Path(file_path).read_text(encoding='utf-8'))
    return tree, class_declaration_contexts(tree, module_name=module_name,
                                         is_package_init=Path(file_path).name == '__init__.py')


def _reference(node: ast.expr) -> str | None:
    if isinstance(node, ImportedReference):
        return node.qualified
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _reference(node.value)
        return f'{parent}.{node.attr}' if parent else None
    return None


def field_primary_key_from_source(field: FieldCandidate, *, module_name: str) -> bool | None:
    """Read a literal primary-key option without importing Django or user code.

    Reuse the bounded, current-file AST/context cache used for lookup metadata.
    Unknown expressions remain unknown; calls and descriptors are never run.
    """
    unpack = None
    try:
        path = Path(field.file_path)
        tree, contexts = _source_module(field.file_path, source_stat_key(path.stat()), module_name)
        class_name = (field.declared_model_label or field.model_label).rsplit('.', 1)[-1]
        model = next(node for node in contexts if node.name == class_name)
        declaration, context = next((statement.value, context)
            for statement, context in class_field_contexts(model, contexts[model])
            if isinstance(statement, (ast.Assign, ast.AnnAssign))
            and isinstance(statement.value, ast.Call)
            and any(isinstance(target, ast.Name) and target.id == field.name
                for target in (statement.targets if isinstance(statement, ast.Assign) else [statement.target])))
        declaration = normalize_declaration(declaration, context)
        constants = dict(field.imported_constants)

        def resolve(node: ast.expr) -> ast.expr:
            reference = _reference(node)
            if reference:
                root, _, remainder = reference.partition('.')
                root_node = node
                while isinstance(root_node, ast.Attribute):
                    root_node = root_node.value
                qualified = reference if isinstance(root_node, ImportedReference) else (
                    context.aliases.get(root, root) + (f'.{remainder}' if remainder else ''))
                if qualified in constants:
                    return ast.parse(constants[qualified], mode='eval').body
            return node

        def option(node: ast.expr) -> bool | None:
            try:
                value = ast.literal_eval(resolve(node))
                return value if isinstance(value, bool) else None
            except (ValueError, TypeError):
                return None

        def unpack(node: ast.expr, depth: int = 0) -> tuple[bool, bool | None]:
            node = resolve(node)
            if depth >= 16 or not isinstance(node, ast.Dict):
                return True, None
            present, value = False, False
            for key, item in zip(node.keys, node.values):
                if key is None:
                    nested_present, nested_value = unpack(item, depth + 1)
                    if nested_present:
                        present, value = True, nested_value
                elif ast.literal_eval(key) == 'primary_key':
                    present, value = True, option(item)
            return present, value

        primary_key = False
        for keyword in declaration.keywords:
            if keyword.arg == 'primary_key':
                primary_key = option(keyword.value)
            elif keyword.arg is None:
                present, value = unpack(keyword.value)
                if present:
                    primary_key = value
        return primary_key
    except (OSError, SyntaxError, UnicodeError, StopIteration, ValueError, TypeError, AttributeError):
        return None
    finally:
        unpack = None


def field_from_source(field: FieldCandidate, runtime_field: object | None) -> object | None:
    from django.db import models
    from django.db.models.expressions import BaseExpression, Combinable
    evaluate = None
    try:
        path = Path(field.file_path)
        stat = path.stat()
        # The declaration's package can be derived from its indexed filename;
        # imported values themselves are immutable snapshots on FieldCandidate.
        from ..static_index.indexer import _module_name_from_path
        module_name = field.declaration_module or _module_name_from_path(Path('.'), path)
        tree, contexts = _source_module(field.file_path, source_stat_key(stat), module_name)
        class_name = (field.declared_model_label or field.model_label).rsplit('.', 1)[-1]
        model = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
        names = {field.name, getattr(runtime_field, 'name', field.name)}
        declaration, context = next((statement.value, context) for statement, context in class_field_contexts(model, contexts[model])
            if isinstance(statement, (ast.Assign, ast.AnnAssign))
            and isinstance(statement.value, ast.Call)
            and any(isinstance(target, ast.Name) and target.id in names
                for target in (statement.targets if isinstance(statement, ast.Assign) else [statement.target])))
        aliases = context.aliases
        declaration = normalize_declaration(declaration, context)
        constants = dict(field.imported_constants)
        remaining = 4096

        def evaluate(node: ast.expr, depth: int = 0) -> object:
            nonlocal remaining
            remaining -= 1
            if depth > 16 or remaining < 0:
                raise ValueError('Nested field declaration')
            reference = _reference(node)
            if reference:
                root, _, remainder = reference.partition('.')
                root_node = node
                while isinstance(root_node, ast.Attribute):
                    root_node = root_node.value
                qualified = (reference if isinstance(root_node, ImportedReference) else
                    aliases.get(root, root) + (f'.{remainder}' if remainder else ''))
                if qualified in constants:
                    literal = ast.parse(constants[qualified], mode='eval').body
                    remaining -= sum(1 for _ in ast.walk(literal))
                    if remaining < 0:
                        raise ValueError('Imported field option expansion limit')
                    return ast.literal_eval(literal)
            try:
                return ast.literal_eval(node)
            except (ValueError, TypeError):
                pass
            if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
                values = [evaluate(value, depth + 1) for value in node.elts]
                return tuple(values) if isinstance(node, ast.Tuple) else set(values) if isinstance(node, ast.Set) else values
            if isinstance(node, ast.Dict):
                if any(key is None for key in node.keys):
                    raise ValueError('Unpacked field options')
                return {evaluate(key, depth + 1): evaluate(value, depth + 1)
                        for key, value in zip(node.keys, node.values)}
            if not isinstance(node, ast.Call):
                raise ValueError('Non-literal field option')
            reference = _reference(node.func)
            if not reference:
                raise ValueError('Unknown constructor')
            root, _, remainder = reference.partition('.')
            root_node = node.func
            while isinstance(root_node, ast.Attribute):
                root_node = root_node.value
            qualified = reference if isinstance(root_node, ImportedReference) else (
                aliases.get(root, root) + (f'.{remainder}' if remainder else ''))
            module_name, _, name = qualified.rpartition('.')
            constructor = getattr(sys.modules.get(module_name), name, None)
            if (not module_name.startswith('django.') or not isinstance(constructor, type)
                    or not issubclass(constructor, (models.Field, BaseExpression, Combinable))):
                raise ValueError('Unsupported constructor')
            if any(keyword.arg is None for keyword in node.keywords):
                raise ValueError('Unpacked field options')
            return constructor(*(evaluate(value, depth + 1) for value in node.args),
                **{keyword.arg: evaluate(keyword.value, depth + 1) for keyword in node.keywords})

        updated = evaluate(declaration)
        if not isinstance(updated, models.Field):
            return None
        if runtime_field is not None:
            for attribute in ('name', 'attname', 'column', 'model'):
                if hasattr(runtime_field, attribute):
                    setattr(updated, attribute, getattr(runtime_field, attribute))
        if runtime_field is not None and hasattr(runtime_field, 'instance_lookups'):
            updated.instance_lookups = {**runtime_field.instance_lookups, **getattr(updated, 'instance_lookups', {})}
        return updated
    except (OSError, SyntaxError, UnicodeError, StopIteration, ValueError, TypeError, AttributeError):
        return None
    finally:
        evaluate = None
