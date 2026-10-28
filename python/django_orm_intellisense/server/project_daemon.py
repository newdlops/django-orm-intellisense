"""Repository coordinator for independent Django settings/registries."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import threading

from ..discovery.settings import settings_projects
from ..discovery.workspace import discover_workspace, snapshot_python_sources, resolve_venv_info
from ..discovery.source_observation import source_observation_context
from ..features.orm_members import prebuild_member_surface_cache, fingerprint_surface_index
from ..runtime.inspector import create_pending_runtime_inspection
from ..runtime.projects import (ProjectRuntime, ProjectRuntimeFailure, collect_project_runtimes,
    project_source_files, project_source_projection, snapshot_project_sources)
from ..runtime.projects import copy_source_index
from ..semantic.graph import build_model_graph
from ..static_index.indexer import build_static_index
from .app import DaemonServer
from .workspace_projects import WorkspaceProjects, _METHODS


class ProjectDaemonServer(DaemonServer):
    """Reuse the single-project engine; never configure Django in this parent."""
    def __init__(self, workspace_root):
        super().__init__(workspace_root)
        self._projects = None
        self._projects_stop = threading.Event()
        self._projects_thread = None
        self._projects_timer = None
        self._projects_revision = 0
        self._projects_collect_lock = threading.Lock()
        self._projects_params = {}
        self._projects_observation = None
        self._projects_payload = None

    def _close_projects(self):
        with self._state_lock:
            self._projects_stop.set()
            if self._projects_timer is not None:
                self._projects_timer.cancel()
                self._projects_timer = None
            previous, self._projects = self._projects, None
            if previous is not None:
                previous.close()
            self._projects_payload = None

    def run_stdio(self):
        try:
            super().run_stdio()
        finally:
            self._close_projects()
            thread = self._projects_thread
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=2)

    def _initialize(self, params, *, observation_attempt=0):
        root = Path(str(params.get('workspaceRoot') or self.workspace_root)).resolve()
        venv = resolve_venv_info(root)
        extra = tuple(dict.fromkeys(Path(entry.path) for entry in venv.editable_installs)) if venv else ()
        snapshot = snapshot_python_sources(root, extra_roots=list(extra) or None, max_workers=1)
        profile = discover_workspace(root, settings_override=params.get('settingsModule'), python_files=snapshot.files)
        projects = settings_projects(root, profile.settings_sources, params.get('settingsModule'))
        self._close_projects()
        self._projects_params = dict(params)
        if not projects or (len(projects) == 1 and projects[0].root == str(root)
                            and projects[0].import_root == str(root)):
            if len(projects) == 1 and projects[0].settings_module and not params.get('settingsModule'):
                params = {**params, 'settingsModule': projects[0].settings_module}
            return super()._initialize(params, observation_attempt=observation_attempt)
        generation = self._reserve_state_generation(workspace_root=root,
            initialized_at=datetime.now(timezone.utc))
        self._discard_bg_pool()
        observation, configuration = source_observation_context(root, venv)
        coordinator = WorkspaceProjects(root, projects, source_files=snapshot.files,
            raw_root=Path(str(params.get('workspaceRoot') or root)).absolute())
        self._projects_stop = threading.Event()
        self._projects_revision += 1
        revision = self._projects_revision
        with self._state_lock:
            self._projects = coordinator
            self._projects_params = dict(params)
            self._projects_observation = observation
            self._source_configuration_fingerprint = configuration
            self._editable_source_roots = extra
            self.workspace_profile = profile
            self.source_snapshot = snapshot
            self._surface_transport_enabled = params.get('surfaceSnapshotTransport') == 1
            self._surface_transport.reset()
        # Publish source-only analysis immediately. Runtime registries replace
        # their own context serially; they never share a configured Django app.
        static_groups = {}
        for project in projects:
            files = project_source_files(projects, project, snapshot.files)
            runtime = replace(create_pending_runtime_inspection(project.settings_module), detached=True)
            key = project.root, project.import_root
            previous = static_groups.get(key)
            if previous is None:
                static = build_static_index(Path(project.import_root), python_files=files,
                    import_roots=(project.import_root, project.root, str(root), *map(str, extra)))
                graph = build_model_graph(static, runtime)
                surface = prebuild_member_surface_cache(static, runtime, graph)
                static_groups[key] = static, graph, surface
            else:
                shared, graph, surface = previous
                static = copy_source_index(shared)
            coordinator.install(ProjectRuntime(project, static, runtime, graph, None, surface,
                fingerprint_surface_index(surface), snapshot_project_sources(Path(project.import_root), files),
                dependencies=(project.namespace,)))
        if params.get('deferRuntime'):
            self._schedule_project_refresh(delay=0.05)
        else:
            self._collect_projects(coordinator, generation, revision, projects)
        with self._state_lock:
            if self._projects is not coordinator or generation != self._state_generation:
                raise RuntimeError('Project initialization was superseded.')
            result = self._combined_payload()
        result = {**result, 'serverName': 'django-orm-intellisense', 'protocolVersion': '0.1',
            'workspace': profile.to_dict(),
            'venvInfo': venv.to_dict() if venv else None,
            'sourceObservationContext': observation}
        return result

    def _combined_payload(self):
        if self._projects_payload is None:
            self._projects_payload = self._projects.payload()
            self._projects_payload['health']['managePyPath'] = self.workspace_profile.manage_py_path
            # Multi-registry startup cache entries need their project context.
            # Do not attach the single-registry cache witness to this format.
            self._projects_payload['sourceProvenance'] = None
            self.health_snapshot = self._projects_payload['health']
        return self._projects_payload

    def _collect_projects(self, coordinator, generation, revision, selected, *, publish=False):
        stopping = self._projects_stop
        configuration = self._source_configuration_fingerprint
        def current():
            return (not self._stopping.is_set() and not stopping.is_set()
                and self._projects is coordinator and generation == self._state_generation
                and revision == self._projects_revision)
        # A replaced initialization can overlap briefly with a terminating
        # child. The shared gate prevents two registries from running at once.
        with self._projects_collect_lock:
            if not current():
                return
            snapshot = snapshot_python_sources(self.workspace_root,
                extra_roots=list(self._editable_source_roots) or None, max_workers=1)
            coordinator.source_files = snapshot.files
            for value in collect_project_runtimes(selected, all_projects=coordinator.projects,
                    workspace_root=self.workspace_root, source_files=snapshot.files,
                    extra_roots=self._editable_source_roots, stopping=stopping, is_current=current,
                    timeout_seconds=60 if len(snapshot.files) > 10000 else 30,
                    static_indexes={namespace: state.engine.static_index for namespace, state in coordinator.states.items()},
                    static_snapshots={namespace: state.engine.source_snapshot for namespace, state in coordinator.states.items()}):
                _observation, live_configuration = source_observation_context(self.workspace_root,
                    resolve_venv_info(self.workspace_root))
                if live_configuration != configuration:
                    value = ProjectRuntimeFailure(value.project, 'Source configuration changed during runtime collection.')
                with self._state_lock:
                    if not current():
                        return
                    if isinstance(value, ProjectRuntime):
                        live = snapshot_python_sources(self.workspace_root,
                            extra_roots=list(self._editable_source_roots) or None, max_workers=1)
                        owners = set(value.dependencies)
                        # Use longest ownership so a root project does not claim
                        # a nested independent project in the source witness.
                        from ..runtime.projects import project_owner
                        files = tuple(path for path in live.files
                            if (owner := project_owner(coordinator.projects, path)) is None or owner.namespace in owners)
                        proof = project_source_projection(Path(value.project.import_root), live, files)
                        if proof.fingerprint != value.source_snapshot.fingerprint:
                            value = ProjectRuntimeFailure(value.project, 'Project source changed before adoption.')
                    coordinator.install(value)
                    self._projects_payload = None
                    if publish:
                        self._write_notification('surfaceIndexChanged', self._combined_payload())

    def _schedule_project_refresh(self, *, delay=0.3):
        with self._state_lock:
            if self._projects is None or self._stopping.is_set():
                return
            if self._projects_timer is not None:
                self._projects_timer.cancel()
            coordinator, generation, revision = self._projects, self._state_generation, self._projects_revision
            def refresh():
                try:
                    with self._state_lock:
                        if self._projects is not coordinator or revision != self._projects_revision:
                            return
                        selected = tuple(project for project in coordinator.projects
                            if project.namespace in coordinator.pending)
                    self._collect_projects(coordinator, generation, revision, selected, publish=True)
                    with self._state_lock:
                        if (not self._stopping.is_set() and self._projects is coordinator
                                and revision == self._projects_revision and not selected):
                            self._write_notification('surfaceIndexChanged', self._combined_payload())
                except Exception as error:
                    with self._state_lock:
                        if self._projects is coordinator and revision == self._projects_revision:
                            for project in coordinator.projects:
                                if project.namespace in coordinator.pending:
                                    coordinator.install(ProjectRuntimeFailure(project, str(error)))
                            self._projects_payload = None
                            self._write_notification('surfaceIndexChanged', self._combined_payload())
            timer = threading.Timer(delay, refresh)
            timer.name = 'project-runtime-refresh'
            timer.daemon = True
            self._projects_timer = timer
            self._projects_thread = timer
            timer.start()

    def _project_request(self, method, params):
        with self._state_lock:
            return self._projects.request(method, params)

    def _health(self):
        if self._projects is None:
            return super()._health()
        with self._state_lock:
            return self._combined_payload()['health']

    def _reindex_file(self, params):
        value = params.get('filePath')
        if not value:
            return {'error': 'filePath is required'}
        path = Path(str(value)).resolve()
        if self._projects is not None:
            path = self._projects.source_file(path)
        if any(path.is_relative_to(root) for root in (self.workspace_root, *self._editable_source_roots)) and (
                path.name in ('settings.py', 'manage.py', 'wsgi.py', 'asgi.py') or 'settings' in path.parts):
            snapshot = snapshot_python_sources(self.workspace_root,
                extra_roots=list(self._editable_source_roots) or None, max_workers=1)
            profile = discover_workspace(self.workspace_root,
                settings_override=self._projects_params.get('settingsModule'), python_files=snapshot.files)
            projects = settings_projects(self.workspace_root, profile.settings_sources,
                self._projects_params.get('settingsModule'))
            previous = self._projects.projects if self._projects is not None else ()
            needs_coordinator = bool(projects) and (len(projects) > 1
                or projects[0].root != str(self.workspace_root) or projects[0].import_root != str(self.workspace_root))
            if projects != previous and (self._projects is not None or needs_coordinator):
                payload = self._initialize({**self._projects_params,
                    'workspaceRoot': str(self.workspace_root), 'deferRuntime': True})
                self._write_notification('surfaceIndexChanged', payload)
                return {'unchanged': True, 'runtimeMembersPending': True}
        if self._projects is None:
            return super()._reindex_file(params)
        if not any(path.is_relative_to(root) for root in (self.workspace_root, *self._editable_source_roots)):
            return {'error': 'file outside workspace'}
        with self._state_lock:
            result = self._projects.reindex_file({**params, 'filePath': str(path)})
            if 'error' in result:
                return result
            if result.get('sourceUnchanged'):
                return result
            self._projects_revision += 1
            self._reindex_serial += 1
            self._projects_payload = None
            result['projectContexts'] = self._combined_payload()['projectContexts']
        self._schedule_project_refresh()
        return result

    def _deleted_source_files(self, params):
        if self._projects is None:
            return super()._deleted_source_files(params)
        path = Path(str(params.get('filePath') or '')).resolve()
        return {'filePaths': sorted(str(file) for file in self._projects.source_files
            if (file == path or file.is_relative_to(path)) and not file.exists())}

    def _reindex_source_root(self, params, *, allow_directory=False):
        if self._projects is None:
            return super()._reindex_source_root(params, allow_directory=allow_directory)
        path = Path(str(params.get('filePath') or '')).resolve()
        if not any(path.is_relative_to(root) for root in (self.workspace_root, *self._editable_source_roots)):
            return {'error': 'directory outside declared source roots'}
        # A directory event can add/remove project settings. Replan from the
        # current repository rather than reconciling only the former roster.
        self._initialize({**self._projects_params, 'deferRuntime': True})
        self._write_notification('surfaceIndexChanged', self._combined_payload())
        return {'unchanged': True, 'runtimeMembersPending': True}

    def _request_surface_index_load(self, **kwargs):
        if self._projects is None:
            return super()._request_surface_index_load(**kwargs)

    def _surface_index_changed_payload(self):
        if self._projects is not None:
            return self._combined_payload()
        return super()._surface_index_changed_payload()

    def _rebuild_bg_pool(self):
        if self._projects is None:
            return super()._rebuild_bg_pool()


def _project_method(method, name):
    def dispatch(self, params):
        if self._projects is not None:
            return self._project_request(method, params)
        return getattr(super(ProjectDaemonServer, self), name)(params)
    dispatch.__name__ = name
    return dispatch


for _method, _name in _METHODS.items():
    setattr(ProjectDaemonServer, _name, _project_method(_method, _name))
