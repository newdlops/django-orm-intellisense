from __future__ import annotations

import ast
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..runtime.inspector import RuntimeInspection, RuntimeModelSummary
from ..static_index.indexer import (
    FieldCandidate,
    ModelCandidate,
    ModuleIndex,
    StaticIndex,
)

DEFAULT_STUB_RELATIVE_ROOT = '.django_orm_intellisense/stubs'
STUB_SCHEMA_VERSION = 2
STUB_VERSION_FILE = '.stub-version'
SUPPORT_STUB_FILE = '_django_orm_intellisense_support.pyi'
SUPPORT_STUB_CONTENT = """from __future__ import annotations
from typing import Any, Generic, Iterator, TypeVar

_ModelT = TypeVar('_ModelT')
_QuerySetT = TypeVar('_QuerySetT', bound='DjangoQuerySet[Any]')
_RelatedManagerT = TypeVar('_RelatedManagerT', bound='DjangoRelatedManager[Any]')

class DjangoQuerySet(Generic[_ModelT]):
    def __iter__(self) -> Iterator[_ModelT]: ...
    def all(self: _QuerySetT) -> _QuerySetT: ...
    def filter(self: _QuerySetT, *args: Any, **kwargs: Any) -> _QuerySetT: ...
    def exclude(self: _QuerySetT, *args: Any, **kwargs: Any) -> _QuerySetT: ...
    def get(self, *args: Any, **kwargs: Any) -> _ModelT: ...
    def create(self, *args: Any, **kwargs: Any) -> _ModelT: ...
    def first(self) -> _ModelT | None: ...
    def last(self) -> _ModelT | None: ...
    def order_by(self: _QuerySetT, *fields: str) -> _QuerySetT: ...
    def select_related(self: _QuerySetT, *fields: str) -> _QuerySetT: ...
    def prefetch_related(self: _QuerySetT, *lookups: str) -> _QuerySetT: ...
    def only(self: _QuerySetT, *fields: str) -> _QuerySetT: ...
    def defer(self: _QuerySetT, *fields: str) -> _QuerySetT: ...
    def values(self, *fields: str, **expressions: Any) -> DjangoQuerySet[dict[str, Any]]: ...
    def values_list(self, *fields: str, flat: bool = False, named: bool = False) -> DjangoQuerySet[Any]: ...
    def count(self) -> int: ...
    def exists(self) -> bool: ...

class DjangoManager(DjangoQuerySet[_ModelT], Generic[_ModelT]):
    def get_queryset(self) -> DjangoQuerySet[_ModelT]: ...

class DjangoRelatedManager(DjangoManager[_ModelT], Generic[_ModelT]):
    ...
"""


@dataclass(frozen=True)
class PylanceStubGenerationSummary:
    root_path: str
    relative_root: str
    file_count: int
    module_count: int
    package_count: int
    generated_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            'rootPath': self.root_path,
            'relativeRoot': self.relative_root,
            'fileCount': self.file_count,
            'moduleCount': self.module_count,
            'packageCount': self.package_count,
            'generatedAt': self.generated_at,
        }


def generate_pylance_stubs(
    *,
    workspace_root: Path,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> PylanceStubGenerationSummary:
    stub_root = workspace_root / DEFAULT_STUB_RELATIVE_ROOT
    runtime_models = {model.label: model for model in runtime.model_catalog}
    generated_relative_paths: set[str] = set()
    top_level_packages: set[str] = set()

    _initialize_stub_root(stub_root)
    _write_text_if_changed(stub_root / SUPPORT_STUB_FILE, SUPPORT_STUB_CONTENT)
    generated_relative_paths.add(SUPPORT_STUB_FILE)
    generated_relative_paths.add(STUB_VERSION_FILE)

    for module_name, module_index in sorted(static_index.modules.items()):
        source_path = Path(module_index.file_path)
        relative_source_path = source_path.relative_to(workspace_root).as_posix()
        stub_relative_path = _stub_relative_path(relative_source_path)
        stub_text = _render_module_stub(
            source_path=source_path,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
            runtime_models=runtime_models,
        )
        _write_text_if_changed(stub_root / stub_relative_path, stub_text)
        generated_relative_paths.add(stub_relative_path)

        stub_parts = Path(stub_relative_path).parts
        if len(stub_parts) > 1:
            top_level_packages.add(stub_parts[0])

    for package_name in sorted(top_level_packages):
        py_typed_relative_path = f'{package_name}/py.typed'
        _write_text_if_changed(stub_root / py_typed_relative_path, 'partial\n')
        generated_relative_paths.add(py_typed_relative_path)

    _remove_stale_stub_files(stub_root, generated_relative_paths)

    return PylanceStubGenerationSummary(
        root_path=str(stub_root),
        relative_root=DEFAULT_STUB_RELATIVE_ROOT,
        file_count=len(generated_relative_paths),
        module_count=len(static_index.modules),
        package_count=len(top_level_packages),
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


def _render_module_stub(
    *,
    source_path: Path,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    runtime_models: dict[str, RuntimeModelSummary],
) -> str:
    try:
        source_text = source_path.read_text(encoding='utf-8')
        parsed_module = ast.parse(source_text)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return _render_fallback_module_stub(module_index)

    model_candidates = {
        candidate.object_name: candidate
        for candidate in module_index.model_candidates
    }
    lines = ['from __future__ import annotations']
    lines.extend(
        _dedupe_import_lines(
            [
                *_generated_import_lines(
                    module_name=module_name,
                    module_index=module_index,
                    static_index=static_index,
                    runtime_models=runtime_models,
                ),
                *_render_top_level_imports(parsed_module),
            ]
        )
    )

    rendered_body: list[str] = []
    for node in parsed_module.body:
        rendered = _render_top_level_node(
            node=node,
            module_name=module_name,
            model_candidates=model_candidates,
            static_index=static_index,
            runtime_models=runtime_models,
        )
        if rendered:
            rendered_body.append(rendered)

    if rendered_body:
        lines.append('')
        lines.append('\n\n'.join(rendered_body))

    return '\n'.join(lines).rstrip() + '\n'


def _render_fallback_module_stub(module_index: ModuleIndex) -> str:
    lines = [
        'from __future__ import annotations',
        'from typing import Any',
    ]
    body: list[str] = []

    for binding in module_index.import_bindings:
        rendered_import = _render_import_binding(binding)
        if rendered_import:
            body.append(rendered_import)

    for symbol in sorted(module_index.defined_symbols):
        body.append(f'{symbol}: Any')

    if body:
        lines.append('')
        lines.append('\n'.join(body))

    return '\n'.join(lines).rstrip() + '\n'


def _generated_import_lines(
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    runtime_models: dict[str, RuntimeModelSummary],
) -> list[str]:
    import_lines = ['from typing import Any']
    if any(
        _manager_names_for_model(candidate, runtime_models.get(candidate.label))
        for candidate in module_index.model_candidates
    ):
        import_lines[0] = 'from typing import Any, ClassVar'

    field_kinds = {
        field.field_kind
        for candidate in module_index.model_candidates
        for field in static_index.fields_for_model(candidate.label)
    }

    import_lines.append(
        'from _django_orm_intellisense_support import DjangoManager, DjangoQuerySet, DjangoRelatedManager'
    )

    if {'DateField', 'DateTimeField', 'TimeField', 'DurationField'} & field_kinds:
        import_lines.append('from datetime import date, datetime, time, timedelta')
    if 'DecimalField' in field_kinds:
        import_lines.append('from decimal import Decimal')
    if 'UUIDField' in field_kinds:
        import_lines.append('from uuid import UUID')

    import_lines.extend(
        _module_related_model_import_lines(
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
        )
    )
    import_lines.extend(
        _support_model_import_lines(
            module_name=module_name,
            static_index=static_index,
            class_nodes=parsed_module_classes(module_index.file_path),
        )
    )
    import_lines.extend(
        _inferred_return_model_import_lines(
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
        )
    )
    return import_lines


def _render_top_level_imports(parsed_module: ast.Module) -> list[str]:
    rendered_imports: list[str] = []
    seen_imports: set[str] = set()

    for node in parsed_module.body:
        rendered_import = _render_import_node(node)
        if rendered_import is None or rendered_import in seen_imports:
            continue
        rendered_imports.append(rendered_import)
        seen_imports.add(rendered_import)

    return rendered_imports


def _render_top_level_node(
    *,
    node: ast.stmt,
    module_name: str,
    model_candidates: dict[str, ModelCandidate],
    static_index: StaticIndex,
    runtime_models: dict[str, RuntimeModelSummary],
) -> str | None:
    if isinstance(node, ast.ClassDef):
        model_candidate = model_candidates.get(node.name)
        return _render_class_stub(
            class_node=node,
            module_name=module_name,
            module_index=static_index.modules[module_name],
            model_candidate=model_candidate,
            static_index=static_index,
            runtime_model=runtime_models.get(model_candidate.label)
            if model_candidate is not None
            else None,
        )

    if isinstance(node, ast.FunctionDef):
        return _render_function_stub(
            node,
            indent='',
            module_name=module_name,
            module_index=static_index.modules[module_name],
            static_index=static_index,
        )

    if isinstance(node, ast.AsyncFunctionDef):
        return _render_function_stub(
            node,
            indent='',
            is_async=True,
            module_name=module_name,
            module_index=static_index.modules[module_name],
            static_index=static_index,
        )

    if isinstance(node, ast.Assign):
        rendered_assignments = [
            f'{target.id}: Any'
            for target in node.targets
            if isinstance(target, ast.Name)
        ]
        return '\n'.join(rendered_assignments) if rendered_assignments else None

    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return f'{node.target.id}: Any'

    return None


def _render_class_stub(
    *,
    class_node: ast.ClassDef,
    module_name: str,
    module_index: ModuleIndex,
    model_candidate: ModelCandidate | None,
    static_index: StaticIndex,
    runtime_model: RuntimeModelSummary | None,
) -> str:
    header = _render_class_header(
        class_node,
        model_candidate,
        module_name=module_name,
        static_index=static_index,
    )
    body_lines: list[str] = []
    seen_names: set[str] = set()

    if model_candidate is not None:
        manager_type_overrides = _manager_type_overrides_for_model_class(
            class_node,
            model_candidate=model_candidate,
        )
        for attribute_line in _render_model_attributes(
            class_node=class_node,
            module_name=module_name,
            model_candidate=model_candidate,
            static_index=static_index,
            runtime_model=runtime_model,
            manager_type_overrides=manager_type_overrides,
        ):
            attribute_name = attribute_line.split(':', 1)[0].strip()
            if attribute_name in seen_names:
                continue
            seen_names.add(attribute_name)
            body_lines.append(attribute_line)

    for child in class_node.body:
        rendered_child, child_name = _render_class_child(
            child,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
            class_node=class_node,
        )
        if rendered_child is None:
            continue
        if child_name is not None:
            if child_name in seen_names:
                continue
            seen_names.add(child_name)
        body_lines.append(rendered_child)

    if not body_lines:
        body_lines.append('...')

    indented_body: list[str] = []
    for body_line in body_lines:
        indented_body.append(_indent_block(body_line))

    return '\n'.join([header, *indented_body])


def _render_model_attributes(
    *,
    class_node: ast.ClassDef,
    module_name: str,
    model_candidate: ModelCandidate,
    static_index: StaticIndex,
    runtime_model: RuntimeModelSummary | None,
    manager_type_overrides: dict[str, str],
) -> list[str]:
    attributes: list[str] = []

    fields = sorted(
        static_index.fields_for_model(model_candidate.label),
        key=lambda field: (field.line, field.column, field.name),
    )
    for field in fields:
        attributes.append(
            f'{field.name}: {_field_annotation(field, static_index=static_index, module_name=module_name)}'
        )

    manager_names = _manager_names_for_model(model_candidate, runtime_model)
    for manager_name in manager_names:
        manager_type = manager_type_overrides.get(
            manager_name,
            f'DjangoManager[{model_candidate.object_name}]',
        )
        attributes.append(
            f'{manager_name}: ClassVar[{manager_type}]'
        )

    return attributes


def _field_annotation(
    field: FieldCandidate,
    *,
    static_index: StaticIndex,
    module_name: str,
) -> str:
    relation_annotation = _relation_field_annotation(
        field,
        static_index=static_index,
        module_name=module_name,
    )
    if relation_annotation is not None:
        return relation_annotation

    simple_types = {
        'AutoField': 'int',
        'BigAutoField': 'int',
        'BigIntegerField': 'int',
        'BinaryField': 'bytes',
        'BooleanField': 'bool',
        'CharField': 'str',
        'DateField': 'date',
        'DateTimeField': 'datetime',
        'DecimalField': 'Decimal',
        'DurationField': 'timedelta',
        'EmailField': 'str',
        'FileField': 'str',
        'FilePathField': 'str',
        'FloatField': 'float',
        'GenericIPAddressField': 'str',
        'ImageField': 'str',
        'IntegerField': 'int',
        'JSONField': 'Any',
        'PositiveIntegerField': 'int',
        'PositiveSmallIntegerField': 'int',
        'SmallAutoField': 'int',
        'SmallIntegerField': 'int',
        'SlugField': 'str',
        'TextField': 'str',
        'TimeField': 'time',
        'URLField': 'str',
        'UUIDField': 'UUID',
    }
    return simple_types.get(field.field_kind, 'Any')


def _manager_names_for_model(
    model_candidate: ModelCandidate,
    runtime_model: RuntimeModelSummary | None,
) -> list[str]:
    if runtime_model is not None and runtime_model.manager_names:
        return sorted(dict.fromkeys(runtime_model.manager_names))

    if model_candidate.is_abstract:
        return []

    return ['objects']


def _render_class_child(
    child: ast.stmt,
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef,
) -> tuple[str | None, str | None]:
    if isinstance(child, ast.FunctionDef):
        return (
            _render_method_stub(
                child,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
                class_node=class_node,
            ),
            child.name,
        )

    if isinstance(child, ast.AsyncFunctionDef):
        return (
            _render_method_stub(
                child,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
                class_node=class_node,
                is_async=True,
            ),
            child.name,
        )

    if isinstance(child, ast.Assign):
        if len(child.targets) != 1 or not isinstance(child.targets[0], ast.Name):
            return None, None
        return f'{child.targets[0].id}: Any', child.targets[0].id

    if isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
        return f'{child.target.id}: Any', child.target.id

    if isinstance(child, ast.ClassDef):
        return f'class {child.name}: ...', child.name

    return None, None


def _render_method_stub(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None = None,
    is_async: bool = False,
) -> str:
    decorators = _method_decorator_lines(node.decorator_list)
    signature = _callable_signature(node.args)
    return_annotation = _callable_return_annotation(
        node,
        module_name=module_name,
        module_index=module_index,
        static_index=static_index,
        class_node=class_node,
    )
    method_prefix = 'async def' if is_async else 'def'
    rendered = [
        *decorators,
        f'{method_prefix} {node.name}({signature}) -> {return_annotation}: ...',
    ]
    return '\n'.join(rendered)


def _render_function_stub(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    indent: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    is_async: bool = False,
) -> str:
    signature = _callable_signature(node.args)
    return_annotation = _callable_return_annotation(
        node,
        module_name=module_name,
        module_index=module_index,
        static_index=static_index,
    )
    prefix = 'async def' if is_async else 'def'
    return f'{indent}{prefix} {node.name}({signature}) -> {return_annotation}: ...'


def _callable_signature(arguments: ast.arguments) -> str:
    parts: list[str] = []
    positional = [*arguments.posonlyargs, *arguments.args]
    positional_defaults = [None] * (len(positional) - len(arguments.defaults)) + list(
        arguments.defaults
    )
    for argument, default in zip(positional, positional_defaults):
        parts.append(
            _render_argument(argument, default=default, include_default=default is not None)
        )

    if arguments.vararg is not None:
        parts.append(f'*{_render_argument(arguments.vararg)}')
    elif arguments.kwonlyargs:
        parts.append('*')

    for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults):
        parts.append(
            _render_argument(argument, default=default, include_default=default is not None)
        )

    if arguments.kwarg is not None:
        parts.append(f'**{_render_argument(arguments.kwarg)}')

    if not parts:
        return ''

    return ', '.join(parts)


def _method_decorator_lines(decorators: list[ast.expr]) -> list[str]:
    lines: list[str] = []
    for decorator in decorators:
        decorator_name = _dotted_name(decorator)
        if decorator_name in {'classmethod', 'staticmethod', 'property'}:
            lines.append(f'@{decorator_name}')
        elif decorator_name.endswith('.cached_property'):
            lines.append('@property')
    return lines


def _render_import_node(node: ast.stmt) -> str | None:
    if isinstance(node, ast.Import):
        rendered_names = []
        for alias in node.names:
            rendered = alias.name
            if alias.asname:
                rendered += f' as {alias.asname}'
            rendered_names.append(rendered)
        return f'import {", ".join(rendered_names)}'

    if isinstance(node, ast.ImportFrom):
        module_name = '.' * node.level + (node.module or '')
        rendered_names = []
        for alias in node.names:
            rendered = alias.name
            if alias.asname:
                rendered += f' as {alias.asname}'
            rendered_names.append(rendered)
        return f'from {module_name} import {", ".join(rendered_names)}'

    return None


def _render_import_binding(binding: object) -> str | None:
    module = getattr(binding, 'module', None)
    symbol = getattr(binding, 'symbol', None)
    alias = getattr(binding, 'alias', None)
    is_star = getattr(binding, 'is_star', None)

    if module is None or alias is None or is_star is None:
        return None

    if is_star:
        return f'from {module} import *'

    if symbol is None:
        rendered = f'import {module}'
        if alias != module.split('.', 1)[0]:
            rendered += f' as {alias}'
        return rendered

    rendered = f'from {module} import {symbol}'
    if alias != symbol:
        rendered += f' as {alias}'
    return rendered


def _render_class_header(
    class_node: ast.ClassDef,
    model_candidate: ModelCandidate | None,
    *,
    module_name: str,
    static_index: StaticIndex,
) -> str:
    if model_candidate is not None:
        bases = [
            _expression_text(base) for base in class_node.bases if _expression_text(base)
        ]
    elif _looks_like_manager_class(class_node):
        model_name = _model_name_from_container_class_name(class_node.name, 'Manager')
        bases = []
        queryset_name = _queryset_name_from_manager_base(class_node)
        if queryset_name is not None:
            bases.append(queryset_name)
        if model_name is not None:
            bases.append(f'DjangoManager[{model_name}]')
    elif _looks_like_queryset_class(class_node):
        model_name = _model_name_from_container_class_name(class_node.name, 'QuerySet')
        bases = [f'DjangoQuerySet[{model_name}]'] if model_name else []
    else:
        bases = [
            _expression_text(base) for base in class_node.bases if _expression_text(base)
        ]

    if not bases and model_candidate is not None:
        bases = ['models.Model']
    if bases:
        return f'class {class_node.name}({", ".join(bases)}):'
    return f'class {class_node.name}:'


def _dotted_name(expression: ast.expr) -> str:
    if isinstance(expression, ast.Name):
        return expression.id
    if isinstance(expression, ast.Attribute):
        prefix = _dotted_name(expression.value)
        return f'{prefix}.{expression.attr}' if prefix else expression.attr
    if isinstance(expression, ast.Subscript):
        return _dotted_name(expression.value)
    return ''


def _expression_text(expression: ast.expr | None) -> str:
    if expression is None:
        return ''

    try:
        return ast.unparse(expression)
    except Exception:
        return _dotted_name(expression)


def _callable_return_annotation(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None = None,
) -> str:
    if node.returns is None:
        inferred = _infer_callable_return_annotation(
            node,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
            class_node=class_node,
            visited=set(),
        )
        return inferred or 'Any'

    return _expression_text(node.returns) or 'Any'


def _render_argument(
    argument: ast.arg,
    *,
    default: ast.expr | None = None,
    include_default: bool = False,
) -> str:
    rendered = argument.arg
    if argument.arg not in {'self', 'cls'}:
        rendered += f': {_expression_text(argument.annotation) or "Any"}'
    elif argument.annotation is not None:
        rendered += f': {_expression_text(argument.annotation) or "Any"}'

    if include_default:
        rendered += ' = ...'

    return rendered


def _indent_block(block: str) -> str:
    return '\n'.join(f'    {line}' if line else '' for line in block.splitlines())


def _looks_like_queryset_class(class_node: ast.ClassDef) -> bool:
    return any(
        (_expression_text(base) or '').endswith('QuerySet')
        or (_expression_text(base) or '').endswith('.QuerySet')
        for base in class_node.bases
    )


def _looks_like_manager_class(class_node: ast.ClassDef) -> bool:
    return any('Manager' in (_expression_text(base) or '') for base in class_node.bases)


def _model_name_from_container_class_name(
    class_name: str,
    suffix: str,
) -> str | None:
    if not class_name.endswith(suffix):
        return None

    model_name = class_name[: -len(suffix)]
    return model_name or None


def _manager_type_overrides_for_model_class(
    class_node: ast.ClassDef,
    *,
    model_candidate: ModelCandidate,
) -> dict[str, str]:
    overrides: dict[str, str] = {}

    for child in class_node.body:
        target_name: str | None = None
        value_node: ast.expr | None = None
        if isinstance(child, ast.Assign) and len(child.targets) == 1:
            target = child.targets[0]
            if isinstance(target, ast.Name):
                target_name = target.id
                value_node = child.value
        elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
            target_name = child.target.id
            value_node = child.value

        if target_name is None or value_node is None or not isinstance(value_node, ast.Call):
            continue

        manager_type = _manager_type_from_call(
            value_node,
            model_name=model_candidate.object_name,
        )
        if manager_type is None:
            continue

        overrides[target_name] = manager_type

    return overrides


def _manager_type_from_call(
    node: ast.Call,
    *,
    model_name: str,
) -> str | None:
    function_text = _expression_text(node.func)
    if not function_text:
        return None

    function_tail = function_text.split('.')[-1]
    if function_text.endswith('.as_manager'):
        return f'DjangoManager[{model_name}]'

    if function_tail.endswith('Manager') or function_tail == 'Manager':
        if function_tail == 'Manager':
            return f'DjangoManager[{model_name}]'
        return function_tail

    return None


def parsed_module_classes(file_path: str) -> list[ast.ClassDef]:
    try:
        parsed_module = ast.parse(Path(file_path).read_text(encoding='utf-8'))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []

    return [
        node
        for node in parsed_module.body
        if isinstance(node, ast.ClassDef)
    ]


def _support_model_import_lines(
    *,
    module_name: str,
    static_index: StaticIndex,
    class_nodes: list[ast.ClassDef],
) -> list[str]:
    import_lines: list[str] = []
    seen_imports: set[str] = set()
    app_label = module_name.split('.', 1)[0]

    for class_node in class_nodes:
        model_name: str | None = None
        if class_node.name.endswith('QuerySet'):
            model_name = _model_name_from_container_class_name(class_node.name, 'QuerySet')
        elif class_node.name.endswith('Manager'):
            model_name = _model_name_from_container_class_name(class_node.name, 'Manager')

        if model_name is None:
            continue

        matching_candidate = next(
            (
                candidate
                for candidate in static_index.concrete_model_candidates
                if candidate.app_label == app_label
                and candidate.object_name == model_name
                and candidate.module != module_name
            ),
            None,
        )
        if matching_candidate is None:
            continue

        import_line = f'from {matching_candidate.module} import {matching_candidate.object_name}'
        if import_line in seen_imports:
            continue
        seen_imports.add(import_line)
        import_lines.append(import_line)

    return import_lines


def _inferred_return_model_import_lines(
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> list[str]:
    parsed_module = _parse_module_ast(module_index.file_path)
    if parsed_module is None:
        return []

    import_lines: list[str] = []
    seen_imports: set[str] = set()

    for node in parsed_module.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            annotation = _callable_return_annotation(
                node,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
            )
            for import_line in _model_import_lines_for_annotation(
                annotation,
                module_name=module_name,
                static_index=static_index,
            ):
                if import_line in seen_imports:
                    continue
                seen_imports.add(import_line)
                import_lines.append(import_line)
            continue

        if not isinstance(node, ast.ClassDef):
            continue

        for child in node.body:
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue

            annotation = _callable_return_annotation(
                child,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
                class_node=node,
            )
            for import_line in _model_import_lines_for_annotation(
                annotation,
                module_name=module_name,
                static_index=static_index,
            ):
                if import_line in seen_imports:
                    continue
                seen_imports.add(import_line)
                import_lines.append(import_line)

    return import_lines


def _model_import_lines_for_annotation(
    annotation: str,
    *,
    module_name: str,
    static_index: StaticIndex,
) -> list[str]:
    import_lines: list[str] = []
    app_label = module_name.split('.', 1)[0]
    for model_name in _model_names_from_annotation(annotation):
        matching_candidate = next(
            (
                candidate
                for candidate in static_index.concrete_model_candidates
                if candidate.object_name == model_name
                and candidate.module != module_name
                and candidate.app_label == app_label
            ),
            None,
        )
        if matching_candidate is None:
            matching_candidate = next(
                (
                    candidate
                    for candidate in static_index.concrete_model_candidates
                    if candidate.object_name == model_name
                    and candidate.module != module_name
                ),
                None,
            )
        if matching_candidate is None:
            continue

        import_lines.append(
            f'from {matching_candidate.module} import {matching_candidate.object_name}'
        )

    return import_lines


def _model_names_from_annotation(annotation: str) -> list[str]:
    models: list[str] = []
    normalized = annotation.strip().strip("'\"")

    if normalized.startswith('DjangoQuerySet[') or normalized.startswith('DjangoManager['):
        inner = normalized.split('[', 1)[1].rsplit(']', 1)[0].strip().strip("'\"")
        if inner and inner[:1].isupper():
            models.append(inner)
        return models

    if (
        normalized
        and normalized[:1].isupper()
        and not normalized.endswith('QuerySet')
        and not normalized.endswith('Manager')
    ):
        models.append(normalized)

    return models


def _queryset_name_from_manager_base(class_node: ast.ClassDef) -> str | None:
    for base in class_node.bases:
        base_text = _expression_text(base)
        marker = 'from_queryset('
        if marker not in base_text:
            continue

        suffix = base_text.split(marker, 1)[1]
        queryset_name = suffix.split(')', 1)[0].strip()
        if queryset_name:
            return queryset_name

    return None


def _infer_callable_return_annotation(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None,
    visited: set[str],
) -> str | None:
    visit_key = f'{module_name}:{class_node.name if class_node else ""}:{node.name}'
    if visit_key in visited:
        return None
    visited.add(visit_key)

    return_expressions = _collect_return_expressions(node)
    if len(return_expressions) != 1:
        return None

    return _infer_expression_annotation(
        return_expressions[0],
        module_name=module_name,
        module_index=module_index,
        static_index=static_index,
        class_node=class_node,
        visited=visited,
    )


def _collect_return_expressions(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[ast.expr]:
    expressions: list[ast.expr] = []

    def visit_statements(statements: list[ast.stmt]) -> None:
        for statement in statements:
            if isinstance(statement, ast.Return) and statement.value is not None:
                expressions.append(statement.value)
                continue

            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue

            for branch_name in ('body', 'orelse', 'finalbody'):
                nested = getattr(statement, branch_name, None)
                if isinstance(nested, list):
                    visit_statements(nested)

    visit_statements(node.body)
    return expressions


def _infer_expression_annotation(
    expression: ast.expr,
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None,
    visited: set[str],
) -> str | None:
    if (
        isinstance(expression, ast.Attribute)
        and isinstance(expression.value, ast.Name)
        and expression.attr == 'objects'
    ):
        return f'DjangoManager[{expression.value.id}]'

    if isinstance(expression, ast.Call) and isinstance(expression.func, ast.Attribute):
        method_name = expression.func.attr
        receiver_annotation = _infer_expression_annotation(
            expression.func.value,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
            class_node=class_node,
            visited=visited,
        )

        if method_name == 'get':
            return _model_annotation_from_container(receiver_annotation)
        if method_name == 'values':
            return 'DjangoQuerySet[dict[str, Any]]'
        if method_name == 'values_list':
            return 'DjangoQuerySet[Any]'
        if method_name in {
            'all',
            'filter',
            'exclude',
            'order_by',
            'select_related',
            'prefetch_related',
            'only',
            'defer',
            'active',
            'with_line_count',
        }:
            queryset_annotation = _queryset_annotation_from_container(receiver_annotation)
            if queryset_annotation is not None:
                return queryset_annotation

        delegated = _infer_delegated_method_annotation(
            receiver_expression=expression.func.value,
            method_name=method_name,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
            class_node=class_node,
            visited=visited,
        )
        if delegated is not None:
            return delegated

    return None


def _infer_delegated_method_annotation(
    *,
    receiver_expression: ast.expr,
    method_name: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None,
    visited: set[str],
) -> str | None:
    resolved_target = _resolve_method_target(
        receiver_expression=receiver_expression,
        method_name=method_name,
        module_name=module_name,
        module_index=module_index,
        static_index=static_index,
        class_node=class_node,
    )
    if resolved_target is None:
        return None

    target_module_name, target_module_index, target_class_node, target_method = resolved_target
    return _callable_return_annotation(
        target_method,
        module_name=target_module_name,
        module_index=target_module_index,
        static_index=static_index,
        class_node=target_class_node,
    )


def _resolve_method_target(
    *,
    receiver_expression: ast.expr,
    method_name: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
    class_node: ast.ClassDef | None,
) -> tuple[str, ModuleIndex, ast.ClassDef | None, ast.FunctionDef | ast.AsyncFunctionDef] | None:
    if (
        isinstance(receiver_expression, ast.Call)
        and isinstance(receiver_expression.func, ast.Name)
        and receiver_expression.func.id == 'super'
        and class_node is not None
    ):
        for base_class_name in [
            _expression_text(base) for base in class_node.bases if _expression_text(base)
        ]:
            resolved = _resolve_class_method_target(
                class_name=base_class_name.split('.')[-1],
                method_name=method_name,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
            )
            if resolved is not None:
                return resolved

    if (
        isinstance(receiver_expression, ast.Call)
        and isinstance(receiver_expression.func, ast.Name)
    ):
        return _resolve_class_method_target(
            class_name=receiver_expression.func.id,
            method_name=method_name,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
        )

    if isinstance(receiver_expression, ast.Name) and receiver_expression.id in {'self', 'cls'}:
        if class_node is None:
            return None
        method_node = _find_method_node(class_node, method_name)
        if method_node is not None:
            return module_name, module_index, class_node, method_node

        for base_class_name in [
            _expression_text(base) for base in class_node.bases if _expression_text(base)
        ]:
            resolved = _resolve_class_method_target(
                class_name=base_class_name.split('.')[-1],
                method_name=method_name,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
            )
            if resolved is not None:
                return resolved

    if isinstance(receiver_expression, ast.Name):
        return _resolve_class_method_target(
            class_name=receiver_expression.id,
            method_name=method_name,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
        )

    return None


def _resolve_class_method_target(
    *,
    class_name: str,
    method_name: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> tuple[str, ModuleIndex, ast.ClassDef | None, ast.FunctionDef | ast.AsyncFunctionDef] | None:
    resolved_module_name, resolved_symbol_name = _resolve_symbol_source(
        symbol_name=class_name,
        module_name=module_name,
        module_index=module_index,
        static_index=static_index,
    )
    target_module_index = static_index.modules.get(resolved_module_name)
    if target_module_index is None:
        return None

    parsed_module = _parse_module_ast(target_module_index.file_path)
    if parsed_module is None:
        return None

    target_class_node = next(
        (
            node
            for node in parsed_module.body
            if isinstance(node, ast.ClassDef) and node.name == resolved_symbol_name
        ),
        None,
    )
    if target_class_node is None:
        return None

    method_node = _find_method_node(target_class_node, method_name)
    if method_node is None:
        return None

    return resolved_module_name, target_module_index, target_class_node, method_node


def _resolve_symbol_source(
    *,
    symbol_name: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> tuple[str, str]:
    for binding in module_index.import_bindings:
        if binding.alias != symbol_name or binding.is_star:
            continue
        if binding.symbol is None:
            return binding.module, symbol_name

        resolution = static_index.resolve_export_origin(binding.module, binding.symbol)
        return (
            resolution.origin_module or binding.module,
            resolution.origin_symbol or binding.symbol,
        )

    return module_name, symbol_name


def _find_method_node(
    class_node: ast.ClassDef,
    method_name: str,
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for child in class_node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == method_name:
            return child
    return None


def _parse_module_ast(file_path: str) -> ast.Module | None:
    try:
        return ast.parse(Path(file_path).read_text(encoding='utf-8'))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None


def _queryset_annotation_from_container(annotation: str | None) -> str | None:
    if annotation is None:
        return None
    if annotation.endswith('QuerySet') or annotation.startswith('DjangoQuerySet['):
        return annotation
    if annotation.endswith('Manager') or annotation.startswith('DjangoManager['):
        model_name = _model_annotation_from_container(annotation)
        if model_name is not None:
            return f'DjangoQuerySet[{model_name}]'
    return None


def _model_annotation_from_container(annotation: str | None) -> str | None:
    if annotation is None:
        return None
    if annotation.startswith('DjangoManager[') or annotation.startswith('DjangoQuerySet['):
        return annotation.split('[', 1)[1].rsplit(']', 1)[0]
    if annotation.endswith('Manager'):
        return _model_name_from_container_class_name(annotation, 'Manager')
    if annotation.endswith('QuerySet'):
        return _model_name_from_container_class_name(annotation, 'QuerySet')
    return annotation if annotation[:1].isupper() else None


def _stub_relative_path(relative_source_path: str) -> str:
    source_path = Path(relative_source_path)
    if source_path.name == '__init__.py':
        return str(source_path.with_name('__init__.pyi'))
    return str(source_path.with_suffix('.pyi'))


def _initialize_stub_root(stub_root: Path) -> None:
    stub_root.mkdir(parents=True, exist_ok=True)
    version_path = stub_root / STUB_VERSION_FILE

    try:
        current_version = version_path.read_text(encoding='utf-8').strip()
    except OSError:
        current_version = None

    if current_version != str(STUB_SCHEMA_VERSION):
        _clear_stub_root(stub_root)
        stub_root.mkdir(parents=True, exist_ok=True)

    _write_text_if_changed(version_path, f'{STUB_SCHEMA_VERSION}\n')


def _clear_stub_root(stub_root: Path) -> None:
    if not stub_root.exists():
        return

    for file_path in sorted(stub_root.rglob('*'), reverse=True):
        if file_path.is_dir():
            try:
                file_path.rmdir()
            except OSError:
                continue
            continue

        try:
            file_path.unlink()
        except OSError:
            continue


def _dedupe_import_lines(import_lines: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for import_line in import_lines:
        if not import_line or import_line in seen:
            continue
        seen.add(import_line)
        deduped.append(import_line)
    return deduped


def _module_related_model_import_lines(
    *,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> list[str]:
    import_lines: list[str] = []
    seen_imports: set[str] = set()

    for candidate in module_index.model_candidates:
        for field in static_index.fields_for_model(candidate.label):
            related_label = field.related_model_label
            if related_label is None:
                continue

            related_candidate = static_index.find_model_candidate(related_label)
            if (
                related_candidate is None
                or related_candidate.module == module_name
            ):
                continue

            import_line = (
                f'from {related_candidate.module} import '
                f'{related_candidate.object_name} as {_external_model_alias(related_candidate)}'
            )
            if import_line in seen_imports:
                continue

            seen_imports.add(import_line)
            import_lines.append(import_line)

    return import_lines


def _relation_field_annotation(
    field: FieldCandidate,
    *,
    static_index: StaticIndex,
    module_name: str,
) -> str | None:
    if not field.is_relation:
        return None

    related_type = _related_model_annotation(
        field.related_model_label,
        static_index=static_index,
        module_name=module_name,
    )
    if related_type is None:
        return 'Any'

    if field.field_kind in {'ForeignKey', 'OneToOneField', 'reverse_OneToOneField'}:
        return related_type

    return f'DjangoRelatedManager[{related_type}]'


def _related_model_annotation(
    model_label: str | None,
    *,
    static_index: StaticIndex,
    module_name: str,
) -> str | None:
    if model_label is None:
        return None

    related_candidate = static_index.find_model_candidate(model_label)
    if related_candidate is None:
        return None

    if related_candidate.module == module_name:
        return related_candidate.object_name

    return _external_model_alias(related_candidate)


def _external_model_alias(model_candidate: ModelCandidate) -> str:
    module_alias = model_candidate.module.replace('.', '_')
    return f'_orm_{module_alias}_{model_candidate.object_name}'


def _write_text_if_changed(target_path: Path, content: str) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        existing_content = target_path.read_text(encoding='utf-8')
    except OSError:
        existing_content = None

    if existing_content == content:
        return

    target_path.write_text(content, encoding='utf-8')


def _remove_stale_stub_files(
    stub_root: Path,
    generated_relative_paths: set[str],
) -> None:
    if not stub_root.exists():
        return

    for file_path in sorted(stub_root.rglob('*'), reverse=True):
        if file_path.is_dir():
            try:
                file_path.rmdir()
            except OSError:
                continue
            continue

        relative_path = file_path.relative_to(stub_root).as_posix()
        if relative_path in generated_relative_paths:
            continue

        try:
            file_path.unlink()
        except OSError:
            continue
