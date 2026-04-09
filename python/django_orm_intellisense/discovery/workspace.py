from __future__ import annotations

import hashlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

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
class PythonSourceEntry:
    relative_path: str
    size: int
    mtime_ns: int
    fingerprint: str

    @property
    def directory_path(self) -> str:
        parent = PurePosixPath(self.relative_path).parent.as_posix()
        return '' if parent == '.' else parent


@dataclass(frozen=True)
class PythonSourceSnapshot:
    root: str
    fingerprint: str
    entries: tuple[PythonSourceEntry, ...]
    files: tuple[Path, ...]
    directory_fingerprints: dict[str, str]

    @property
    def file_count(self) -> int:
        return len(self.entries)

    @property
    def entries_by_path(self) -> dict[str, PythonSourceEntry]:
        return {
            entry.relative_path: entry
            for entry in self.entries
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


@dataclass(frozen=True)
class VenvInfo:
    root: str
    site_packages: str | None
    python_version: str | None
    include_system_site: bool

    def to_dict(self) -> dict[str, str | bool | None]:
        return {
            'root': self.root,
            'sitePackages': self.site_packages,
            'pythonVersion': self.python_version,
            'includeSystemSite': self.include_system_site,
        }


def resolve_venv_info(workspace_root: Path) -> VenvInfo | None:
    """Detect and parse a virtual environment in the workspace."""
    for candidate_name in ('.venv', 'venv', '.env', 'env'):
        venv_root = workspace_root / candidate_name
        pyvenv_cfg = venv_root / 'pyvenv.cfg'
        if pyvenv_cfg.exists():
            return _parse_venv(venv_root, pyvenv_cfg)
    return None


def _parse_venv(venv_root: Path, pyvenv_cfg: Path) -> VenvInfo:
    cfg: dict[str, str] = {}
    try:
        for line in pyvenv_cfg.read_text(encoding='utf-8').splitlines():
            if '=' in line:
                key, _, value = line.partition('=')
                cfg[key.strip().lower()] = value.strip()
    except OSError:
        pass

    python_version = cfg.get('version') or cfg.get('version_info')
    if python_version:
        # Normalize to X.Y
        parts = python_version.split('.')
        if len(parts) >= 2:
            python_version = f'{parts[0]}.{parts[1]}'

    include_system = cfg.get('include-system-site-packages', 'false').lower() == 'true'

    # Find site-packages directory
    site_packages: str | None = None
    if python_version:
        if sys.platform == 'win32':
            candidate = venv_root / 'Lib' / 'site-packages'
        else:
            candidate = venv_root / 'lib' / f'python{python_version}' / 'site-packages'
        if candidate.is_dir():
            site_packages = str(candidate)

    # Fallback: search for site-packages
    if site_packages is None:
        lib_dir = venv_root / ('Lib' if sys.platform == 'win32' else 'lib')
        if lib_dir.is_dir():
            for child in lib_dir.iterdir():
                sp = child / 'site-packages'
                if sp.is_dir():
                    site_packages = str(sp)
                    if python_version is None:
                        # Extract version from directory name (e.g. python3.11)
                        name = child.name
                        if name.startswith('python'):
                            python_version = name[len('python'):]
                    break

    return VenvInfo(
        root=str(venv_root),
        site_packages=site_packages,
        python_version=python_version,
        include_system_site=include_system,
    )


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


def snapshot_python_sources(root: Path) -> PythonSourceSnapshot:
    python_files = iter_python_files(root)

    def _stat_one(python_file: Path) -> tuple[Path, PythonSourceEntry] | None:
        try:
            stat_result = python_file.stat()
        except OSError:
            return None
        relative_path = python_file.relative_to(root).as_posix()
        fingerprint = _file_fingerprint(
            relative_path=relative_path,
            size=stat_result.st_size,
            mtime_ns=stat_result.st_mtime_ns,
        )
        return (
            python_file,
            PythonSourceEntry(
                relative_path=relative_path,
                size=stat_result.st_size,
                mtime_ns=stat_result.st_mtime_ns,
                fingerprint=fingerprint,
            ),
        )

    entries: list[PythonSourceEntry] = []
    files: list[Path] = []

    with ThreadPoolExecutor(max_workers=8) as executor:
        for result in executor.map(_stat_one, python_files):
            if result is not None:
                files.append(result[0])
                entries.append(result[1])

    directory_fingerprints = _build_directory_fingerprints(entries)

    return PythonSourceSnapshot(
        root=str(root),
        fingerprint=directory_fingerprints.get('', hashlib.sha256().hexdigest()),
        entries=tuple(entries),
        files=tuple(files),
        directory_fingerprints=directory_fingerprints,
    )


def discover_workspace(
    root: Path,
    settings_override: str | None = None,
    python_files: list[Path] | tuple[Path, ...] | None = None,
) -> WorkspaceProfile:
    manage_py_file = root / 'manage.py'
    manage_py_path = str(manage_py_file) if manage_py_file.exists() else None
    settings_candidates: list[str] = []
    pyproject_path = root / 'pyproject.toml'

    if manage_py_path is not None or settings_override is not None:
        settings_candidates.extend(
            _discover_settings_candidates(root, python_files=python_files)
        )

    deduped_settings = list(dict.fromkeys(settings_candidates))
    inferred_settings = _choose_default_settings_module(deduped_settings)

    return WorkspaceProfile(
        root=str(root),
        manage_py_path=manage_py_path,
        pyproject_path=str(pyproject_path) if pyproject_path.exists() else None,
        settings_module=settings_override or inferred_settings,
        settings_candidates=deduped_settings,
    )


def _discover_settings_candidates(
    root: Path,
    python_files: list[Path] | tuple[Path, ...] | None = None,
) -> list[str]:
    candidates: list[str] = []

    source_files = list(python_files) if python_files is not None else iter_python_files(root)

    for python_file in source_files:
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


def _file_fingerprint(
    *,
    relative_path: str,
    size: int,
    mtime_ns: int,
) -> str:
    digest = hashlib.sha256()
    digest.update(relative_path.encode('utf-8'))
    digest.update(b'\0')
    digest.update(str(size).encode('ascii'))
    digest.update(b':')
    digest.update(str(mtime_ns).encode('ascii'))
    return digest.hexdigest()


def _build_directory_fingerprints(
    entries: list[PythonSourceEntry],
) -> dict[str, str]:
    directories: set[str] = {''}
    direct_files: dict[str, list[tuple[str, str]]] = {}
    direct_directories: dict[str, set[str]] = {}

    for entry in entries:
        file_name = PurePosixPath(entry.relative_path).name
        direct_files.setdefault(entry.directory_path, []).append(
            (file_name, entry.fingerprint)
        )

        current_directory = entry.directory_path
        while True:
            directories.add(current_directory)
            if current_directory == '':
                break

            parent_directory = _parent_directory(current_directory)
            child_directory_name = PurePosixPath(current_directory).name
            direct_directories.setdefault(parent_directory, set()).add(
                child_directory_name
            )
            current_directory = parent_directory

    directory_fingerprints: dict[str, str] = {}
    ordered_directories = sorted(
        directories,
        key=lambda directory_path: directory_path.count('/'),
        reverse=True,
    )

    for directory_path in ordered_directories:
        digest = hashlib.sha256()

        for file_name, fingerprint in sorted(direct_files.get(directory_path, [])):
            digest.update(b'F\0')
            digest.update(file_name.encode('utf-8'))
            digest.update(b'\0')
            digest.update(fingerprint.encode('ascii'))
            digest.update(b'\0')

        for child_directory_name in sorted(
            direct_directories.get(directory_path, set())
        ):
            child_directory_path = (
                child_directory_name
                if not directory_path
                else f'{directory_path}/{child_directory_name}'
            )
            child_fingerprint = directory_fingerprints.get(child_directory_path)
            if child_fingerprint is None:
                continue

            digest.update(b'D\0')
            digest.update(child_directory_name.encode('utf-8'))
            digest.update(b'\0')
            digest.update(child_fingerprint.encode('ascii'))
            digest.update(b'\0')

        directory_fingerprints[directory_path] = digest.hexdigest()

    return directory_fingerprints


def _parent_directory(directory_path: str) -> str:
    parent = PurePosixPath(directory_path).parent.as_posix()
    return '' if parent == '.' else parent
