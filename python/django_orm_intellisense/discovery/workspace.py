from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {
    '.git',
    '.hg',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    '.svn',
    '.tox',
    '.venv',
    '__pycache__',
    'build',
    'dist',
    'node_modules',
    'out',
    'venv',
}


@dataclass(frozen=True)
class WorkspaceProfile:
    root: str
    manage_py_path: str | None
    pyproject_path: str | None
    settings_module: str | None
    settings_candidates: list[str]

    def to_dict(self) -> dict[str, str | None | list[str]]:
        return {
            'root': self.root,
            'managePyPath': self.manage_py_path,
            'pyprojectPath': self.pyproject_path,
            'settingsModule': self.settings_module,
            'settingsCandidates': list(self.settings_candidates),
        }


def iter_python_files(root: Path) -> list[Path]:
    python_files: list[Path] = []

    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            name
            for name in dirnames
            if name not in SKIP_DIRS and not name.startswith('.')
        ]

        for filename in filenames:
            if filename.endswith('.py'):
                python_files.append(Path(current_root, filename))

    python_files.sort()
    return python_files


def discover_workspace(
    root: Path, settings_override: str | None = None
) -> WorkspaceProfile:
    manage_py_file = root / 'manage.py'
    manage_py_path = str(manage_py_file) if manage_py_file.exists() else None
    settings_candidates: list[str] = []
    pyproject_path = root / 'pyproject.toml'

    if manage_py_path is not None or settings_override is not None:
        settings_candidates.extend(_discover_settings_candidates(root))

    deduped_settings = list(dict.fromkeys(settings_candidates))
    inferred_settings = _choose_default_settings_module(deduped_settings)

    return WorkspaceProfile(
        root=str(root),
        manage_py_path=manage_py_path,
        pyproject_path=str(pyproject_path) if pyproject_path.exists() else None,
        settings_module=settings_override or inferred_settings,
        settings_candidates=deduped_settings,
    )


def _discover_settings_candidates(root: Path) -> list[str]:
    candidates: list[str] = []

    for python_file in iter_python_files(root):
        if python_file.name == 'settings.py':
            candidates.append(_module_name_from_path(root, python_file))
            continue

        if python_file.parent.name != 'settings':
            continue

        if python_file.name == '__init__.py':
            candidates.append(_module_name_from_path(root, python_file.parent))
            continue

        candidates.append(_module_name_from_path(root, python_file))

    return candidates


def _choose_default_settings_module(settings_candidates: list[str]) -> str | None:
    if len(settings_candidates) == 1:
        return settings_candidates[0]

    return None


def _module_name_from_path(root: Path, file_path: Path) -> str:
    relative_path = file_path.relative_to(root)
    return '.'.join(relative_path.with_suffix('').parts)
