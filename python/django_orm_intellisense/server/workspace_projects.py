"""Pure per-project engines behind one repository-wide protocol snapshot."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import sys
import threading

from ..discovery.workspace import discover_workspace
from ..features.health import build_health_snapshot
from ..features.orm_members import fingerprint_surface_index
from ..runtime.projects import ProjectRuntime, ProjectRuntimeFailure
from ..semantic.graph import build_semantic_graph
from .app import DaemonServer, fingerprint_json_payload
from .settings_union import CatalogUnion, merge_fallback, merge_surface


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
    def __init__(self, project, engine, workspace_root, raw_root=None, label_map=None):
        self.project = project
        self.engine = engine
        self.prefix = project.namespace + '.'
        self.group_prefix = (project.group_namespace or project.namespace) + '.'
        self.label_map = label_map or {}
        self.local_labels = {qualified: local for local, qualified in self.label_map.items()}
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
        return self.label_map.get(value, self.group_prefix + value) if isinstance(value, str) and value else value

    def local_label(self, value):
        return self.local_labels.get(value, value[len(self.group_prefix):]) if isinstance(value, str) and value.startswith(self.group_prefix) else value

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
        self._model_ids = {}
        self._label_owners = {}

    def _labels_for(self, project, graph):
        group = project.group_namespace or project.namespace
        labels = {}
        for label, node in graph.nodes_by_label.items():
            # Runtime app labels can collide while the source modules differ.
            # Prefer the module's actual indexed file over a label-only candidate.
            source = str(Path(project.import_root).joinpath(*node.module.split('.'))) if node.module else node.file_path
            identity = group, source, node.object_name
            qualified = self._model_ids.get(identity)
            if qualified is None:
                qualified = group + '.' + label
                owner = self._label_owners.get(qualified)
                if owner is not None and owner != identity:
                    qualified = group + '.source_' + hashlib.sha256(
                        (str(source) + '\0' + node.object_name).encode()).hexdigest()[:16] + '.' + label
                self._model_ids[identity] = qualified
                self._label_owners[qualified] = identity
            labels[label] = qualified
        return labels

    def _share_records(self, value):
        """Reuse equal immutable member rows; keep each registry's owners separate."""
        group = value.project.group_namespace or value.project.namespace
        previous = next((state for state in self.states.values()
            if (state.runtime.project.group_namespace or state.runtime.project.namespace) == group), None)
        if previous is None:
            return value
        surface = dict(value.surface)
        for label, row in surface.items():
            old = (previous.engine._last_surface_index or {}).get(label)
            if old == row:
                surface[label] = old
            elif old:
                surface[label] = {kind: old[kind] if old.get(kind) == members else members for kind, members in row.items()}
        members = value.members
        owned = getattr(previous.engine.static_index, '_runtime_member_snapshot', None)
        if members is not None and owned is not None:
            items = {}
            for key, rows in members.items.items():
                old = owned.items.get(key, ())
                if rows == old:
                    items[key] = old
                else:
                    by_name = {item.name: item for item in old}
                    items[key] = tuple(by_name[item.name] if by_name.get(item.name) == item else item for item in rows)
            members = replace(members, items=items)
            value.static_index._runtime_member_snapshot = members
        return replace(value, surface=surface, members=members)

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
            value = self._share_records(value)
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
            # The embedded engine owns mutable generations. Do not retain its
            # pre-edit graphs/indexes a second time in the collection receipt.
            receipt = replace(value, static_index=None, inspection=None, model_graph=None,
                members=None, surface={}, fingerprints={}, source_snapshot=None)
            self.states[project.namespace] = _ProjectState(receipt, engine, ProjectWire(project, engine, self.root, self.raw_root,
                self._labels_for(project, engine.model_graph)))
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
        path = path.resolve()
        physical_root = self.root.resolve()
        if path.is_relative_to(physical_root):
            return self.root / path.relative_to(physical_root)
        matches = [(project, Path(project.root).resolve()) for project in self.projects
            if path.is_relative_to(Path(project.root).resolve())]
        if not matches:
            return path
        project, physical = max(matches, key=lambda pair: len(pair[1].parts))
        return Path(project.root) / path.relative_to(physical)

    def _states_for(self, params):
        labels = [params.get(key) for key in ('modelLabel', 'baseModelLabel', 'value')]
        for label in labels:
            if isinstance(label, str):
                qualified = [state for state in self.states.values()
                    if label in state.wire.local_labels
                    and state.wire.local_labels[label] in state.engine.model_graph.nodes_by_label]
                if qualified:
                    return self._prefer_runtime(qualified, labels)
                if any(label.startswith((project.group_namespace or project.namespace) + '.') for project in self.projects):
                    return []
        module = params.get('module')
        if not isinstance(module, str) and isinstance(params.get('value'), str):
            module = params['value'].rpartition('.')[0]
        matches = []
        if isinstance(module, str):
            matches = [state for state in self.states.values() if module in state.wire.local_modules]
            if len(matches) == 1 and not any(module in state.engine.static_index.modules for state in self.states.values()):
                return matches
        project = self.project_for_file(params.get('_sourceFile') or params.get('filePath'))
        if project is not None:
            group = project.group_namespace or project.namespace
            # A canonical import path can point at a different project than
            # the requesting document. It remains authoritative in that case.
            if matches and len({state.runtime.project.group_namespace or state.runtime.project.namespace for state in matches}) == 1:
                return self._prefer_runtime(matches, labels)
            return self._prefer_runtime([state for state in self.states.values()
                if (state.runtime.project.group_namespace or state.runtime.project.namespace) == group], labels)
        if matches:
            if len({state.runtime.project.group_namespace or state.runtime.project.namespace for state in matches}) == 1:
                return self._prefer_runtime(matches, labels)
            return []
        candidates = [state for state in self.states.values()
            if any(label in state.engine.model_graph.nodes_by_label for label in labels if isinstance(label, str))]
        if candidates:
            return self._prefer_runtime(candidates, labels) if len({
                state.runtime.project.group_namespace or state.runtime.project.namespace for state in candidates}) == 1 else []
        return list(self.states.values()) if len({project.group_namespace or project.namespace for project in self.projects}) == 1 else []

    @staticmethod
    def _prefer_runtime(states, labels):
        def priority(state):
            return not any((node := state.engine.model_graph.nodes_by_label.get(state.wire.local_label(label))) is not None
                and node.runtime_model is not None for label in labels if isinstance(label, str))
        return sorted(states, key=priority)

    @staticmethod
    def _merge_targets(replies):
        items = {}
        for reply in replies:
            for item in reply:
                label = item['label']
                previous = items.get(label)
                if previous is None or previous.get('source') != 'runtime' and item.get('source') == 'runtime':
                    items[label] = item
                elif previous is not None:
                    for key in ('fieldNames', 'relationNames', 'reverseRelationNames', 'managerNames'):
                        if key in previous or key in item:
                            previous[key] = list(dict.fromkeys((*previous.get(key, ()), *item.get(key, ()))))
        return list(items.values())

    def request(self, method, params):
        with self._lock:
            if method in ('resolveOrmMemberBatch', 'resolveLookupPathBatch'):
                single = 'resolveOrmMember' if method == 'resolveOrmMemberBatch' else 'resolveLookupPath'
                return {'results': [self.request(single, {**item, '_sourceFile': params.get('_sourceFile')})
                                    for item in params.get('items', [])]}
            name = _METHODS.get(method)
            if name is None:
                raise ValueError('Unsupported project request: ' + method)
            states = self._states_for(params)
            if method == 'relationTargets' and not states:
                states = list(self.states.values())
            if not states:
                return {'resolved': False, 'reason': 'ambiguous_or_pending_project'}
            replies = []
            for state in states:
                result = state.wire.result(getattr(state.engine, name)(state.wire.local_params(params)))
                replies.append(result)
                if result.get('resolved') and method not in ('resolveRelationTarget', 'relationTargets', 'lookupPathCompletions', 'ormMemberCompletions'):
                    return result
            if method == 'relationTargets':
                return {'items': self._merge_targets(reply.get('items', ()) for reply in replies)}
            if method == 'resolveRelationTarget':
                targets = self._merge_targets([reply['target']] for reply in replies if reply.get('resolved'))
                if len(targets) == 1:
                    return {**next(reply for reply in replies if reply.get('resolved')), 'target': targets[0]}
                if len(targets) > 1:
                    return {'resolved': False, 'reason': 'ambiguous_settings_model', 'candidates': targets}
            if method in ('lookupPathCompletions', 'ormMemberCompletions'):
                items = {}
                for reply in replies:
                    for item in reply.get('items', ()):
                        items.setdefault(item.get('name', item.get('label')), item)
                return {**replies[0], 'items': list(items.values()), 'resolved': any(reply.get('resolved') for reply in replies)}
            return replies[0]

    def reindex_file(self, params):
        with self._lock:
            owner = self.project_for_file(params.get('filePath'))
            selected = [state for state in self.states.values() if owner is None
                        or state.runtime.project.root == owner.root or owner.namespace in state.runtime.dependencies]
            if not selected:
                return {'error': 'Project runtime is still pending.'}
            replies = []
            for state in selected:
                raw = state.engine._reindex_file(params)
                if 'error' in raw:
                    return raw
                state.wire.label_map.update(self._labels_for(state.runtime.project, state.engine.model_graph))
                state.wire.local_labels = {qualified: local for local, qualified in state.wire.label_map.items()
                    if local in state.engine.model_graph.nodes_by_label}
                replies.append(state.wire.result(raw))
            merged = {'runtimeMembersPending': True}
            for reply in replies:
                for key, value in reply.items():
                    if key in _LABEL_LISTS:
                        merged.setdefault(key, []).extend(value)
                    elif key == 'unchanged':
                        merged['unchanged'] = merged.get('unchanged', True) and value
                    elif key == 'sourceUnchanged':
                        merged['sourceUnchanged'] = merged.get('sourceUnchanged', True) and value
            affected = set().union(*(set(reply.get('surfaceIndexDelta', {})) | set(reply.get('lookupCatalogDelta', {}))
                | set(reply.get('staticFallbackDelta', {})) | set(reply.get('removedLabels', ())) for reply in replies))
            surface, fallback, catalogs = {}, {}, {}
            for state in self.states.values():
                wire, engine = state.wire, state.engine
                for local, row in (engine._last_surface_index or {}).items():
                    label = wire.label(local)
                    if label in affected:
                        surface[label] = merge_surface(surface.get(label, {}), wire.metadata(row))
                for local, row in (engine._last_static_fallback or {}).items():
                    label = wire.label(local)
                    if label in affected:
                        fallback[label] = merge_fallback(fallback.get(label), wire.metadata(row))
            for reply in replies:
                for label, chunk in reply.get('lookupCatalogDelta', {}).items():
                    if chunk is not None:
                        catalogs.setdefault(label, CatalogUnion()).add(chunk)
            merged['surfaceIndexDelta'] = surface
            merged['surfaceFingerprints'] = fingerprint_surface_index(surface)
            merged['staticFallbackDelta'] = fallback
            merged['lookupCatalogDelta'] = {label: catalogs[label].value if label in catalogs else None for label in affected}
            for key in _LABEL_LISTS:
                if key in merged:
                    merged[key] = sorted(set(merged[key]))
            for key in ('removedLabels', 'removedSurfaceLabels'):
                if key in merged:
                    merged[key] = [label for label in merged[key] if label not in surface]
            if 'removedStaticFallbackLabels' in merged:
                merged['removedStaticFallbackLabels'] = [label for label in merged['removedStaticFallbackLabels'] if label not in fallback]
            return merged

    def payload(self):
        with self._lock:
            surface, fallback, groups, names = {}, {}, {}, set()
            catalogs = CatalogUnion()
            preferred, model_sources, runtime_models, previews = set(), set(), {}, {}
            field_keys, relation_keys, reverse_keys, manager_keys, app_keys = set(), set(), set(), set(), set()
            static_groups, profiles = {}, []
            ready = 0
            for project in self.projects:
                group = project.group_namespace or project.namespace
                context = groups.setdefault(group, {**project.to_dict(), 'namespace': group,
                    'models': {}, 'settingsProfiles': [], 'customLookups': {}, 'lookupKinds': {}, 'rootAliases': []})
                state = self.states.get(project.namespace)
                pending = project.namespace in self.pending
                summary = {'namespace': project.namespace, 'settingsModule': project.settings_module,
                    'selector': project.selector, 'root': project.root, 'pending': pending,
                    'phase': 'starting' if pending else 'degraded', 'error': self.failures.get(project.namespace)}
                profiles.append(summary)
                context['settingsProfiles'].append(summary)
                if state is None:
                    continue
                engine, wire = state.engine, state.wire
                runtime = engine.runtime_inspection
                is_ready = runtime.bootstrap_status == 'ready' and not pending
                ready += is_ready
                summary.update(phase='starting' if pending else engine.health_snapshot['phase'],
                    bootstrapStatus=runtime.bootstrap_status, modelCount=runtime.model_count,
                    error=summary['error'] or runtime.bootstrap_error)
                context.setdefault('runtime', runtime.to_dict())
                static_groups.setdefault((project.root, project.import_root), engine.static_index)
                runtime_labels = {wire.label(label) for label, node in engine.model_graph.nodes_by_label.items()
                    if node.runtime_model is not None}
                for label, row in wire.result({'surfaceIndex': engine._last_surface_index or {}})['surfaceIndex'].items():
                    surface[label] = merge_surface(surface.get(label, {}), row,
                        prefer_right=label in runtime_labels and label not in preferred)
                converted = wire.catalog(engine.runtime_inspection.lookup_catalog)
                catalogs.add(converted)
                catalogs.merge_kinds(context['lookupKinds'], converted['kinds'])
                for label, row in wire.result({'staticFallback': engine._last_static_fallback or {}})['staticFallback'].items():
                    fallback[label] = merge_fallback(fallback.get(label), row,
                        prefer_right=label in runtime_labels and label not in preferred)
                names.update(engine._last_model_names or ())
                sources = wire.context(self.root)['models']
                for label, row in sources.items():
                    if label not in context['models'] or label in runtime_labels and label not in model_sources:
                        context['models'][label] = row
                model_sources.update(runtime_labels)
                preferred.update(runtime_labels)
                context['rootAliases'] = sorted(set(context['rootAliases']) | set(wire.root_aliases))
                for kind, lookups in runtime.custom_lookups.items():
                    context['customLookups'][kind] = sorted(set(context['customLookups'].get(kind, ())) | set(lookups))
                for local, node in engine.model_graph.nodes_by_label.items():
                    model = node.runtime_model
                    if model is None:
                        continue
                    label = wire.label(local)
                    runtime_models.setdefault(label, model)
                    for field in model.fields:
                        field_keys.add((label, field.name))
                        if field.is_relation:
                            (reverse_keys if field.direction == 'reverse' else relation_keys).add((label, field.name))
                    manager_keys.update((label, name) for name in model.manager_names)
                    if not state.runtime.app_names:
                        app_keys.add((group, model.label.split('.', 1)[0]))
                app_keys.update((group, name) for name in state.runtime.app_names)
                for row in runtime.model_preview:
                    previews.setdefault(wire.label(row.label), wire.result(row.to_dict()))
            contexts = list(groups.values())
            for context in contexts:
                items = context['settingsProfiles']
                complete = sum(item.get('bootstrapStatus') == 'ready' and not item['pending'] for item in items)
                context['phase'] = 'ready' if complete == len(items) else 'degraded' if complete or not any(item['pending'] for item in items) else 'starting'
                context['runtimeMembersPending'] = any(item['pending'] for item in items)
                context['settingsModules'] = [item['settingsModule'] for item in items if item['settingsModule']]
                if len(items) > 1:
                    context['settingsModule'] = None
                errors = [item['error'] for item in items if item.get('error')]
                if errors:
                    context['error'] = '\n'.join(dict.fromkeys(errors))
            counts = {'appCount': len(app_keys), 'modelCount': len(runtime_models), 'fieldCount': len(field_keys),
                'relationCount': len(relation_keys), 'reverseRelationCount': len(reverse_keys), 'managerCount': len(manager_keys)}
            catalog = catalogs.value
            static_files = set(self.source_files)
            phase = 'ready' if ready == len(self.projects) else 'degraded' if ready or not self.pending else 'starting'
            model_candidates = {(candidate.file_path, candidate.object_name) for static in static_groups.values()
                for candidate in static.model_candidates}
            health = {
                'phase': phase, 'workspaceRoot': str(self.root),
                'detail': f'Runtime ORM inspection completed for {ready}/{len(self.projects)} settings across {len(groups)} Django projects.'
                    + (f' {len(self.pending)} settings pending.' if self.pending else ''),
                'capabilities': ['workspace.discovery', 'workspace.settings_projects', 'static.index', 'semantic.graph']
                    + (['runtime.environment', 'runtime.django_setup', 'runtime.orm_metadata'] if ready else []),
                'settingsModule': None, 'settingsCandidates': list(dict.fromkeys(candidate for project in self.projects for candidate in project.candidates)),
                'settingsProjects': contexts, 'settingsProfiles': profiles, 'startedAt': self.started_at.isoformat(),
                'staticIndex': {'pythonFileCount': len(static_files), 'packageInitCount': sum(path.name == '__init__.py' for path in static_files),
                    'reexportModuleCount': sum(static.reexport_module_count for static in static_groups.values()),
                    'starImportCount': sum(static.star_import_count for static in static_groups.values()),
                    'explicitAllCount': sum(static.explicit_all_count for static in static_groups.values()),
                    'modelCandidateCount': len(model_candidates)},
                'runtime': {'djangoImportable': any(state.engine.runtime_inspection.django_importable for state in self.states.values()),
                    'djangoVersion': next((state.engine.runtime_inspection.django_version for state in self.states.values()
                        if state.engine.runtime_inspection.django_version), None),
                    'bootstrapStatus': 'warming_up' if self.pending else 'ready' if ready == len(self.projects) else 'setup_failed',
                    'settingsModule': None, 'projectCount': len(groups),
                    'readyProjectCount': sum(context['phase'] == 'ready' for context in contexts),
                    'settingsCount': len(self.projects), 'readySettingsCount': ready,
                    **counts, 'modelPreview': list(previews.values())[:10]},
                'semanticGraph': {'coverageMode': 'hybrid_scaffold' if ready else 'static_only_scaffold',
                    'moduleCount': len(static_files), 'exportSurfaceCount': 0,
                    'modelCandidateCount': len(model_candidates),
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
            self._model_ids.clear()
            self._label_owners.clear()
