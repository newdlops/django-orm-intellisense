from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from .settings import SettingsSource, discover_settings_sources, read_declared_settings

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


SOURCE_FINGERPRINT_VERSION = 2
_SOURCE_IDENTITY = struct.Struct('>qqqQQ')


def _source_stat_identity(stat_result):
    identity = (stat_result.st_size, stat_result.st_mtime_ns,
                stat_result.st_ctime_ns, stat_result.st_dev, stat_result.st_ino)
    try:
        return _SOURCE_IDENTITY.pack(*identity)
    except struct.error:
        # Preserve exact values for unusual platforms/ranges without changing
        # the source fingerprint or rejecting a readable source file.
        return identity


@dataclass(frozen=True, slots=True)
class PythonSourceEntry:
    relative_path: str
    size: int
    mtime_ns: int
    fingerprint: str

    def __getstate__(self):
        return (
            self.relative_path, self.size, self.mtime_ns, self.fingerprint,
        )

    def __setstate__(self, state):
        (
            relative_path, size, mtime_ns, fingerprint,
        ) = state
        assign = object.__setattr__
        assign(self, 'relative_path', relative_path)
        assign(self, 'size', size)
        assign(self, 'mtime_ns', mtime_ns)
        assign(self, 'fingerprint', fingerprint)

    def to_dict(self) -> dict[str, str | int]:
        return {
            'relativePath': self.relative_path,
            'size': self.size,
            'mtimeNs': self.mtime_ns,
            'fingerprint': self.fingerprint,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> PythonSourceEntry:
        return cls(
            relative_path=str(payload['relativePath']),
            size=int(payload['size']),
            mtime_ns=int(payload['mtimeNs']),
            fingerprint=str(payload['fingerprint']),
        )

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
    # In-process evidence only. Disk snapshots must undergo a full stat/hash
    # pass before they can become the owner of a cheap revalidation.
    _file_identities: tuple[bytes | tuple[int, int, int, int, int], ...] | None = field(
        default=None, compare=False, repr=False)

    def to_cache_dict(self) -> dict[str, object]:
        return {
            'fingerprintVersion': SOURCE_FINGERPRINT_VERSION,
            'root': self.root,
            'fingerprint': self.fingerprint,
            'entries': [entry.to_dict() for entry in self.entries],
            'directoryFingerprints': dict(self.directory_fingerprints),
        }

    @classmethod
    def from_cache_dict(cls, payload: dict[str, object]) -> PythonSourceSnapshot:
        if payload.get('fingerprintVersion') != SOURCE_FINGERPRINT_VERSION:
            raise ValueError('Source snapshot uses an obsolete file fingerprint.')
        root = str(payload['root'])
        fingerprint = str(payload['fingerprint'])
        raw_entries = payload.get('entries')
        raw_directory_fingerprints = payload.get('directoryFingerprints')
        if not isinstance(raw_entries, list):
            raise ValueError('Invalid source snapshot cache payload: entries.')
        if not isinstance(raw_directory_fingerprints, dict):
            raise ValueError(
                'Invalid source snapshot cache payload: directoryFingerprints.'
            )

        entries = tuple(
            PythonSourceEntry.from_dict(dict(entry))
            for entry in raw_entries
            if isinstance(entry, dict)
        )
        root_path = Path(root)
        files = tuple(
            path if path.is_absolute() else root_path / path
            for path in (Path(entry.relative_path) for entry in entries)
        )
        return cls(
            root=root,
            fingerprint=fingerprint,
            entries=entries,
            files=files,
            directory_fingerprints={
                str(directory_path): str(directory_fingerprint)
                for directory_path, directory_fingerprint in raw_directory_fingerprints.items()
            },
        )

    @property
    def file_count(self) -> int:
        return len(self.entries)

    @property
    def entries_by_path(self) -> dict[str, PythonSourceEntry]:
        return {
            entry.relative_path: entry
            for entry in self.entries
        }


def source_membership_fingerprint(snapshot: PythonSourceSnapshot) -> str:
    """Capture canonical source membership separately from the v2 stat hash.

    Hardlinks can give different symlink targets identical stat identities.
    Capture this before consuming runtime caches/importing project code, then
    compare it at publication. A capture at save time cannot label older data.
    Parent realpaths are shared across regular siblings; only file symlinks
    need their own realpath. Errors reject the complete witness.
    """
    if len(snapshot.entries) != len(snapshot.files):
        raise ValueError('Source membership inventory is incomplete')
    root = os.path.realpath(snapshot.root, strict=True)
    if not stat.S_ISDIR(os.stat(root).st_mode):
        raise ValueError('Source membership root is not a directory')
    digest = hashlib.sha256(b'django-orm-source-membership-v1\0')
    digest.update(f'R\0{root}\0'.encode('utf-8'))
    parents: dict[str, str] = {}
    for entry, file_path in sorted(zip(snapshot.entries, snapshot.files), key=lambda item: item[0].relative_path):
        raw = str(file_path)
        kind = os.lstat(raw).st_mode
        if stat.S_ISLNK(kind):
            canonical = os.path.realpath(raw, strict=True)
            if not stat.S_ISREG(os.stat(canonical).st_mode):
                raise ValueError('Source membership link is not a regular file')
        elif stat.S_ISREG(kind):
            if os.name == 'posix':
                parent, _, leaf = raw.rpartition('/')
                if parent in ('', '/'):
                    parent, leaf = os.path.split(raw)
            else:
                parent, leaf = os.path.split(raw)
            canonical_parent = parents.get(parent)
            if canonical_parent is None:
                canonical_parent = os.path.realpath(parent, strict=True)
                parents[parent] = canonical_parent
            # Most regular files already use their canonical parent spelling.
            # Keep every lstat/strict parent check; avoid rebuilding that same
            # full path and the generic path dispatch for every sibling.
            canonical = raw if canonical_parent == parent else os.path.join(canonical_parent, leaf)
        else:
            raise ValueError('Source membership entry is not a regular file')
        digest.update(f'F\0{entry.relative_path}\0{canonical}\0'.encode('utf-8'))
    return digest.hexdigest()


@dataclass(frozen=True)
class WorkspaceProfile:
    root: str
    manage_py_path: str | None
    pyproject_path: str | None
    settings_module: str | None
    settings_candidates: list[str]
    settings_sources: tuple[SettingsSource, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            'root': self.root,
            'managePyPath': self.manage_py_path,
            'pyprojectPath': self.pyproject_path,
            'settingsModule': self.settings_module,
            'settingsCandidates': list(self.settings_candidates),
            'settingsSources': [source.to_dict() for source in self.settings_sources],
        }


@dataclass(frozen=True)
class EditableInstall:
    """A pip editable install detected in site-packages."""
    name: str
    path: str   # absolute path to the source directory
    kind: str   # 'egg-link' | 'direct-url'

    def to_dict(self) -> dict[str, str]:
        return {'name': self.name, 'path': self.path, 'kind': self.kind}


@dataclass(frozen=True)
class VenvInfo:
    root: str
    site_packages: str | None
    python_version: str | None
    include_system_site: bool
    editable_installs: tuple[EditableInstall, ...] = ()

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = {
            'root': self.root,
            'sitePackages': self.site_packages,
            'pythonVersion': self.python_version,
            'includeSystemSite': self.include_system_site,
        }
        if self.editable_installs:
            d['editableInstalls'] = [ei.to_dict() for ei in self.editable_installs]
        return d


_RELATIVE_METADATA_SUPPORTED = (os.open in os.supports_dir_fd and os.scandir in os.supports_fd)
_METADATA_OPEN_FLAGS = os.O_RDONLY | getattr(os, 'O_BINARY', 0)
_METADATA_READ_BYTES = 64 * 1024


def _metadata_descriptor(path: str, directory_fd: int | None):
    return os.open(path, _METADATA_OPEN_FLAGS) if directory_fd is None else os.open(path, _METADATA_OPEN_FLAGS, dir_fd=directory_fd)


def _read_direct_url_metadata(path: str, *, directory_fd: int | None = None):
    # Most installed distributions have no direct_url.json. Avoid allocating
    # FileIO/TextIOWrapper objects for every missing file; always perform the
    # actual open so new/changed metadata remains visible without a cache.
    descriptor = _metadata_descriptor(path, directory_fd)
    try:
        # Read through the owned descriptor without a FileIO/TextIOWrapper.
        # Short reads do not imply EOF. Small records take a direct decode;
        # larger/fragmented records decode incrementally so no second full
        # byte buffer is retained alongside the decoded JSON text.
        chunk = os.read(descriptor, _METADATA_READ_BYTES)
        next_chunk = os.read(descriptor, _METADATA_READ_BYTES)
        if not next_chunk:
            return json.loads(chunk.decode('utf-8'))
        from codecs import getincrementaldecoder
        decoder = getincrementaldecoder('utf-8')()
        text_chunks = [decoder.decode(chunk), decoder.decode(next_chunk)]
        del next_chunk
        while chunk := os.read(descriptor, _METADATA_READ_BYTES):
            text_chunks.append(decoder.decode(chunk))
        text_chunks.append(decoder.decode(b'', final=True))
        return json.loads(''.join(text_chunks))
    finally:
        os.close(descriptor)


def find_editable_installs(site_packages: str, *, include_missing_targets: bool = False) -> list[EditableInstall]:
    """Detect pip editable installs in site-packages.

    Supports two formats:
    1. Legacy .egg-link files (pip < 21.3)
    2. Modern PEP 610 direct_url.json with editable flag (pip >= 21.3)

    Missing targets are included only for observation hints. That mode retains
    anchored legacy names so their symlink changes can trigger fresh discovery.
    """
    directory_fd = None
    try:
        # Keep relative egg-link targets anchored to the directory we scan,
        # including when the original site-packages symlink is retargeted.
        site_packages = os.path.realpath(site_packages)
        if _RELATIVE_METADATA_SUPPORTED:
            directory_fd = os.open(site_packages, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        if include_missing_targets:
            return _editable_installs_in_directory(site_packages, directory_fd, include_missing_targets=True)
        return _editable_installs_in_directory(site_packages, directory_fd)
    except OSError:
        return []
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def _editable_installs_in_directory(site_packages: str, directory_fd: int | None, *, include_missing_targets: bool = False):
    installs: list[EditableInstall] = []
    # Scan and read relative to the same opened directory where supported.
    # This avoids repeated root traversal and remains consistent if a venv
    # symlink is switched while this discovery call is in progress.
    egg_links: list[str] = []
    dist_infos: list[str] = []
    try:
        with os.scandir(site_packages if directory_fd is None else directory_fd) as entries:
            for entry in entries:
                if entry.name.endswith('.egg-link'):
                    egg_links.append(entry.name)
                elif entry.name.endswith('.dist-info'):
                    dist_infos.append(entry.name)
    except OSError:
        return installs

    # Legacy: .egg-link files
    for egg_link_name in egg_links:
        egg_link = Path(egg_link_name)
        try:
            if directory_fd is None:
                lines = (Path(site_packages) / egg_link).read_text(encoding='utf-8').splitlines()
            else:
                descriptor = _metadata_descriptor(egg_link_name, directory_fd)
                try:
                    with open(descriptor, encoding='utf-8', closefd=False) as metadata:
                        lines = metadata.read().splitlines()
                finally:
                    os.close(descriptor)
            if lines:
                target = lines[0].strip()
                if target and not os.path.isabs(target):
                    anchored = os.path.join(site_packages, target)
                    target = anchored if include_missing_targets else os.path.realpath(anchored)
                if target and (include_missing_targets or Path(target).is_dir()):
                    installs.append(EditableInstall(
                        name=egg_link.stem,
                        path=target,
                        kind='egg-link',
                    ))
        except (OSError, UnicodeError):
            continue

    # Modern: PEP 610 direct_url.json in .dist-info directories
    for dist_info_name in dist_infos:
        relative_path = dist_info_name + '/direct_url.json'
        du = os.path.join(site_packages, relative_path) if directory_fd is None else relative_path
        try:
            data = _read_direct_url_metadata(du, directory_fd=directory_fd)
            if not isinstance(data, dict):
                continue
            directory_info = data.get('dir_info')
            if not isinstance(directory_info, dict) or directory_info.get('editable') is not True:
                continue
            url = data.get('url')
            if not isinstance(url, str):
                continue
            # Import URL parsing only when editable metadata actually needs it.
            # PEP 610 file URLs escape spaces and may name the local authority.
            from urllib.parse import unquote, urlsplit
            parsed_url = urlsplit(url)
            if parsed_url.scheme != 'file' or parsed_url.netloc.lower() not in ('', 'localhost'):
                continue
            path = unquote(parsed_url.path, errors='strict')
            if os.name == 'nt' and len(path) >= 3 and path[0] == '/' and path[2] == ':':
                path = path[1:]
            if include_missing_targets or Path(path).is_dir():
                # Extract package name from dist-info dir name
                dist_info = Path(dist_info_name)
                name = dist_info.name.split('-')[0] if '-' in dist_info.name else dist_info.stem
                installs.append(EditableInstall(
                    name=name,
                    path=path,
                    kind='direct-url',
                ))
        except (OSError, UnicodeError, ValueError):
            continue

    return installs


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

    # Detect editable installs in site-packages
    editable: tuple[EditableInstall, ...] = ()
    if site_packages:
        editable = tuple(find_editable_installs(site_packages))

    return VenvInfo(
        root=str(venv_root),
        site_packages=site_packages,
        python_version=python_version,
        include_system_site=include_system,
        editable_installs=editable,
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

    # POSIX Path ordering compares component tuples. Compute that key once
    # instead of reparsing/comparing Path objects throughout the sort.
    if os.name == 'posix':
        python_files.sort(key=lambda path: path.parts)
    else:
        python_files.sort()
    return python_files


def _unchanged_source_inventory(root: Path, extra_roots, previous_snapshot):
    # The previous files already own parsed Path objects. On normalized POSIX
    # roots, verify current membership with raw walk paths and reuse those
    # objects instead of parsing and comparing every path again. Other lexical
    # forms/platforms continue through the ordinary inventory implementation.
    roots = (root, *(extra_roots or ()))
    if (os.name != 'posix' or previous_snapshot is None
            or previous_snapshot.root != str(root)
            or previous_snapshot._file_identities is None
            or any(os.path.normpath(str(folder)) != str(folder) for folder in roots)):
        return None
    # Mark paths owned by the prior snapshot instead of retaining a second
    # set of newly joined strings; overlapping roots can visit each path again.
    expected = dict.fromkeys(map(str, previous_snapshot.files), False)
    observed = 0
    for folder in dict.fromkeys(roots):
        for current_root, dirnames, filenames in os.walk(folder):
            dirnames[:] = [name for name in dirnames
                          if name not in SKIP_DIRS and not name.startswith('.')]
            for filename in filenames:
                if filename.endswith('.py'):
                    path = os.path.join(current_root, filename)
                    if path.startswith('./'):
                        path = path[2:]
                    seen = expected.get(path)
                    if seen is None:
                        return None
                    if not seen:
                        expected[path] = True
                        observed += 1
    return previous_snapshot.files if observed == len(expected) else None


def snapshot_python_sources(
    root: Path,
    extra_roots: list[Path] | None = None,
    *,
    max_workers: int = 8,
    previous_snapshot: PythonSourceSnapshot | None = None,
) -> PythonSourceSnapshot:
    python_files = _unchanged_source_inventory(root, extra_roots, previous_snapshot)
    unchanged_inventory = python_files is not None
    if not unchanged_inventory:
        python_files = iter_python_files(root)
    root_parts = root.parts if os.name == 'posix' else None

    # Include files from extra roots (e.g. editable installs)
    if extra_roots and not unchanged_inventory:
        seen = set(python_files)
        for extra_root in dict.fromkeys(extra_roots):
            if extra_root.is_dir() and extra_root != root:
                for f in iter_python_files(extra_root):
                    if f not in seen:
                        python_files.append(f)
                        seen.add(f)
        if os.name == 'posix':
            python_files.sort(key=lambda path: path.parts)
        else:
            python_files.sort()

    previous_identities = None
    if (previous_snapshot is not None and previous_snapshot.root == str(root)
            and previous_snapshot._file_identities is not None
            and tuple(python_files) == previous_snapshot.files
            and len(previous_snapshot._file_identities) == len(python_files)):
        previous_identities = previous_snapshot._file_identities

    def _stat_one(offset: int, python_file: Path):
        try:
            stat_result = python_file.stat()
        except OSError:
            return None
        identity = _source_stat_identity(stat_result)
        if previous_identities is not None and identity == previous_identities[offset]:
            return python_file, previous_snapshot.entries[offset], previous_identities[offset]
        # For files outside workspace root, use absolute path as relative
        if root_parts is not None:
            # POSIX relative_to is a lexical component-prefix operation. The
            # parsed paths are already available; avoid constructing every
            # parent Path merely to find that prefix. Do not resolve symlinks
            # or normalize '..' differently from pathlib.
            parts = python_file.parts
            relative_path = ('/'.join(parts[len(root_parts):]) or '.') if (
                parts[:len(root_parts)] == root_parts
            ) else str(python_file)
        else:
            try:
                relative_path = python_file.relative_to(root).as_posix()
            except ValueError:
                relative_path = str(python_file)
        fingerprint = _file_fingerprint(
            relative_path=relative_path,
            size=stat_result.st_size,
            mtime_ns=stat_result.st_mtime_ns,
            ctime_ns=stat_result.st_ctime_ns,
            device=stat_result.st_dev,
            inode=stat_result.st_ino,
        )
        return (
            python_file,
            PythonSourceEntry(
                relative_path=relative_path,
                size=stat_result.st_size,
                mtime_ns=stat_result.st_mtime_ns,
                fingerprint=fingerprint,
            ),
            identity,
        )

    entries: list[PythonSourceEntry] = []
    files: list[Path] = []
    identities = []

    def _stat_batch(offset: int):
        return [result for number in range(offset, min(offset + 64, len(python_files)))
                if (result := _stat_one(number, python_files[number])) is not None]

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for batch in executor.map(_stat_batch, range(0, len(python_files), 64)):
            for python_file, entry, identity in batch:
                files.append(python_file)
                entries.append(entry)
                identities.append(identity)

    if (previous_identities is not None and tuple(identities) == previous_identities
            and len(files) == len(python_files)):
        return previous_snapshot

    directory_fingerprints = _build_directory_fingerprints(entries)

    return PythonSourceSnapshot(
        root=str(root),
        fingerprint=directory_fingerprints.get('', hashlib.sha256().hexdigest()),
        entries=tuple(entries),
        files=tuple(files),
        directory_fingerprints=directory_fingerprints,
        _file_identities=tuple(identities),
    )


def discover_workspace(
    root: Path,
    settings_override: str | None = None,
    python_files: list[Path] | tuple[Path, ...] | None = None,
) -> WorkspaceProfile:
    manage_py_file = root / 'manage.py'
    manage_py_path = str(manage_py_file) if manage_py_file.exists() else None
    pyproject_path = root / 'pyproject.toml'
    source_files = python_files if python_files is not None else iter_python_files(root)
    settings_sources = discover_settings_sources(root, source_files)
    deduped_settings = [source.selector for source in settings_sources]

    # The project's own declared default — `os.environ.setdefault(
    # 'DJANGO_SETTINGS_MODULE', '<module>')` in manage.py (or wsgi/asgi) — is
    # the authoritative choice. It works for monorepos and for base/dev/prod
    # layouts where simple candidate-counting yields None (the case the old
    # `_choose_default_settings_module` could not resolve).
    declared_default = next((source.selector for source in settings_sources
        if str(manage_py_file) in source.entrypoints), None)
    if declared_default is None:
        declared_default = next((source.selector for source in settings_sources
            if source.project_root == str(root) and source.entrypoints), None)
    if declared_default and declared_default not in deduped_settings:
        # Surface it in the picker even when file-name discovery missed it
        # (e.g. settings in a non-standard location).
        deduped_settings.append(declared_default)

    inferred_settings = (
        declared_default
        or _choose_default_settings_module(deduped_settings)
    )

    return WorkspaceProfile(
        root=str(root),
        manage_py_path=manage_py_path,
        pyproject_path=str(pyproject_path) if pyproject_path.exists() else None,
        settings_module=settings_override or inferred_settings,
        settings_candidates=deduped_settings,
        settings_sources=settings_sources,
    )


# `os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proj.settings')` —
# tolerant of single/double quotes and whitespace.
_SETTINGS_SETDEFAULT_RE = re.compile(
    r"""setdefault\(\s*['"]DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)['"]""",
)


def _settings_module_from_entrypoints(root: Path) -> str | None:
    """Extract the declared DJANGO_SETTINGS_MODULE from the project's standard
    entrypoints. manage.py is authoritative; wsgi.py / asgi.py are consulted as
    a fallback. Returns None if no entrypoint declares one."""
    candidates = [root / 'manage.py']
    # wsgi/asgi usually live in the settings package (one level down); scan the
    # immediate subdirectories for them without a full tree walk.
    for child in _safe_iterdir(root):
        if child.is_dir():
            candidates.append(child / 'wsgi.py')
            candidates.append(child / 'asgi.py')

    for candidate in candidates:
        module = _read_settings_setdefault(candidate)
        if module:
            return module
    return None


def _read_settings_setdefault(file_path: Path) -> str | None:
    modules = read_declared_settings(file_path)
    return modules[0] if modules else None


def _safe_iterdir(root: Path) -> list[Path]:
    try:
        return [
            child
            for child in root.iterdir()
            if child.name not in SKIP_DIRS and not child.name.startswith('.')
        ]
    except OSError:
        return []


def _has_nested_manage_py(
    root: Path,
    python_files: list[Path] | tuple[Path, ...] | None = None,
) -> bool:
    """Whether any subdirectory (not the root itself) contains a manage.py.

    Reuses the already-snapshotted python file list when available so monorepo
    detection costs nothing extra; falls back to a tree walk otherwise. A
    nested manage.py is the signal that this is a multi-service workspace whose
    Django settings live below the root.
    """
    source_files = (
        list(python_files) if python_files is not None else iter_python_files(root)
    )
    return any(
        python_file.name == 'manage.py' and python_file.parent != root
        for python_file in source_files
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
    ctime_ns: int,
    device: int,
    inode: int,
) -> str:
    payload = relative_path.encode('utf-8') + b'\0' + ':'.join(
        map(str, (size, mtime_ns, ctime_ns, device, inode))
    ).encode('ascii')
    return hashlib.sha256(payload).hexdigest()


def _build_directory_fingerprints(
    entries: list[PythonSourceEntry],
) -> dict[str, str]:
    directories: set[str] = {''}
    direct_files: dict[str, list[tuple[str, str]]] = {}
    direct_directories: dict[str, set[str]] = {}

    for entry in entries:
        if (entry.relative_path.startswith('/') if os.name == 'posix'
                else Path(entry.relative_path).is_absolute()):
            # Editable sources outside the workspace use absolute keys. Hash
            # them as distinct root leaves, rather than ascending beyond '/'.
            direct_files.setdefault('', []).append((entry.relative_path, entry.fingerprint))
            continue
        directory_path, _, file_name = entry.relative_path.rpartition('/')
        direct_files.setdefault(directory_path, []).append(
            (file_name, entry.fingerprint)
        )

        current_directory = directory_path
        # Each directory contributes its parent edge once, independent of the
        # number of source files stored beneath it.
        while current_directory not in directories:
            directories.add(current_directory)
            parent_directory = _parent_directory(current_directory)
            child_directory_name = current_directory.rpartition('/')[2]
            direct_directories.setdefault(parent_directory, set()).add(
                child_directory_name
            )
            current_directory = parent_directory

    directory_fingerprints: dict[str, str] = {}
    ordered_directories = sorted(
        directories,
        # The root has depth zero; a top-level directory has depth one.
        # Counting only '/' tied them, allowing the root to be hashed before
        # its children and silently omit their source changes.
        key=lambda directory_path: directory_path.count('/') + bool(directory_path),
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
    return '' if parent == '.' or parent == directory_path else parent
