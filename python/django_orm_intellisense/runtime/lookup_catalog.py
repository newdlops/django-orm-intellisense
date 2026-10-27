"""Compact, per-field lookup metadata from the installed Django registry.

Type references preserve transform chains (including cycles) without repeating
lookup lists for every model field. No queries or SQL compilation are involved.
"""
from __future__ import annotations
import inspect
import sys
from collections.abc import Iterator, Mapping
from functools import lru_cache


@lru_cache(maxsize=256)
def _shared_lookup_names(names: tuple[str, ...]) -> tuple[str, ...]:
    return names


def _lookup_names(names) -> tuple[str, ...]:
    row = tuple(names)
    # Large/unusual registries keep their complete output without retaining
    # that data in the process-wide sharing pool.
    if (len(row) > 256 or any(type(name) is not str for name in row)
            or sum(len(name) for name in row) > 4096):
        return row
    return _shared_lookup_names(row)


def _compact_descriptor(descriptor, *, copy_transforms=False):
    result = dict(descriptor)
    if copy_transforms and isinstance(result.get('transforms'), dict):
        result['transforms'] = dict(result['transforms'])
    if isinstance(result.get('lookups'), (list, tuple)):
        result['lookups'] = _lookup_names(result['lookups'])
    if isinstance(result.get('dynamicTransform'), dict):
        dynamic = dict(result['dynamicTransform'])
        if isinstance(dynamic.get('blockedNames'), (list, tuple)):
            dynamic['blockedNames'] = _lookup_names(dynamic['blockedNames'])
        result['dynamicTransform'] = dynamic
    return result


class LookupTypeTable(Mapping[str, dict[str, object]]):
    """Immutable descriptor chunks; flatten only at full serialization boundaries."""

    def __init__(self, values: Mapping[str, dict[str, object]]):
        self._base = {}
        self._models = {}
        for key, value in values.items():
            value = _compact_descriptor(value, copy_transforms=True)
            label = self._model_label(key)
            if label is None:
                self._base[key] = value
            else:
                self._models.setdefault(label, {})[key] = value
        self._length = len(values)

    @staticmethod
    def _model_label(key: str) -> str | None:
        if key.startswith('model:'):
            label, separator, _ = key[6:].rpartition(':')
            if separator:
                return label
        return None

    @classmethod
    def from_types(cls, values: Mapping[str, dict[str, object]]) -> LookupTypeTable:
        return values if isinstance(values, cls) else cls(values)

    def replace_models(self, replacements: dict[str, dict[str, dict[str, object]] | None]) -> LookupTypeTable:
        result = object.__new__(type(self))
        result._base = self._base
        result._models = dict(self._models)
        result._length = self._length
        for label, values in replacements.items():
            previous = result._models.pop(label, {})
            result._length -= len(previous)
            if values is not None:
                result._models[label] = values
                result._length += len(values)
        return result

    def __getitem__(self, key: str) -> dict[str, object]:
        if not isinstance(key, str):
            raise KeyError(key)
        label = self._model_label(key)
        return self._base[key] if label is None else self._models[label][key]

    def __iter__(self) -> Iterator[str]:
        yield from self._base
        for values in self._models.values():
            yield from values

    def __len__(self) -> int:
        return self._length

    def to_dict(self) -> dict[str, dict[str, object]]:
        result = dict(self._base)
        for values in self._models.values():
            result.update(values)
        return result


def lookup_catalog_json_default(value: object) -> dict[str, object]:
    if isinstance(value, LookupTypeTable):
        return value.to_dict()
    raise TypeError(f'Object of type {type(value).__name__} is not JSON serializable')


def compact_lookup_catalog(catalog: dict[str, object]) -> dict[str, object]:
    """Restore shared name rows from JSON arrays without changing wire data."""
    result = dict(catalog)
    if isinstance(result.get('types'), Mapping):
        result['types'] = LookupTypeTable.from_types(result['types'])
    return result


def _uses_default_registry_method(expression: object, method: object, default: object) -> bool:
    from django.db.models.query_utils import RegisterLookupMixin
    registry_method = getattr(expression, 'get_lookups', None)
    registry_function = getattr(registry_method, '__func__', getattr(registry_method, 'func', None))
    return (getattr(getattr(expression, '_get_lookup', None), '__func__', None)
            is RegisterLookupMixin._get_lookup
            and getattr(method, '__func__', None) is default
            and registry_function is RegisterLookupMixin.get_instance_lookups
            and getattr(getattr(expression, 'get_class_lookups', None), '__func__', None)
            is RegisterLookupMixin.get_class_lookups.__func__)


def collect_model_lookup_catalog(model_graph, runtime, model_label: str, *, use_current_registry: bool = False) -> dict[str, object]:
    """Describe one live model; keep the edit payload independent of workspace size."""
    if runtime.detached and not use_current_registry:
        return _detached_model_lookup_catalog(model_graph, runtime, model_label)
    from ..features.lookup_paths import _runtime_lookup_field
    from .inspector import get_runtime_field
    registry = {}
    for field in model_graph.fields_for_model(model_label):
        # The fresh member worker has imported the current source epoch.
        # Parent graph overlays can still describe an older constructor; use
        # its actual Django registry there, while preserving parent overrides.
        resolved = (get_runtime_field(runtime.settings_module, model_label=field.model_label,
            field_name=field.name, for_lookup=True) if use_current_registry
            else _runtime_lookup_field(runtime=runtime, field=field))
        if resolved is not None:
            # Lookup resolution returns the relation for its attname so that
            # relation registrations still apply. Match the cold registry's
            # value field here; collect_lookup_catalog restores that relation
            # as the lookup origin while retaining the target field's kind.
            if (getattr(resolved, 'is_relation', False)
                    and field.name == getattr(resolved, 'attname', None)
                    and field.name != getattr(resolved, 'name', None)):
                target = getattr(resolved, 'target_field', None)
                if target is not None:
                    resolved = target
            registry[(model_label, field.name)] = resolved
    catalog = collect_lookup_catalog(registry, include_class_defaults=False)
    # The collector includes class defaults for cold initialization. Edit
    # chunks need only descriptors reachable from this model's fields.
    pending = list(catalog['fields'].get(model_label, {}).values())
    pending.extend(catalog['expressionFields'].get(model_label, {}).values())
    reachable = set()
    while pending:
        type_id = pending.pop()
        if type_id is None or type_id in reachable:
            continue
        descriptor = catalog['types'].get(type_id)
        if descriptor is None:
            continue
        reachable.add(type_id)
        pending.extend(descriptor['transforms'].values())
        dynamic = descriptor.get('dynamicTransform') or {}
        pending.extend((dynamic.get('outputType'), dynamic.get('sliceType')))
    catalog['types'] = {key: value for key, value in catalog['types'].items() if key in reachable}
    catalog.pop('kinds', None)
    catalog['fields'].setdefault(model_label, {})
    return catalog


def _detached_model_lookup_catalog(model_graph, runtime, model_label):
    """Use this project's captured descriptors without configuring parent Django.

    Ordinary scalar edits can use captured class defaults. Parameterized or
    custom source changes wait for the existing fresh-registry refresh rather
    than borrowing a descriptor from another project or interpreter.
    """
    previous = runtime.lookup_catalog
    fields, expressions, relations = {}, {}, {}
    scalar_defaults = frozenset(('CharField', 'TextField', 'IntegerField', 'BigIntegerField',
        'FloatField', 'DecimalField', 'BooleanField', 'DateField', 'DateTimeField',
        'TimeField', 'DurationField', 'UUIDField', 'JSONField', 'BinaryField'))
    for field in model_graph.fields_for_model(model_label):
        if field.source == 'static_edit':
            type_id = previous.get('kinds', {}).get(field.field_kind) if field.field_kind in scalar_defaults else None
        else:
            type_id = previous.get('fields', {}).get(model_label, {}).get(field.name)
            expression = previous.get('expressionFields', {}).get(model_label, {}).get(field.name)
            if expression is not None:
                expressions[field.name] = expression
            relation = previous.get('relationPaths', {}).get(model_label, {}).get(field.name)
            if relation is not None:
                relations[field.name] = dict(relation)
        if type_id is not None:
            fields[field.name] = type_id
    reachable, pending = {}, list(fields.values()) + list(expressions.values())
    types = previous.get('types', {})
    while pending:
        type_id = pending.pop()
        if type_id is None or type_id in reachable:
            continue
        descriptor = types.get(type_id)
        if descriptor is None:
            continue
        reachable[type_id] = descriptor
        pending.extend(descriptor.get('transforms', {}).values())
        dynamic = descriptor.get('dynamicTransform') or {}
        pending.extend((dynamic.get('outputType'), dynamic.get('sliceType')))
    # Model chunks receive their own prefix when adopted. Start with local IDs
    # each time so repeated saves cannot grow nested model:<label>: prefixes.
    ids = {type_id: str(index) for index, type_id in enumerate(reachable)}
    remapped = {}
    for type_id, descriptor in reachable.items():
        updated = {**descriptor, 'transforms': {name: ids.get(target)
            for name, target in descriptor.get('transforms', {}).items()}}
        if descriptor.get('dynamicTransform'):
            dynamic = dict(descriptor['dynamicTransform'])
            for key in ('outputType', 'sliceType'):
                if key in dynamic:
                    dynamic[key] = ids.get(dynamic[key])
            updated['dynamicTransform'] = dynamic
        remapped[ids[type_id]] = updated
    return {'fields': {model_label: {name: ids[type_id] for name, type_id in fields.items() if type_id in ids}},
            'expressionFields': {model_label: {name: ids[type_id] for name, type_id in expressions.items() if type_id in ids}},
            'relationPaths': {model_label: relations}, 'types': remapped}


def apply_model_catalog_delta(catalog: dict[str, object], delta: dict[str, dict[str, object] | None]) -> dict[str, object]:
    types = LookupTypeTable.from_types(catalog.get('types') or {})
    replacements = {}
    result = {**catalog,
        'fields': dict(catalog.get('fields') or {}),
        'expressionFields': dict(catalog.get('expressionFields') or {}),
        'relationPaths': dict(catalog.get('relationPaths') or {})}
    for label, chunk in delta.items():
        prefix = f'model:{label}:'
        for key in ('fields', 'expressionFields', 'relationPaths'):
            result[key].pop(label, None)
        if chunk is None:
            replacements[label] = None
            continue
        model_types = {}
        def remap(type_id):
            return prefix + type_id if type_id is not None else None
        for key, descriptor in chunk['types'].items():
            updated = {**descriptor, 'transforms': {name: remap(value) for name, value in descriptor['transforms'].items()}}
            if descriptor.get('dynamicTransform'):
                updated['dynamicTransform'] = {**descriptor['dynamicTransform'],
                    'outputType': remap(descriptor['dynamicTransform'].get('outputType'))}
                if 'sliceType' in descriptor['dynamicTransform']:
                    updated['dynamicTransform']['sliceType'] = remap(descriptor['dynamicTransform']['sliceType'])
            model_types[remap(key)] = _compact_descriptor(updated)
        replacements[label] = model_types
        for key in ('fields', 'expressionFields'):
            result[key][label] = {name: remap(value) for name, value in chunk.get(key, {}).get(label, {}).items()}
        result['relationPaths'][label] = dict(chunk.get('relationPaths', {}).get(label, {}))
    result['types'] = types.replace_models(replacements)
    return result


def collect_lookup_catalog(registry: dict[tuple[str, str], object], *,
                           include_class_defaults: bool = True) -> dict[str, object]:
    from django.db import models
    from django.db.models import Field, Lookup, Transform
    from django.db.models.expressions import Col
    from django.db.models.query_utils import RegisterLookupMixin

    types: dict[str, dict[str, object]] = {}
    fields: dict[str, dict[str, str]] = {}
    expression_fields: dict[str, dict[str, str]] = {}
    relation_paths: dict[str, dict[str, dict[str, str]]] = {}
    seen: dict[tuple[object, ...], str] = {}
    fast_seen: dict[tuple[object, ...], tuple[str, dict, dict, dict, dict]] = {}
    identities: list[object] = []

    def describe(expression: object, depth: int = 0, kind_override: str | None = None) -> str | None:
        # An unusual user transform may generate a fresh field type on every
        # step. Leave that edge to the runtime completion path.
        if depth > 16:
            return None
        output = expression if isinstance(expression, Field) else getattr(expression, 'output_field', None)
        if output is None:
            output = getattr(expression, 'field', None)
        if output is None:
            return None
        effective_output = getattr(output, 'output_field', output)
        own_registry = expression.get_lookups()
        output_registry = effective_output.get_lookups()
        fast_key = None
        if (isinstance(expression, Field) and type(expression).__module__.startswith('django.')
                and type(own_registry) is dict and type(output_registry) is dict
                and not getattr(expression, 'instance_lookups', None)
                and not hasattr(effective_output, 'base_field')
                and getattr(expression.get_lookup, '__func__', None) is RegisterLookupMixin.get_lookup
                and getattr(expression.get_transform, '__func__', None) is RegisterLookupMixin.get_transform
                and getattr(expression._get_lookup, '__func__', None) is RegisterLookupMixin._get_lookup
                and getattr(expression.get_lookups, 'func', None) is RegisterLookupMixin.get_instance_lookups
                and getattr(expression.get_class_lookups, '__func__', None) is RegisterLookupMixin.get_class_lookups.__func__):
            fast_key = (type(expression), id(own_registry), id(output_registry), kind_override)
            cached = fast_seen.get(fast_key)
            if (cached is not None and cached[1] is own_registry and cached[2] is output_registry
                    and cached[3] == own_registry and cached[4] == output_registry):
                return cached[0]
        registered = {**output_registry, **own_registry}
        has_custom_transform = any(
            isinstance(cls, type) and issubclass(cls, Transform)
            and not cls.__module__.startswith('django.') for cls in registered.values()
        )
        if has_custom_transform:
            fast_key = None
        lookup_method = expression.get_lookup
        transform_method = expression.get_transform
        # RegisterLookupMixin only fetches and classifies an entry for names
        # present in the expression's own registry. Reuse that snapshot rather
        # than re-merging instance registrations for every name. An explicit
        # stable output field can use its snapshot too; custom methods and
        # dynamically computed output fields keep Django's actual dispatch.
        standard_lookup = _uses_default_registry_method(
            expression, lookup_method, RegisterLookupMixin.get_lookup)
        standard_transform = _uses_default_registry_method(
            expression, transform_method, RegisterLookupMixin.get_transform)
        stable_output = (
            not isinstance(expression, Field) and effective_output is output
            and inspect.getattr_static(expression, 'output_field', None) is output
        )
        output_lookup = stable_output and _uses_default_registry_method(
            output, getattr(output, 'get_lookup', None), RegisterLookupMixin.get_lookup)
        output_transform = stable_output and _uses_default_registry_method(
            output, getattr(output, 'get_transform', None), RegisterLookupMixin.get_transform)
        lookups = {}
        transforms = {}
        for name, registered_class in registered.items():
            if not isinstance(name, str):
                continue
            own_class = own_registry.get(name)
            lookup_class = own_class if own_class is not None else output_registry.get(name)
            direct_lookup = standard_lookup and (
                own_class is not None or (output_lookup and lookup_class is not None))
            if direct_lookup:
                lookups[name] = lookup_class if issubclass(lookup_class, Lookup) else None
            else:
                lookups[name] = lookup_method(name)
            if isinstance(registered_class, type) and issubclass(registered_class, Transform):
                direct_transform = standard_transform and (
                    own_class is not None or (output_transform and lookup_class is not None))
                if direct_transform:
                    transforms[name] = lookup_class if issubclass(lookup_class, Transform) else None
                else:
                    transforms[name] = transform_method(name)
            else:
                transforms[name] = None
        # Array element types and instance registrations affect capabilities.
        # Keep the field identity for parameterized/custom transforms; ordinary
        # built-ins can safely share the cached descriptor by their registry.
        expression_type = type(expression)
        if any(base.__name__ == 'RasterBandTransform' and base.__module__.startswith('django.')
               for base in expression_type.__mro__):
            # RasterField creates a fresh class for every band number.
            expression_type = next(base for base in expression_type.__mro__ if base.__name__ == 'RasterBandTransform')
        signature = (
            expression_type, type(effective_output), kind_override,
            tuple((name, lookups[name], transforms[name]) for name in sorted(lookups)),
            id(getattr(effective_output, 'base_field', None)),
            id(effective_output) if has_custom_transform else None,
        )
        if signature in seen:
            return seen[signature]
        # Identity-based signatures must keep temporary output/base fields alive
        # until this catalog is complete, so allocator reuse cannot merge them.
        if has_custom_transform:
            identities.append(effective_output)
        base_field = getattr(effective_output, 'base_field', None)
        if base_field is not None:
            identities.append(base_field)
        type_id = str(len(types))
        seen[signature] = type_id
        if fast_key is not None:
            # Per-collection snapshots retain registry identity and detect
            # in-place updates, including same-size lookup/transform swaps.
            fast_seen[fast_key] = (type_id, own_registry, output_registry,
                                   dict(own_registry), dict(output_registry))
        descriptor: dict[str, object] = {
            'fieldKind': kind_override or type(effective_output).__name__,
            'lookups': [name for name in sorted(lookups) if lookups[name] is not None],
            'transforms': {},
        }
        builtin_kinds = [base.__name__ for base in type(effective_output).__mro__
                         if base.__module__.startswith('django.')]
        descriptor['baseKind'] = next((name for name in builtin_kinds if hasattr(models, name)
                                       and isinstance(getattr(models, name), type)
                                       and issubclass(getattr(models, name), Field)), descriptor['fieldKind'])
        if not getattr(expression.get_transform, '__module__', 'django.').startswith('django.'):
            descriptor['runtimeTransforms'] = True
        if not getattr(expression.get_lookup, '__module__', 'django.').startswith('django.'):
            descriptor['runtimeLookups'] = True
        if type(effective_output).__name__ == 'CompositePrimaryKey':
            descriptor['lookups'] = [name for name in descriptor['lookups']
                                     if getattr(lookups[name], 'allows_composite_expressions', False)]
        descriptor['lookups'] = _lookup_names(descriptor['lookups'])
        types[type_id] = descriptor
        lhs = Col('__djls__', output, effective_output) if isinstance(expression, Field) else expression
        for name in sorted(transforms):
            factory = transforms[name]
            if factory is None:
                continue
            try:
                descriptor['transforms'][name] = describe(factory(lhs), depth + 1)
            except Exception:
                descriptor['transforms'][name] = None

        # These families have infinitely many names. Store the output of a
        # representative key/index, never invent keys from database contents.
        family = None
        if 'JSONField' in builtin_kinds:
            family = 'key'
        elif 'HStoreField' in builtin_kinds:
            family = 'key'
        elif 'ArrayField' in builtin_kinds:
            family = 'index'
        elif 'RasterField' in builtin_kinds:
            family = 'band'
        if family:
            try:
                name = '__djls_key__' if family == 'key' else '1' if family == 'band' else '0'
                factory = expression.get_transform(name)
                if factory is not None:
                    descriptor['dynamicTransform'] = {
                        'kind': family, 'outputType': describe(factory(lhs), depth + 1),
                        'blockedNames': _lookup_names(name for name in sorted(registered)
                                         if expression.get_transform(name) is None),
                    }
                if family == 'index':
                    descriptor['dynamicTransform']['sliceType'] = type_id
            except Exception:
                pass
        return type_id

    try:
        aliases = {}
        for (label, name), field in registry.items():
            attname = getattr(field, 'attname', None)
            if getattr(field, 'is_relation', False) and name == getattr(field, 'name', None) and attname != name:
                aliases[(label, attname)] = field
        for (label, name), field in sorted(registry.items()):
            if name.endswith('+'):
                continue
            if getattr(field, 'auto_created', False) and not getattr(field, 'concrete', True):
                accessor = getattr(field, 'get_accessor_name', lambda: None)()
                query = getattr(getattr(field, 'field', None), 'related_query_name', lambda: None)()
                if accessor and query:
                    relation_paths.setdefault(label, {})[name] = {'accessorName': accessor, 'queryName': query}
            try:
                origin = aliases.get((label, name))
                lookup_field = origin or field
                if getattr(lookup_field, 'many_to_many', False):
                    paths = lookup_field.get_path_info()
                    if paths:
                        lookup_field = paths[-1].join_field
                type_id = describe(lookup_field, kind_override=type(field).__name__ if origin is not None else None)
            except Exception:
                continue
            if type_id is not None:
                fields.setdefault(label, {})[name] = type_id
            if getattr(lookup_field, 'is_relation', False) or getattr(lookup_field, 'generated', False):
                try:
                    value_field = lookup_field
                    if not hasattr(value_field, 'get_col'):
                        value_field = value_field.related_model._meta.pk
                    value_type = describe(value_field.get_col('__djls__').output_field)
                    if value_type is not None:
                        expression_fields.setdefault(label, {})[name] = value_type
                except Exception:
                    pass
        kinds = {}
        if not include_class_defaults:
            return {'types': types, 'fields': fields, 'kinds': kinds,
                    'relationPaths': relation_paths, 'expressionFields': expression_fields}
        for name in ('CharField', 'TextField', 'IntegerField', 'BigIntegerField', 'FloatField',
                     'DecimalField', 'BooleanField', 'DateField', 'DateTimeField', 'TimeField',
                     'DurationField', 'UUIDField', 'JSONField', 'BinaryField'):
            type_id = describe(getattr(models, name)())
            if type_id is not None:
                kinds[name] = type_id
        # Inspect optional field families only when the project has loaded them.
        # Importing postgres.fields here would itself change DateField registries.
        postgres = sys.modules.get('django.contrib.postgres.fields')
        for name in ('ArrayField', 'HStoreField', 'IntegerRangeField', 'BigIntegerRangeField',
                     'DecimalRangeField', 'DateRangeField', 'DateTimeRangeField'):
            cls = getattr(postgres, name, None)
            if cls is not None:
                kinds[name] = describe(cls(models.Field()) if name == 'ArrayField' else cls())
        gis = sys.modules.get('django.contrib.gis.db.models.fields')
        for name in ('GeometryField', 'PointField', 'RasterField'):
            cls = getattr(gis, name, None)
            if cls is not None:
                kinds[name] = describe(cls())
        return {'types': types, 'fields': fields, 'kinds': kinds, 'relationPaths': relation_paths,
                'expressionFields': expression_fields}
    finally:
        # Recursive describe closes over its own cell and temporary field
        # identities. Keep them alive during collection, then break the cycle
        # on normal, early-return and exceptional exits instead of waiting
        # for a later generation-2 collection to reclaim them.
        identities.clear()
        describe = None
