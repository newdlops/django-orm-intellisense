from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeInspection:
    python_executable: str
    django_importable: bool
    django_version: str | None
    bootstrap_status: str
    settings_module: str | None

    def to_dict(self) -> dict[str, str | bool | None]:
        return {
            'pythonPath': self.python_executable,
            'djangoImportable': self.django_importable,
            'djangoVersion': self.django_version,
            'bootstrapStatus': self.bootstrap_status,
            'settingsModule': self.settings_module,
        }


def inspect_runtime(settings_module: str | None) -> RuntimeInspection:
    if importlib.util.find_spec('django') is None:
        return RuntimeInspection(
            python_executable=sys.executable,
            django_importable=False,
            django_version=None,
            bootstrap_status='skipped_missing_django',
            settings_module=settings_module,
        )

    import django  # type: ignore

    return RuntimeInspection(
        python_executable=sys.executable,
        django_importable=True,
        django_version=getattr(django, 'get_version', lambda: None)(),
        bootstrap_status='not_attempted',
        settings_module=settings_module,
    )
