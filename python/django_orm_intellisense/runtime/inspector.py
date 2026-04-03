from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeModelSummary:
    label: str
    module: str
    field_names: list[str]
    relation_names: list[str]
    reverse_relation_names: list[str]
    manager_names: list[str]

    def to_dict(self) -> dict[str, str | list[str]]:
        return {
            'label': self.label,
            'module': self.module,
            'fieldNames': list(self.field_names),
            'relationNames': list(self.relation_names),
            'reverseRelationNames': list(self.reverse_relation_names),
            'managerNames': list(self.manager_names),
        }


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

    def to_dict(self) -> dict[str, str | bool | int | None | list[dict[str, str | list[str]]]]:
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
        manager_names = [manager.name for manager in meta.managers]
        manager_count += len(manager_names)

        for field in meta.get_fields(include_hidden=True):
            if getattr(field, 'auto_created', False) and not getattr(field, 'concrete', True):
                reverse_name = _relation_name(field)
                if reverse_name:
                    reverse_relation_names.append(reverse_name)
                    reverse_relation_count += 1
                continue

            field_names.append(field.name)
            field_count += 1

            if getattr(field, 'is_relation', False) and getattr(field, 'related_model', None) is not None:
                relation_names.append(field.name)
                relation_count += 1

        model_preview.append(
            RuntimeModelSummary(
                label=f'{meta.app_label}.{meta.object_name}',
                module=model.__module__,
                field_names=field_names,
                relation_names=relation_names,
                reverse_relation_names=reverse_relation_names,
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
