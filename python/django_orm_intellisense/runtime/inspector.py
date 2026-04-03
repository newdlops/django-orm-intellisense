from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass


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
class RuntimeModelSummary:
    label: str
    module: str
    field_names: list[str]
    relation_names: list[str]
    reverse_relation_names: list[str]
    relations: list[RuntimeRelationSummary]
    manager_names: list[str]

    def to_dict(self) -> dict[str, object]:
        return {
            'label': self.label,
            'module': self.module,
            'fieldNames': list(self.field_names),
            'relationNames': list(self.relation_names),
            'reverseRelationNames': list(self.reverse_relation_names),
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
        }

    @classmethod
    def from_cache_dict(cls, payload: dict[str, object]) -> RuntimeInspection:
        raw_model_catalog = payload.get('modelCatalog') or []
        raw_model_preview = payload.get('modelPreview') or []

        model_catalog = [
            RuntimeModelSummary.from_dict(dict(model))
            for model in raw_model_catalog
            if isinstance(model, dict)
        ]
        model_preview = [
            RuntimeModelSummary.from_dict(dict(model))
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
        )


def inspect_runtime(settings_module: str | None) -> RuntimeInspection:
    if importlib.util.find_spec('django') is None:
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
        relations: list[RuntimeRelationSummary] = []
        manager_names = [manager.name for manager in meta.managers]
        manager_count += len(manager_names)

        for field in meta.get_fields(include_hidden=True):
            if getattr(field, 'auto_created', False) and not getattr(field, 'concrete', True):
                reverse_name = _relation_name(field)
                if reverse_name:
                    reverse_relation_names.append(reverse_name)
                    reverse_relation_count += 1
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
                relations=relations,
                manager_names=manager_names,
            )
        )

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
    )


def _relation_name(field: object) -> str | None:
    if hasattr(field, 'get_accessor_name'):
        accessor = field.get_accessor_name()  # type: ignore[call-arg]
        if accessor:
            return str(accessor)

    name = getattr(field, 'name', None)
    return str(name) if name else None


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
