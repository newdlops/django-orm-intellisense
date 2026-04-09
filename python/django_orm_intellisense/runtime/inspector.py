from __future__ import annotations

import dataclasses
import importlib.util
import os
import sys
from dataclasses import dataclass

_RUNTIME_FIELD_REGISTRY: dict[tuple[str, str], object] = {}
_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE: str | None = None
_RUNTIME_FIELD_REGISTRY_READY = False


@dataclass(frozen=True)
class RuntimeRelationSummary:
    name: str
    related_model_label: str | None
    direction: str
    field_kind: str

    def to_dict(self) -> dict[str, str | None]:
        return {
            'name': self.name,
            'relatedModelLabel': self.related_model_label,
            'direction': self.direction,
            'fieldKind': self.field_kind,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> RuntimeRelationSummary:
        return cls(
            name=str(payload['name']),
            related_model_label=_string_or_none(payload.get('relatedModelLabel')),
            direction=str(payload['direction']),
            field_kind=str(payload['fieldKind']),
        )


@dataclass(frozen=True)
class RuntimeFieldSummary:
    name: str
    field_kind: str
    is_relation: bool
    related_model_label: str | None
    direction: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            'name': self.name,
            'fieldKind': self.field_kind,
            'isRelation': self.is_relation,
            'relatedModelLabel': self.related_model_label,
            'direction': self.direction,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> RuntimeFieldSummary:
        return cls(
            name=str(payload['name']),
            field_kind=str(payload['fieldKind']),
            is_relation=bool(payload['isRelation']),
            related_model_label=_string_or_none(payload.get('relatedModelLabel')),
            direction=_string_or_none(payload.get('direction')),
        )


@dataclass(frozen=True)
class RuntimeModelSummary:
    label: str
    module: str
    field_names: list[str]
    relation_names: list[str]
    reverse_relation_names: list[str]
    fields: list[RuntimeFieldSummary]
    relations: list[RuntimeRelationSummary]
    manager_names: list[str]

    def to_dict(self) -> dict[str, object]:
        return {
            'label': self.label,
            'module': self.module,
            'fieldNames': list(self.field_names),
            'relationNames': list(self.relation_names),
            'reverseRelationNames': list(self.reverse_relation_names),
            'fields': [field.to_dict() for field in self.fields],
            'relations': [relation.to_dict() for relation in self.relations],
            'managerNames': list(self.manager_names),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> RuntimeModelSummary:
        return cls(
            label=str(payload['label']),
            module=str(payload['module']),
            field_names=[str(name) for name in payload.get('fieldNames', [])],
            relation_names=[str(name) for name in payload.get('relationNames', [])],
            reverse_relation_names=[
                str(name) for name in payload.get('reverseRelationNames', [])
            ],
            fields=[
                RuntimeFieldSummary.from_dict(dict(field))
                for field in payload.get('fields', [])
                if isinstance(field, dict)
            ],
            relations=[
                RuntimeRelationSummary.from_dict(dict(relation))
                for relation in payload.get('relations', [])
                if isinstance(relation, dict)
            ],
            manager_names=[str(name) for name in payload.get('managerNames', [])],
        )


@dataclass(frozen=True)
class RuntimeInspection:
    python_executable: str
    django_importable: bool
    django_version: str | None
    bootstrap_status: str
    settings_module: str | None
    bootstrap_error: str | None
    app_count: int
    model_count: int
    field_count: int
    relation_count: int
    reverse_relation_count: int
    manager_count: int
    model_catalog: list[RuntimeModelSummary]
    model_preview: list[RuntimeModelSummary]
    custom_lookups: dict[str, list[str]] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            'pythonPath': self.python_executable,
            'djangoImportable': self.django_importable,
            'djangoVersion': self.django_version,
            'bootstrapStatus': self.bootstrap_status,
            'settingsModule': self.settings_module,
            'bootstrapError': self.bootstrap_error,
            'appCount': self.app_count,
            'modelCount': self.model_count,
            'fieldCount': self.field_count,
            'relationCount': self.relation_count,
            'reverseRelationCount': self.reverse_relation_count,
            'managerCount': self.manager_count,
            'modelPreview': [model.to_dict() for model in self.model_preview],
        }

    def to_cache_dict(self) -> dict[str, object]:
        return {
            'pythonExecutable': self.python_executable,
            'djangoImportable': self.django_importable,
            'djangoVersion': self.django_version,
            'bootstrapStatus': self.bootstrap_status,
            'settingsModule': self.settings_module,
            'bootstrapError': self.bootstrap_error,
            'appCount': self.app_count,
            'modelCount': self.model_count,
            'fieldCount': self.field_count,
            'relationCount': self.relation_count,
            'reverseRelationCount': self.reverse_relation_count,
            'managerCount': self.manager_count,
            'modelCatalog': [model.to_dict() for model in self.model_catalog],
            'modelPreview': [model.to_dict() for model in self.model_preview],
            'customLookups': {k: list(v) for k, v in self.custom_lookups.items()},
        }

    @classmethod
    def from_cache_dict(cls, payload: dict[str, object]) -> RuntimeInspection:
        raw_model_catalog = payload.get('modelCatalog') or []
        raw_model_preview = payload.get('modelPreview') or []

        model_catalog = [
            _sanitize_runtime_model_summary(RuntimeModelSummary.from_dict(dict(model)))
            for model in raw_model_catalog
            if isinstance(model, dict)
        ]
        model_preview = [
            _sanitize_runtime_model_summary(RuntimeModelSummary.from_dict(dict(model)))
            for model in raw_model_preview
            if isinstance(model, dict)
        ]

        if not model_preview:
            model_preview = model_catalog[:10]

        return cls(
            python_executable=str(payload['pythonExecutable']),
            django_importable=bool(payload['djangoImportable']),
            django_version=_string_or_none(payload.get('djangoVersion')),
            bootstrap_status=str(payload['bootstrapStatus']),
            settings_module=_string_or_none(payload.get('settingsModule')),
            bootstrap_error=_string_or_none(payload.get('bootstrapError')),
            app_count=int(payload['appCount']),
            model_count=int(payload['modelCount']),
            field_count=int(payload['fieldCount']),
            relation_count=int(payload['relationCount']),
            reverse_relation_count=int(payload['reverseRelationCount']),
            manager_count=int(payload['managerCount']),
            model_catalog=model_catalog,
            model_preview=model_preview,
            custom_lookups={
                str(k): [str(v) for v in vs]
                for k, vs in (payload.get('customLookups') or {}).items()
                if isinstance(vs, list)
            },
        )


def inspect_runtime(settings_module: str | None) -> RuntimeInspection:
    if importlib.util.find_spec('django') is None:
        _clear_runtime_field_registry()
        return RuntimeInspection(
            python_executable=sys.executable,
            django_importable=False,
            django_version=None,
            bootstrap_status='skipped_missing_django',
            settings_module=settings_module,
            bootstrap_error=None,
            app_count=0,
            model_count=0,
            field_count=0,
            relation_count=0,
            reverse_relation_count=0,
            manager_count=0,
            model_catalog=[],
            model_preview=[],
        )

    import django  # type: ignore

    django_version = getattr(django, 'get_version', lambda: None)()

    if not settings_module:
        _clear_runtime_field_registry()
        return RuntimeInspection(
            python_executable=sys.executable,
            django_importable=True,
            django_version=django_version,
            bootstrap_status='skipped_missing_settings',
            settings_module=settings_module,
            bootstrap_error=None,
            app_count=0,
            model_count=0,
            field_count=0,
            relation_count=0,
            reverse_relation_count=0,
            manager_count=0,
            model_catalog=[],
            model_preview=[],
        )

    try:
        os.environ['DJANGO_SETTINGS_MODULE'] = settings_module
        django.setup()
    except Exception as error:
        _clear_runtime_field_registry()
        return RuntimeInspection(
            python_executable=sys.executable,
            django_importable=True,
            django_version=django_version,
            bootstrap_status='setup_failed',
            settings_module=settings_module,
            bootstrap_error=f'{error.__class__.__name__}: {error}',
            app_count=0,
            model_count=0,
            field_count=0,
            relation_count=0,
            reverse_relation_count=0,
            manager_count=0,
            model_catalog=[],
            model_preview=[],
        )

    from django.apps import apps  # type: ignore

    app_labels: set[str] = set()
    field_count = 0
    relation_count = 0
    reverse_relation_count = 0
    manager_count = 0
    model_preview: list[RuntimeModelSummary] = []
    runtime_field_registry: dict[tuple[str, str], object] = {}

    for model in sorted(
        apps.get_models(),
        key=lambda candidate: (
            candidate._meta.app_label,  # type: ignore[attr-defined]
            candidate._meta.object_name,  # type: ignore[attr-defined]
        ),
    ):
        meta = model._meta
        app_labels.add(meta.app_label)
        field_names: list[str] = []
        relation_names: list[str] = []
        reverse_relation_names: list[str] = []
        fields: list[RuntimeFieldSummary] = []
        relations: list[RuntimeRelationSummary] = []
        manager_names = [manager.name for manager in meta.managers]
        manager_count += len(manager_names)

        for field in meta.get_fields(include_hidden=True):
            if getattr(field, 'auto_created', False) and not getattr(field, 'concrete', True):
                reverse_name = _relation_name(field)
                if reverse_name:
                    runtime_field_registry[(f'{meta.app_label}.{meta.object_name}', reverse_name)] = field
                    reverse_relation_names.append(reverse_name)
                    reverse_relation_count += 1
                    fields.append(
                        RuntimeFieldSummary(
                            name=reverse_name,
                            field_kind=_relation_field_kind(field, reverse=True),
                            is_relation=True,
                            related_model_label=_related_model_label(field),
                            direction='reverse',
                        )
                    )
                    relations.append(
                        RuntimeRelationSummary(
                            name=reverse_name,
                            related_model_label=_related_model_label(field),
                            direction='reverse',
                            field_kind=_relation_field_kind(field, reverse=True),
                        )
                    )
                continue

            field_names.append(field.name)
            field_count += 1
            _register_runtime_field(
                runtime_field_registry,
                model_label=f'{meta.app_label}.{meta.object_name}',
                field=field,
            )
            fields.append(
                RuntimeFieldSummary(
                    name=str(field.name),
                    field_kind=field.__class__.__name__,
                    is_relation=bool(getattr(field, 'is_relation', False)),
                    related_model_label=_related_model_label(field),
                    direction='forward' if getattr(field, 'is_relation', False) else None,
                )
            )

            if getattr(field, 'is_relation', False) and getattr(field, 'related_model', None) is not None:
                relation_names.append(field.name)
                relation_count += 1
                relations.append(
                    RuntimeRelationSummary(
                        name=str(field.name),
                        related_model_label=_related_model_label(field),
                        direction='forward',
                        field_kind=_relation_field_kind(field, reverse=False),
                    )
                )

        model_preview.append(
            RuntimeModelSummary(
                label=f'{meta.app_label}.{meta.object_name}',
                module=model.__module__,
                field_names=field_names,
                relation_names=relation_names,
                reverse_relation_names=reverse_relation_names,
                fields=fields,
                relations=relations,
                manager_names=manager_names,
            )
        )

    _set_runtime_field_registry(settings_module, runtime_field_registry)

    custom_lookups = _collect_custom_lookups()

    return RuntimeInspection(
        python_executable=sys.executable,
        django_importable=True,
        django_version=django_version,
        bootstrap_status='ready',
        settings_module=settings_module,
        bootstrap_error=None,
        app_count=len(app_labels),
        model_count=len(model_preview),
        field_count=field_count,
        relation_count=relation_count,
        reverse_relation_count=reverse_relation_count,
        manager_count=manager_count,
        model_catalog=model_preview,
        model_preview=model_preview[:10],
        custom_lookups=custom_lookups,
    )


def _collect_custom_lookups() -> dict[str, list[str]]:
    """Collect registered lookups per field class from Django's field registry.

    Returns a dict mapping field class name (e.g. 'CharField') to a list of
    lookup names that are registered beyond the Django defaults.
    """
    try:
        from django.db import models  # type: ignore
    except ImportError:
        return {}

    # Django built-in lookup names (always available on all fields)
    BUILTIN_LOOKUPS = {
        'exact', 'iexact', 'contains', 'icontains', 'gt', 'gte', 'lt', 'lte',
        'in', 'startswith', 'istartswith', 'endswith', 'iendswith', 'range',
        'isnull', 'regex', 'iregex',
        # Date/time extracts registered as lookups in Django
        'year', 'month', 'day', 'week', 'week_day', 'iso_year', 'iso_week_day',
        'quarter', 'hour', 'minute', 'second', 'date', 'time',
        # JSON lookups
        'contains', 'contained_by', 'has_key', 'has_keys', 'has_any_keys',
    }

    result: dict[str, list[str]] = {}
    field_classes = [
        models.CharField, models.TextField, models.IntegerField,
        models.FloatField, models.DecimalField, models.BooleanField,
        models.DateField, models.DateTimeField, models.TimeField,
        models.ForeignKey, models.OneToOneField, models.ManyToManyField,
        models.JSONField, models.UUIDField, models.BinaryField,
        models.FileField, models.ImageField, models.DurationField,
        models.AutoField, models.BigAutoField,
    ]

    for field_cls in field_classes:
        try:
            registered = field_cls.get_lookups()
        except (AttributeError, Exception):
            continue
        custom = [
            name for name in registered
            if name not in BUILTIN_LOOKUPS
        ]
        if custom:
            result[field_cls.__name__] = sorted(custom)

    return result


def can_defer_runtime_inspection(settings_module: str | None) -> bool:
    return bool(settings_module) and importlib.util.find_spec('django') is not None


def create_pending_runtime_inspection(
    settings_module: str | None,
) -> RuntimeInspection:
    return RuntimeInspection(
        python_executable=sys.executable,
        django_importable=importlib.util.find_spec('django') is not None,
        django_version=None,
        bootstrap_status='warming_up',
        settings_module=settings_module,
        bootstrap_error=None,
        app_count=0,
        model_count=0,
        field_count=0,
        relation_count=0,
        reverse_relation_count=0,
        manager_count=0,
        model_catalog=[],
        model_preview=[],
    )


def get_runtime_field(
    settings_module: str | None,
    *,
    model_label: str,
    field_name: str,
) -> object | None:
    _ensure_runtime_field_registry(settings_module)
    return _RUNTIME_FIELD_REGISTRY.get((model_label, field_name))


def _ensure_runtime_field_registry(settings_module: str | None) -> None:
    global _RUNTIME_FIELD_REGISTRY_READY

    if (
        _RUNTIME_FIELD_REGISTRY_READY
        and _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE == settings_module
    ):
        return

    if importlib.util.find_spec('django') is None or not settings_module:
        _clear_runtime_field_registry()
        _RUNTIME_FIELD_REGISTRY_READY = True
        return

    try:
        import django  # type: ignore

        os.environ['DJANGO_SETTINGS_MODULE'] = settings_module
        django.setup()

        from django.apps import apps  # type: ignore
    except Exception:
        _clear_runtime_field_registry()
        _RUNTIME_FIELD_REGISTRY_READY = True
        return

    runtime_field_registry: dict[tuple[str, str], object] = {}
    for model in apps.get_models():
        meta = model._meta
        model_label = f'{meta.app_label}.{meta.object_name}'
        for field in meta.get_fields(include_hidden=True):
            if getattr(field, 'auto_created', False) and not getattr(field, 'concrete', True):
                reverse_name = _relation_name(field)
                if reverse_name:
                    runtime_field_registry[(model_label, reverse_name)] = field
                continue

            _register_runtime_field(
                runtime_field_registry,
                model_label=model_label,
                field=field,
            )

    _set_runtime_field_registry(settings_module, runtime_field_registry)


def _set_runtime_field_registry(
    settings_module: str | None,
    registry: dict[tuple[str, str], object],
) -> None:
    global _RUNTIME_FIELD_REGISTRY
    global _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE
    global _RUNTIME_FIELD_REGISTRY_READY

    _RUNTIME_FIELD_REGISTRY = registry
    _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = settings_module
    _RUNTIME_FIELD_REGISTRY_READY = True


def _clear_runtime_field_registry() -> None:
    global _RUNTIME_FIELD_REGISTRY
    global _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE
    global _RUNTIME_FIELD_REGISTRY_READY

    _RUNTIME_FIELD_REGISTRY = {}
    _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = None
    _RUNTIME_FIELD_REGISTRY_READY = False


def _relation_name(field: object) -> str | None:
    if getattr(field, 'hidden', False):
        return None

    if hasattr(field, 'get_accessor_name'):
        accessor = field.get_accessor_name()  # type: ignore[call-arg]
        if accessor and not _is_hidden_relation_name(str(accessor)):
            return str(accessor)

    name = getattr(field, 'name', None)
    if not name:
        return None

    name_text = str(name)
    return None if _is_hidden_relation_name(name_text) else name_text


def _is_hidden_relation_name(name: str) -> bool:
    return name.endswith('+')


def _sanitize_runtime_model_summary(
    model: RuntimeModelSummary,
) -> RuntimeModelSummary:
    visible_fields = [
        field
        for field in model.fields
        if not _is_hidden_relation_name(field.name)
    ]
    visible_relations = [
        relation
        for relation in model.relations
        if not _is_hidden_relation_name(relation.name)
    ]

    return RuntimeModelSummary(
        label=model.label,
        module=model.module,
        field_names=[
            name
            for name in model.field_names
            if not _is_hidden_relation_name(name)
        ],
        relation_names=[
            name
            for name in model.relation_names
            if not _is_hidden_relation_name(name)
        ],
        reverse_relation_names=[
            name
            for name in model.reverse_relation_names
            if not _is_hidden_relation_name(name)
        ],
        fields=visible_fields,
        relations=visible_relations,
        manager_names=list(model.manager_names),
    )


def _register_runtime_field(
    registry: dict[tuple[str, str], object],
    *,
    model_label: str,
    field: object,
) -> None:
    field_name = getattr(field, 'name', None)
    if field_name:
        registry[(model_label, str(field_name))] = field

    primary_key_field = _primary_key_alias_field(field)
    if primary_key_field is not None and (model_label, 'pk') not in registry:
        registry[(model_label, 'pk')] = primary_key_field

    attname = _relation_attname(field)
    attname_field = _relation_attname_field(field)
    if attname and attname_field is not None and (model_label, attname) not in registry:
        registry[(model_label, attname)] = attname_field


def _primary_key_alias_field(field: object) -> object | None:
    if not getattr(field, 'primary_key', False):
        return None

    return field


def _relation_attname(field: object) -> str | None:
    if not (
        getattr(field, 'many_to_one', False)
        or getattr(field, 'one_to_one', False)
    ):
        return None

    attname = getattr(field, 'attname', None)
    field_name = getattr(field, 'name', None)
    if not attname or not field_name:
        return None

    attname_text = str(attname)
    if attname_text == str(field_name):
        return None

    return attname_text


def _relation_attname_field(field: object) -> object | None:
    attname = _relation_attname(field)
    if attname is None:
        return None

    return getattr(field, 'target_field', None)


def _related_model_label(field: object) -> str | None:
    related_model = getattr(field, 'related_model', None)
    meta = getattr(related_model, '_meta', None)
    label = getattr(meta, 'label', None)
    return str(label) if label else None


def _relation_field_kind(field: object, *, reverse: bool) -> str:
    if getattr(field, 'one_to_one', False):
        return 'reverse_OneToOneField' if reverse else 'OneToOneField'

    if getattr(field, 'many_to_many', False):
        return 'reverse_ManyToManyField' if reverse else 'ManyToManyField'

    if reverse and getattr(field, 'one_to_many', False):
        return 'reverse_ForeignKey'

    if not reverse and getattr(field, 'many_to_one', False):
        return 'ForeignKey'

    field_kind = field.__class__.__name__
    return f'reverse_{field_kind}' if reverse else field_kind


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None

    return str(value)
