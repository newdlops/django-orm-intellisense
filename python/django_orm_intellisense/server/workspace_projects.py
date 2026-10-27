"""Pure per-project engines behind one repository-wide protocol snapshot."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
import sys
import threading

from ..discovery.workspace import discover_workspace
from ..features.health import build_health_snapshot
from ..features.orm_members import fingerprint_surface_index
from ..runtime.projects import ProjectRuntime, ProjectRuntimeFailure
from ..semantic.graph import build_semantic_graph
from .app import DaemonServer, fingerprint_json_payload


_LABEL_KEYS = frozenset(('modelLabel', 'baseModelLabel', 'relatedModelLabel',
    'returnModelLabel', 'declaredModelLabel', 'targetModelLabel', 'sourceModelLabel'))
_LABEL_LISTS = frozenset(('addedLabels', 'changedLabels', 'removedLabels',
    'removedStaticFallbackLabels', 'removedSurfaceLabels'))
_MODEL_TABLES = frozenset(('surfaceIndex', 'surfaceIndexDelta', 'staticFallback', 'staticFallbackDelta'))
_METHODS = {
    'relationTargets': '_relation_targets', 'resolveRelationTarget': '_resolve_relation_target',
    'resolveExportOrigin': '_resolve_export_origin', 'resolveModule': '_resolve_module',
    'lookupPathCompletions': '_lookup_path_completions', 'resolveLookupPath': '_resolve_lookup_path',
    'ormMemberCompletions': '_orm_member_completions', 'resolveOrmMember': '_resolve_orm_member',
    'resolveOrmMemberBatch': '_resolve_orm_member_batch', 'resolveLookupPathBatch': '_resolve_lookup_path_batch',
    'resolveOrmMemberChain': '_resolve_orm_member_chain',
}


class ProjectWire:
    def __init__(self, project, engine, workspace_root, raw_root=None):
        self.project = project
        self.engine = engine
        self.prefix = project.namespace + '.'
        aliases = {str(Path(project.root).resolve())}
        if raw_root is not None and Path(project.root).is_relative_to(workspace_root):
            aliases.add(str(Path(raw_root) / Path(project.root).relative_to(workspace_root)))
        self.root_aliases = sorted(aliases - {project.root})
        self.local_modules = {}
        for module in engine.static_index.modules.values():
            path = Path(module.file_path)
            if path.is_relative_to(workspace_root):
                relative = path.relative_to(workspace_root)
                parts = relative.parent.parts if path.name == '__init__.py' else relative.with_suffix('').parts
                self.local_modules['.'.join(parts)] = module.module_name

    def label(self, value):
        return self.prefix + value if isinstance(value, str) and value else value

    def local_label(self, value):
        return value[len(self.prefix):] if isinstance(value, str) and value.startswith(self.prefix) else value

    def metadata(self, value):
        if isinstance(value, Mapping):
            is_model = 'module' in value and 'fieldNames' in value or 'appLabel' in value and 'objectName' in value
            return {key: self.label(item) if key in _LABEL_KEYS or key == 'label' and is_model
                    else item if key in ('documentation', 'detail', 'signature', 'parameters', 'defaultValue', 'annotation')
                    else self.metadata(item)
                    for key, item in value.items()}
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            # Compact member/return rows bind their model in the second slot.
            # Other strings, including docs, names and annotations, stay exact.
            labels = self.engine.model_graph.nodes_by_label
            is_member = bool(value) and value[0] in ('instance', 'model_class', 'manager',
                'queryset', 'related_manager', 'scalar', 'unknown')
            return tuple(self.label(item) if is_member and index == 1 and isinstance(item, str) and item in labels
                         else self.metadata(item) if isinstance(item, (Mapping, list, tuple)) else item
                         for index, item in enumerate(value))
        return value

    def type_id(self, value):
        if value is None:
            return None
        if value.startswith('model:'):
            _kind, label, nested = value.split(':', 2)
            return 'model:' + self.label(label) + ':' + self.type_id(nested)
        return self.prefix + value

    def catalog(self, catalog):
        def descriptor(value):
            result = {**value, 'transforms': {name: self.type_id(type_id)
                for name, type_id in value.get('transforms', {}).items()}}
            if value.get('dynamicTransform'):
                dynamic = dict(value['dynamicTransform'])
                for key in ('outputType', 'sliceType'):
                    if key in dynamic:
                        dynamic[key] = self.type_id(dynamic[key])
                result['dynamicTransform'] = dynamic
            return result

        return {
            **{key: {self.label(label): {name: self.type_id(type_id) for name, type_id in fields.items()}
                     for label, fields in catalog.get(key, {}).items()}
               for key in ('fields', 'expressionFields')},
            'relationPaths': {self.label(label): dict(paths) for label, paths in catalog.get('relationPaths', {}).items()},
            'types': {self.type_id(type_id): descriptor(value)
                      for type_id, value in catalog.get('types', {}).items()},
            'kinds': {kind: self.type_id(type_id) for kind, type_id in catalog.get('kinds', {}).items()},
        }

    def model_catalog_delta(self, delta):
        result = {}
        for label, chunk in delta.items():
            if chunk is None:
                result[self.label(label)] = None
            else:
                result[self.label(label)] = self.catalog(chunk)
        return result

    def result(self, value):
        if not isinstance(value, Mapping):
            return self.metadata(value)
        result = {}
        for key, item in value.items():
            if key in _LABEL_KEYS:
                result[key] = self.label(item)
            elif key == 'label' and ('module' in value and 'fieldNames' in value
                    or 'appLabel' in value and 'objectName' in value):
                result[key] = self.label(item)
            elif key in _LABEL_LISTS:
                result[key] = [self.label(label) for label in item]
            elif key in _MODEL_TABLES and isinstance(item, Mapping):
                result[key] = {self.label(label): self.metadata(row) for label, row in item.items()}
            elif key == 'surfaceFingerprints':
                result[key] = {self.label(label): fingerprint for label, fingerprint in item.items()}
            elif key == 'lookupCatalog':
                result[key] = self.catalog(item)
            elif key == 'lookupCatalogDelta':
                result[key] = self.model_catalog_delta(item)
            elif key in ('item', 'items', 'results', 'target', 'candidates'):
                result[key] = ([self.result(row) for row in item] if isinstance(item, list)
                               else self.result(item) if isinstance(item, Mapping) else item)
            else:
                result[key] = (self.result(item) if isinstance(item, Mapping)
                    else [self.result(row) if isinstance(row, Mapping) else row for row in item]
                    if isinstance(item, list) else item)
        changed_surface = result.get('surfaceIndexDelta', result.get('surfaceIndex'))
        if isinstance(changed_surface, dict):
            result['surfaceFingerprints'] = fingerprint_surface_index(changed_surface)
        # A relation target's internal ID is scoped; its Django source spelling
        # is retained for insertion into ForeignKey/OneToOne/ManyToMany strings.
        if 'label' in value and 'appLabel' in value and 'objectName' in value:
            result['djangoLabel'] = value['label']
            result['projectRoot'] = self.project.root
        return result

    def local_params(self, value):
        if isinstance(value, Mapping):
            def local_value(item):
                local = self.local_label(item)
                if isinstance(local, str):
                    module, dot, symbol = local.rpartition('.')
                    if dot and module in self.local_modules:
                        return self.local_modules[module] + '.' + symbol
                return local
            return {key: local_value(item) if key in _LABEL_KEYS or key == 'value'
                    else self.local_modules.get(item, item) if key == 'module' and isinstance(item, str)
                    else self.local_params(item)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [self.local_params(item) for item in value]
        return value

    def context(self, workspace_root, lookup_kinds=None):
        models = {}
        for label, node in self.engine.model_graph.nodes_by_label.items():
            path = Path(node.file_path) if node.file_path else None
            if path is not None and path.is_relative_to(workspace_root):
                relative = path.relative_to(workspace_root)
                parts = relative.parent.parts if path.name == '__init__.py' else relative.with_suffix('').parts
                canonical_module = '.'.join(parts)
            else:
                canonical_module = self.project.namespace + '.' + node.module
            models[self.label(label)] = {
                'djangoLabel': label, 'sourceModule': node.module,
                'module': canonical_module, 'filePath': node.file_path,
                'line': node.line, 'column': node.column,
            }
        runtime = self.engine.runtime_inspection
        return {**self.project.to_dict(), 'rootAliases': self.root_aliases,
                'phase': self.engine.health_snapshot['phase'],
                'runtime': runtime.to_dict(), 'models': models,
                'customLookups': runtime.custom_lookups, 'lookupKinds': lookup_kinds or {}}


@dataclass
class _ProjectState:
    runtime: ProjectRuntime
    engine: DaemonServer
    wire: ProjectWire


class WorkspaceProjects:
    """Hold pure states for all projects; registry work stays in owned children."""
    def __init__(self, root, projects, *, source_files=(), raw_root=None):
        self.root = Path(root)
        self.raw_root = Path(raw_root) if raw_root is not None else self.root
        self.projects = tuple(projects)
        self.source_files = tuple(source_files)
        self.started_at = datetime.now(timezone.utc)
        self.states: dict[str, _ProjectState] = {}
        self.failures: dict[str, str] = {}
        self.pending = {project.namespace for project in self.projects}
        self._lock = threading.RLock()
        self._closed = False

    def install(self, value):
        project = value.project
        if project not in self.projects:
            raise ValueError('Project result belongs to an inactive workspace plan.')
        with self._lock:
            if self._closed:
                return False
            self.pending.discard(project.namespace)
            if isinstance(value, ProjectRuntimeFailure):
                self.failures[project.namespace] = value.error
                previous = self.states.get(project.namespace)
                if previous is not None:
                    engine = previous.engine
                    engine.runtime_inspection = replace(engine.runtime_inspection,
                        bootstrap_status='setup_failed', bootstrap_error=value.error)
                    engine.health_snapshot = {**engine.health_snapshot, 'phase': 'degraded',
                        'detail': value.error, 'runtime': engine.runtime_inspection.to_dict()}
                return
            if not isinstance(value, ProjectRuntime):
                raise TypeError('Expected a pure project runtime result.')
            output = sys.stdout
            try:
                engine = DaemonServer(Path(project.import_root))
            finally:
                # DaemonServer normally owns stdio. Embedded pure engines must
                # not redirect the repository coordinator's stdout a second time.
                sys.stdout = output
            engine.initialized_at = self.started_at
            engine.workspace_profile = discover_workspace(Path(project.root),
                settings_override=project.settings_module,
                python_files=tuple(Path(module.file_path) for module in value.static_index.modules.values()
                    if Path(module.file_path).is_relative_to(Path(project.root))))
            engine.static_index = value.static_index
            engine.runtime_inspection = replace(value.inspection, detached=True,
                detached_fields=value.model_graph.fields_by_model_label)
            engine.model_graph = value.model_graph
            engine.semantic_graph = build_semantic_graph(engine.workspace_profile,
                engine.static_index, engine.runtime_inspection)
            engine.health_snapshot = build_health_snapshot(workspace=engine.workspace_profile,
                static_index=engine.static_index, runtime=engine.runtime_inspection,
                semantic_graph=engine.semantic_graph, initialized_at=self.started_at)
            engine.source_snapshot = value.source_snapshot
            engine._state_generation = 1
            engine._editable_source_roots = tuple(dict.fromkeys((Path(project.root), self.root)))
            engine._source_root_aliases = tuple((str(root), str(root)) for root in
                dict.fromkeys((Path(project.import_root), Path(project.root), self.root)))
            engine._last_surface_index = value.surface
            engine._last_surface_fingerprints = value.fingerprints
            engine._last_model_names = engine._build_model_names(value.model_graph)
            engine._last_static_fallback = engine._build_static_fallback(
                model_graph=value.model_graph, surface_index=value.surface)
            engine._last_static_fallback_fingerprint = (fingerprint_json_payload(engine._last_static_fallback)
                if engine._last_static_fallback else None)
            engine._surface_source_complete = True
            engine._surface_load_attempted_generation = 1
            # One coordinator schedules serial refreshes. Embedded states never
            # launch independent background Django registry work in this process.
            engine._schedule_runtime_member_refresh = lambda namespace=project.namespace: self.mark_pending(namespace)
            engine._write_notification = lambda *_args, **_kwargs: None
            old = self.states.get(project.namespace)
            if old is not None:
                old.engine._stopping.set()
                old.engine._discard_bg_pool()
            self.states[project.namespace] = _ProjectState(value, engine, ProjectWire(project, engine, self.root, self.raw_root))
            if value.inspection.bootstrap_status == 'warming_up':
                self.pending.add(project.namespace)
            self.failures.pop(project.namespace, None)
            return True

    def mark_pending(self, namespace):
        with self._lock:
            self.pending.add(namespace)

    def project_for_file(self, file):
        if not file:
            return None
        path = self.source_file(Path(file))
        matches = [project for project in self.projects if path.is_relative_to(Path(project.root))]
        return max(matches, key=lambda project: len(Path(project.root).parts)) if matches else None

    def source_file(self, path):
        if path.is_relative_to(self.root):
            return path
        matches = [(project, Path(project.root).resolve()) for project in self.projects
            if path.is_relative_to(Path(project.root).resolve())]
        if not matches:
            return path
        project, physical = max(matches, key=lambda pair: len(pair[1].parts))
        return Path(project.root) / path.relative_to(physical)

    def _state_for(self, params):
        labels = [params.get(key) for key in ('modelLabel', 'baseModelLabel', 'value')]
        for label in labels:
            if isinstance(label, str):
                project = next((project for project in self.projects
                    if label.startswith(project.namespace + '.')), None)
                if project is not None:
                    return self.states.get(project.namespace)
        module = params.get('module')
        if not isinstance(module, str) and isinstance(params.get('value'), str):
            module = params['value'].rpartition('.')[0]
        matches = []
        if isinstance(module, str):
            matches = [state for state in self.states.values() if module in state.wire.local_modules]
            if len(matches) == 1 and not any(module in state.engine.static_index.modules for state in self.states.values()):
                return matches[0]
        project = self.project_for_file(params.get('_sourceFile') or params.get('filePath'))
        if project is not None:
            return self.states.get(project.namespace)
        if len(matches) == 1:
            return matches[0]
        candidates = [state for state in self.states.values()
            if any(label in state.engine.model_graph.nodes_by_label for label in labels if isinstance(label, str))]
        if len(candidates) == 1:
            return candidates[0]
        return next(iter(self.states.values())) if len(self.projects) == len(self.states) == 1 else None

    def request(self, method, params):
        with self._lock:
            if method in ('resolveOrmMemberBatch', 'resolveLookupPathBatch'):
                single = 'resolveOrmMember' if method == 'resolveOrmMemberBatch' else 'resolveLookupPath'
                return {'results': [self.request(single, {**item, '_sourceFile': params.get('_sourceFile')})
                                    for item in params.get('items', [])]}
            state = self._state_for(params)
            if state is None:
                if method == 'relationTargets':
                    items = []
                    for current in self.states.values():
                        items.extend(current.wire.result(current.engine._relation_targets(params))['items'])
                    return {'items': items}
                return {'resolved': False, 'reason': 'ambiguous_or_pending_project'}
            name = _METHODS.get(method)
            if name is None:
                raise ValueError('Unsupported project request: ' + method)
            result = getattr(state.engine, name)(state.wire.local_params(params))
            return state.wire.result(result)

    def reindex_file(self, params):
        with self._lock:
            owner = self.project_for_file(params.get('filePath'))
            selected = [state for state in self.states.values() if owner is None
                        or state.runtime.project == owner or owner.namespace in state.runtime.dependencies]
            if not selected:
                return {'error': 'Project runtime is still pending.'}
            replies = []
            for state in selected:
                raw = state.engine._reindex_file(params)
                if 'error' in raw:
                    return raw
                replies.append(state.wire.result(raw))
            merged = {'runtimeMembersPending': True}
            for reply in replies:
                for key, value in reply.items():
                    if key in _LABEL_LISTS:
                        merged.setdefault(key, []).extend(value)
                    elif key in _MODEL_TABLES or key in ('lookupCatalogDelta', 'surfaceFingerprints'):
                        merged.setdefault(key, {}).update(value)
                    elif key == 'unchanged':
                        merged['unchanged'] = merged.get('unchanged', True) and value
                    elif key == 'sourceUnchanged':
                        merged['sourceUnchanged'] = merged.get('sourceUnchanged', True) and value
            return merged

    def payload(self):
        with self._lock:
            surface, catalog, fallback, contexts, names = {}, {
                'fields': {}, 'types': {}, 'expressionFields': {}, 'relationPaths': {}, 'kinds': {}}, {}, [], set()
            previews, counts = [], {key: 0 for key in ('appCount', 'modelCount', 'fieldCount',
                'relationCount', 'reverseRelationCount', 'managerCount')}
            ready = 0
            for project in self.projects:
                state = self.states.get(project.namespace)
                if state is None:
                    contexts.append({**project.to_dict(), 'phase': 'starting' if project.namespace in self.pending else 'degraded',
                        'error': self.failures.get(project.namespace), 'models': {}})
                    continue
                engine, wire = state.engine, state.wire
                ready += engine.runtime_inspection.bootstrap_status == 'ready'
                surface.update(wire.result({'surfaceIndex': engine._last_surface_index or {}})['surfaceIndex'])
                converted = wire.catalog(engine.runtime_inspection.lookup_catalog)
                for key in ('fields', 'types', 'expressionFields', 'relationPaths'):
                    catalog[key].update(converted[key])
                fallback.update(wire.result({'staticFallback': engine._last_static_fallback or {}})['staticFallback'])
                names.update(engine._last_model_names or ())
                context = wire.context(self.root, converted['kinds'])
                if project.namespace in self.failures:
                    context['error'] = self.failures[project.namespace]
                context['runtimeMembersPending'] = project.namespace in self.pending
                contexts.append(context)
                runtime_health = engine.runtime_inspection.to_dict()
                for key in counts:
                    counts[key] += runtime_health.get(key, 0)
                previews.extend(wire.result(row.to_dict()) for row in engine.runtime_inspection.model_preview)
            static_files = set(self.source_files)
            phase = 'ready' if ready else 'starting' if self.pending else 'degraded'
            health = {
                'phase': phase, 'workspaceRoot': str(self.root),
                'detail': f'Runtime ORM inspection is active for {ready}/{len(self.projects)} Django projects.',
                'capabilities': ['workspace.discovery', 'workspace.settings_projects', 'static.index', 'semantic.graph']
                    + (['runtime.environment', 'runtime.django_setup', 'runtime.orm_metadata'] if ready else []),
                'settingsModule': None, 'settingsCandidates': [candidate for project in self.projects for candidate in project.candidates],
                'settingsProjects': contexts, 'startedAt': self.started_at.isoformat(),
                'staticIndex': {'pythonFileCount': len(static_files), 'packageInitCount': sum(path.name == '__init__.py' for path in static_files),
                    'reexportModuleCount': sum(state.engine.static_index.reexport_module_count for state in self.states.values()),
                    'starImportCount': sum(state.engine.static_index.star_import_count for state in self.states.values()),
                    'explicitAllCount': sum(state.engine.static_index.explicit_all_count for state in self.states.values()),
                    'modelCandidateCount': sum(state.engine.static_index.model_candidate_count for state in self.states.values())},
                'runtime': {'djangoImportable': any(state.engine.runtime_inspection.django_importable for state in self.states.values()),
                    'djangoVersion': next((state.engine.runtime_inspection.django_version for state in self.states.values()
                        if state.engine.runtime_inspection.django_version), None),
                    'bootstrapStatus': 'ready' if ready else 'warming_up' if self.pending else 'setup_failed',
                    'settingsModule': None, 'projectCount': len(self.projects), 'readyProjectCount': ready,
                    **counts, 'modelPreview': previews[:10]},
                'semanticGraph': {'coverageMode': 'hybrid_scaffold' if ready else 'static_only_scaffold',
                    'moduleCount': len(static_files), 'exportSurfaceCount': 0,
                    'modelCandidateCount': sum(state.engine.static_index.model_candidate_count for state in self.states.values()),
                    'runtimeModelCount': counts['modelCount'], 'provenanceLayers': ['static_source', 'settings_discovery']
                        + (['runtime_environment', 'django_runtime_meta'] if ready else [])},
            }
            return {'health': health, 'modelNames': sorted(names), 'projectContexts': contexts,
                'surfaceIndex': surface, 'surfaceFingerprints': fingerprint_surface_index(surface),
                'lookupCatalog': catalog, 'customLookups': {},
                'customLookupsFingerprint': fingerprint_json_payload(catalog),
                'staticFallback': fallback or None,
                'staticFallbackFingerprint': fingerprint_json_payload(fallback) if fallback else None,
                'runtimeMembersPending': bool(self.pending)}

    def close(self):
        with self._lock:
            self._closed = True
            for state in self.states.values():
                state.engine._stopping.set()
                state.engine._cancel_runtime_member_refresh()
                state.engine._discard_bg_pool()
            self.states.clear()
            self.pending.clear()
