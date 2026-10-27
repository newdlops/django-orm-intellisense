"""Collect independent Django registries serially in owned child processes."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import pickle
import subprocess
import sys
import threading
import time

from ..discovery.settings import SettingsProject
from ..discovery.workspace import (PythonSourceEntry, PythonSourceSnapshot,
    _build_directory_fingerprints, _file_fingerprint, _source_stat_identity,
    _SOURCE_IDENTITY, snapshot_python_sources, source_membership_fingerprint)
from ..server.worker_lifetime import ParentExitPipe
from ..server.worker_state import _private_state_file


@dataclass(frozen=True, slots=True)
class ProjectRuntime:
    project: SettingsProject
    static_index: object
    inspection: object
    model_graph: object
    members: object
    surface: dict
    fingerprints: dict
    source_snapshot: object = None
    source_membership: str | None = None
    dependencies: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ProjectRuntimeFailure:
    project: SettingsProject
    error: str


def snapshot_project_sources(root: Path, files) -> PythonSourceSnapshot:
    entries, identities = [], []
    for path in files:
        value = path.stat()
        relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        fingerprint = _file_fingerprint(relative_path=relative, size=value.st_size,
            mtime_ns=value.st_mtime_ns, ctime_ns=value.st_ctime_ns,
            device=value.st_dev, inode=value.st_ino)
        entries.append(PythonSourceEntry(relative, value.st_size, value.st_mtime_ns, fingerprint))
        identities.append(_source_stat_identity(value))
    directories = _build_directory_fingerprints(entries)
    return PythonSourceSnapshot(str(root), directories.get('', ''), tuple(entries),
                                tuple(files), directories, tuple(identities))


def project_owner(projects, path):
    matches = [project for project in projects if path.is_relative_to(Path(project.root))]
    return max(matches, key=lambda project: len(Path(project.root).parts)) if matches else None


def project_source_files(projects, project, files):
    return tuple(path for path in files
        if (owner := project_owner(projects, path)) is None or owner == project)


def project_source_projection(root, snapshot, files):
    selected = set(files)
    entries, paths, identities = [], [], []
    assert snapshot._file_identities is not None
    for path, identity in zip(snapshot.files, snapshot._file_identities):
        if path not in selected:
            continue
        size, mtime, ctime, device, inode = _SOURCE_IDENTITY.unpack(identity) if isinstance(identity, bytes) else identity
        relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        fingerprint = _file_fingerprint(relative_path=relative, size=size, mtime_ns=mtime,
            ctime_ns=ctime, device=device, inode=inode)
        entries.append(PythonSourceEntry(relative, size, mtime, fingerprint))
        paths.append(path)
        identities.append(identity)
    directories = _build_directory_fingerprints(entries)
    return PythonSourceSnapshot(str(root), directories.get('', ''), tuple(entries),
        tuple(paths), directories, tuple(identities))


def collect_project_runtimes(projects, *, workspace_root, source_files,
                             stopping=None, is_current=lambda: True,
                             timeout_seconds=30, extra_roots=(), all_projects=None):
    """Yield one project at a time; no Django classes or resident child survive."""
    stopping = stopping if stopping is not None else threading.Event()
    projects, source_files = tuple(projects), tuple(source_files)
    ownership = tuple(all_projects) if all_projects is not None else projects
    package_root = str(Path(__file__).resolve().parents[2])
    for project in projects:
        if stopping.is_set() or not is_current():
            return
        selected = project_source_files(ownership, project, source_files)
        try:
            expected = snapshot_project_sources(Path(workspace_root), source_files)
            membership = source_membership_fingerprint(expected)
        except OSError as error:
            yield ProjectRuntimeFailure(project, 'Project source inventory changed before collection: ' + str(error))
            continue
        state = (project, str(workspace_root), selected, ownership, expected, membership, tuple(extra_roots))
        with _private_state_file(state, 'djls-project-runtime-state-') as input_path:
            result_path = Path(input_path).with_name('result.pickle')
            log_path = result_path.with_suffix('.log')
            environment = dict(os.environ)
            declared = environment.get('PYTHONPATH')
            environment['PYTHONPATH'] = package_root + (os.pathsep + declared if declared else '')
            environment['PYTHONDONTWRITEBYTECODE'] = '1'
            environment.pop('DJANGO_SETTINGS_MODULE', None)
            deadline = time.monotonic() + timeout_seconds
            with log_path.open('wb') as log, ParentExitPipe() as lifetime:
                arguments, options = lifetime.spawn_parameters()
                try:
                    child = subprocess.Popen([sys.executable, '-B', '-m',
                        'django_orm_intellisense._project_runtime_worker',
                        input_path, str(result_path), *arguments],
                        cwd=project.root, env=environment, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=log, **options)
                except OSError as error:
                    yield ProjectRuntimeFailure(project, 'Project runtime could not start: ' + str(error))
                    continue
                cancelled, expired = False, False
                try:
                    lifetime.child_spawned()
                    while child.poll() is None:
                        if stopping.wait(0.02) or not is_current():
                            cancelled = True
                            break
                        if time.monotonic() >= deadline:
                            expired = True
                            break
                finally:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait(timeout=1)
                if cancelled or stopping.is_set() or not is_current():
                    return
            if expired or child.returncode != 0:
                with log_path.open('rb') as stream:
                    stream.seek(max(0, log_path.stat().st_size - 4000))
                    detail = stream.read().decode('utf-8', errors='replace')
                value = ProjectRuntimeFailure(project,
                    f'Project runtime {"timed out" if expired else "exited with code " + str(child.returncode)}. {detail}')
            else:
                try:
                    with result_path.open('rb') as stream:
                        value = pickle.load(stream)
                    if not isinstance(value, (ProjectRuntime, ProjectRuntimeFailure)) or value.project != project:
                        raise ValueError('Project runtime result does not belong to its requested project.')
                except (OSError, EOFError, pickle.UnpicklingError, ValueError) as error:
                    value = ProjectRuntimeFailure(project, 'Project runtime did not return a valid result: ' + str(error))
        if stopping.is_set() or not is_current():
            return
        yield value
        del value


def project_worker_main(input_path, result_path):
    # This function runs only in a fresh child; Django's registry belongs to
    # exactly this project and dies with the child after pure records are saved.
    from ..features.orm_members import capture_current_runtime_members, prebuild_member_surface_cache, fingerprint_surface_index
    from ..runtime.inspector import inspect_runtime
    from ..runtime.source_imports import current_workspace_source_imports
    from ..semantic.graph import build_model_graph
    from ..static_index.indexer import build_static_index
    with Path(input_path).open('rb') as stream:
        project, workspace_root, source_files, projects, expected, expected_membership, extra_roots = pickle.load(stream)
    roots = tuple(dict.fromkeys((project.import_root, project.root, workspace_root, *map(str, extra_roots))))
    sys.path[:] = [*roots, *(entry for entry in sys.path if entry not in roots)]
    before_global = snapshot_python_sources(Path(workspace_root), extra_roots=list(extra_roots) or None, max_workers=1)
    before_membership = source_membership_fingerprint(before_global)
    with current_workspace_source_imports(tuple(Path(root) for root in roots)):
        runtime = inspect_runtime(project.settings_module)
        # Settings can import a sibling/shared helper or register an app whose
        # source is outside this project's directory. Include those sources in
        # this context, while retaining the other independent registries.
        imported = set()
        for module in tuple(sys.modules.values()):
            filename = getattr(module, '__dict__', {}).get('__file__')
            if isinstance(filename, str):
                imported.add(Path(filename))
        imported.intersection_update(before_global.files)
        dependencies = {project.namespace}
        for path in imported:
            owner = project_owner(projects, path)
            if owner is not None:
                dependencies.add(owner.namespace)
        proof_files = tuple(path for path in before_global.files
            if (owner := project_owner(projects, path)) is None or owner.namespace in dependencies)
        source_files = tuple(dict.fromkeys((*source_files, *(path for path in before_global.files if path in imported))))
        static = build_static_index(Path(project.import_root), python_files=source_files,
                                    import_roots=roots)
        graph = build_model_graph(static, runtime)
        members = (capture_current_runtime_members(static, runtime, graph)
                   if runtime.bootstrap_status == 'ready' else None)
        static._runtime_member_snapshot = members
        surface = prebuild_member_surface_cache(static, runtime, graph)
    after_global = snapshot_python_sources(Path(workspace_root), extra_roots=list(extra_roots) or None, max_workers=1)
    before = project_source_projection(Path(project.import_root), before_global, proof_files)
    expected_scope = project_source_projection(Path(project.import_root), expected, proof_files)
    after_files = tuple(path for path in after_global.files
        if (owner := project_owner(projects, path)) is None or owner.namespace in dependencies)
    after = project_source_projection(Path(project.import_root), after_global, after_files)
    value = (ProjectRuntime(project, static, runtime, graph, members, surface,
                            fingerprint_surface_index(surface), before,
                            source_membership_fingerprint(before), tuple(sorted(dependencies)))
             if expected_scope.fingerprint == before.fingerprint == after.fingerprint
             and expected_membership == before_membership == source_membership_fingerprint(after_global)
             else ProjectRuntimeFailure(project, 'Project source changed during runtime collection.'))
    with Path(result_path).open('wb') as stream:
        pickle.dump(value, stream, protocol=pickle.HIGHEST_PROTOCOL)
