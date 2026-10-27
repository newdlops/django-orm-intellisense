"""Fresh-process runtime member refresh with source-epoch evidence and owned files."""
from __future__ import annotations

import os
import dataclasses
import pickle
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..discovery.workspace import _source_stat_identity
from .worker_lifetime import ParentExitPipe
from .worker_state import runtime_member_refresh_state_file, load_surface_worker_state


@dataclass(frozen=True, slots=True)
class RuntimeMemberRefresh:
    snapshot: object
    surface: dict
    fingerprints: dict
    complete: bool = True
    runtime_metadata: dict | None = None
    graph_delta: object | None = None
    lookup_catalog_delta: dict | None = None


@dataclass(frozen=True, slots=True)
class RuntimeInitialization:
    # A single pickle graph preserves the static/runtime/graph record aliases.
    static_index: object
    runtime: object
    model_graph: object
    member_snapshot: object


@dataclass(frozen=True, slots=True)
class RuntimeGraphDelta:
    labels: frozenset[str]
    fields: dict
    nodes: dict
    edges: dict
    overrides: dict
    removed_models: frozenset[str]


def model_graph_delta(previous, current):
    if previous is current:
        return None
    labels = frozenset(label for label in previous.nodes_by_label.keys() | current.nodes_by_label.keys()
        if previous.nodes_by_label.get(label) is not current.nodes_by_label.get(label)
        or previous.fields_by_model_label.get(label) is not current.fields_by_model_label.get(label)
        or previous.edges_by_source_label.get(label) is not current.edges_by_source_label.get(label)
        or previous.static_field_overrides.get(label) is not current.static_field_overrides.get(label))
    if not labels and previous.removed_static_model_labels == current.removed_static_model_labels:
        return None
    select = lambda values: {label: values[label] for label in labels if label in values}
    return RuntimeGraphDelta(labels, select(current.fields_by_model_label), select(current.nodes_by_label),
        select(current.edges_by_source_label), select(current.static_field_overrides), current.removed_static_model_labels)


def apply_runtime_graph_delta(previous, delta):
    if delta is None:
        return previous
    from ..semantic.graph import ModelGraph, _reindex_changed_graph_nodes
    def overlay(values, updated):
        result = {label: value for label, value in values.items() if label not in delta.labels}
        result.update(updated)
        return result
    nodes = overlay(previous.nodes_by_label, delta.nodes)
    by_name, by_path = _reindex_changed_graph_nodes(previous, nodes, delta.labels)
    return ModelGraph(overlay(previous.fields_by_model_label, delta.fields), nodes,
        by_name, by_path, overlay(previous.edges_by_source_label, delta.edges),
        overlay(previous.static_field_overrides, delta.overrides), delta.removed_models)


def refresh_runtime_model_graph(static, runtime, graph, previous, snapshot):
    """Reconcile newly registered/renamed models in the fresh Django process."""
    from ..semantic.graph import rebuild_model_graph_for_labels
    old = getattr(previous, 'models', {})
    models = snapshot.models
    candidates = {(candidate.module, candidate.object_name): candidate
        for candidate in static.concrete_model_candidates}
    changed = {key for key in old.keys() | models.keys() if old.get(key) != models.get(key)}
    invalidated = getattr(previous, 'invalidated_labels', frozenset())
    changed.update(key for key in models if key in candidates and candidates[key].label in invalidated)
    if not changed:
        return graph, set()
    affected, aliases = set(), set()
    for key in changed:
        candidate = candidates.get(key)
        summary = models.get(key) or old.get(key)
        if candidate is not None:
            affected.add(candidate.label)
            aliases.add(candidate.label)
        elif summary is not None:
            affected.add(summary.label)
        if summary is not None:
            aliases.add(summary.label)
        node = graph.node_by_import_path.get('.'.join(key))
        if node is not None:
            aliases.add(node.label)
    # A source edit already marks relationship/import dependents. A canonical
    # label change also updates unchanged relations pointing at the old alias.
    affected.update(invalidated)
    for label, fields in graph.fields_by_model_label.items():
        if any(field.related_model_label in aliases or field.declared_model_label in aliases
                for field in fields.values()):
            node = graph.nodes_by_label[label]
            affected.add(node.model_candidate.label if node.model_candidate is not None else label)
    updated = rebuild_model_graph_for_labels(graph, old_static_index=static,
        static_index=static, runtime=runtime, affected_labels=affected)
    return updated, affected


def _surface_keys_by_label(static_index, graph):
    from ..features.orm_members import _build_static_to_graph_label_map
    labels = _build_static_to_graph_label_map(static_index, graph)
    return {candidate.label: labels.get(candidate.label, candidate.label)
        for candidate in static_index.model_candidates if not candidate.is_abstract}


def changed_runtime_surface_labels(previous, current, keys_by_label, known_keys):
    """Compare all fresh records, including unrelated and named-manager changes."""
    if previous is None or known_keys is None or previous.runtime_identity != current.runtime_identity:
        return None
    changed = set(previous.invalidated_labels) | (previous.complete_labels ^ current.complete_labels)
    for key in previous.items.keys() | current.items.keys():
        if previous.items.get(key) != current.items.get(key):
            changed.add(key[0])
    for label in previous.manager_names.keys() | current.manager_names.keys():
        if previous.manager_names.get(label) != current.manager_names.get(label):
            changed.add(label)
    changed.update(label for label, key in keys_by_label.items() if key not in known_keys)
    return frozenset(changed)


def compose_runtime_member_surface(static_index, graph, result, existing_surface, existing_fingerprints):
    if result.complete:
        return result.surface, result.fingerprints
    expected = set(_surface_keys_by_label(static_index, graph).values())
    surface = {key: entry for key, entry in existing_surface.items() if key in expected}
    fingerprints = {key: fingerprint for key, fingerprint in existing_fingerprints.items() if key in expected}
    surface.update(result.surface)
    fingerprints.update(result.fingerprints)
    if surface.keys() != expected or fingerprints.keys() != expected:
        raise RuntimeError('Partial runtime member refresh did not cover the complete current model surface')
    return surface, fingerprints


@dataclass(frozen=True, slots=True)
class RuntimeSourceEpoch:
    baseline: dict
    changes: dict
    uncertain: frozenset[str] = frozenset()
    roots: tuple[str, ...] = ()

    @classmethod
    def from_snapshot(cls, snapshot, extra_roots=()):
        identities = getattr(snapshot, '_file_identities', None)
        if identities is None or len(identities) != len(snapshot.files):
            return None
        return cls(dict(zip(map(str, snapshot.files), identities)), {},
            roots=(snapshot.root, *map(str, extra_roots)))

    def after_reindex(self, file_path, aliases, before, after, reliable):
        path = str(file_path)
        candidates = {path}
        for raw, canonical in aliases:
            if path == canonical or path.startswith(canonical + os.sep):
                candidates.add(raw + path[len(canonical):])
        selected = {name for name in candidates if name in self.baseline or name in self.changes}
        if not selected:
            selected = {raw + path[len(canonical):] for raw, canonical in aliases
                if raw in self.roots and (path == canonical or path.startswith(canonical + os.sep))}
            if not selected:
                selected = {path}
        changes = dict(self.changes)
        uncertain = set(self.uncertain) - selected
        if not reliable or before != after:
            uncertain.update(selected)
        for name in selected:
            changes[name] = after
        return RuntimeSourceEpoch(self.baseline, changes, frozenset(uncertain), self.roots)

    def matches(self, snapshot):
        identities = getattr(snapshot, '_file_identities', None)
        if self.uncertain or identities is None or len(identities) != len(snapshot.files):
            return False
        expected = dict(self.baseline)
        for name, identity in self.changes.items():
            if identity is None:
                expected.pop(name, None)
            else:
                expected[name] = identity
        return len(expected) == len(snapshot.files) and all(
            expected.get(str(path)) == identity for path, identity in zip(snapshot.files, identities))


def source_identity(path):
    try:
        return _source_stat_identity(path.stat()), True
    except FileNotFoundError:
        return None, True
    except OSError:
        return None, False


def _stop_owned_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)


def refresh_in_process(static_index, runtime, graph, root, extra_roots, is_current, stopping,
        surface_keys=None, *, fresh_runtime=False):
    """Return pure records/surface, or cancel; no project code runs in the parent."""
    if stopping.is_set():
        return None
    with runtime_member_refresh_state_file(static_index, runtime, graph, surface_keys) as input_path:
        result = Path(input_path).with_name('runtime-result.pickle')
        log = result.with_suffix('.log')
        if stopping.is_set() or not is_current():
            return None
        environment = dict(os.environ)
        # The selected interpreter supplies its own stdlib and site-packages.
        # Keep only the package location plus the caller's declared search path.
        package_root = str(Path(__file__).resolve().parents[2])
        declared_paths = environment.get('PYTHONPATH')
        if declared_paths is None:
            environment['PYTHONPATH'] = package_root
        elif declared_paths.split(os.pathsep, 1)[0] != package_root:
            environment['PYTHONPATH'] = package_root + os.pathsep + declared_paths
        with log.open('wb') as errors, ParentExitPipe() as parent_exit:
            parent_arguments, parent_options = parent_exit.spawn_parameters()
            if stopping.is_set():
                return None
            process = subprocess.Popen([runtime.python_executable, '-m',
                'django_orm_intellisense._runtime_member_worker',
                *(['--fresh-runtime'] if fresh_runtime else []), input_path, str(result),
                str(root), *map(str, extra_roots), *parent_arguments], cwd=root, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, **parent_options)
            try:
                parent_exit.child_spawned()
                while process.poll() is None:
                    if not is_current() or stopping.wait(0.02):
                        return None
                if stopping.is_set() or not is_current():
                    return None
                if process.returncode != 0:
                    raise RuntimeError(f'Fresh runtime member worker exited with code {process.returncode}')
                with result.open('rb') as stream:
                    return pickle.load(stream)
            finally:
                _stop_owned_process(process)


def worker_main(input_path, result_path, root, extra_roots, *, fresh_runtime=False):
    from ..features.orm_members import (capture_current_runtime_members,
        prebuild_member_surface_cache, build_surface_index, fingerprint_surface_index)
    from ..runtime.source_imports import current_workspace_source_imports
    from ..runtime.inspector import collect_runtime_model_metadata
    from ..runtime.lookup_catalog import collect_model_lookup_catalog
    static, runtime, graph, surface_keys = load_surface_worker_state(input_path)
    if fresh_runtime:
        from ..runtime.inspector import inspect_runtime
        from ..semantic.graph import build_model_graph
        with current_workspace_source_imports((root, *extra_roots)):
            runtime = inspect_runtime(runtime.settings_module)
            graph = build_model_graph(static, runtime)
            snapshot = (capture_current_runtime_members(static, runtime, graph)
                if runtime.bootstrap_status == 'ready' else None)
        static._runtime_member_snapshot = snapshot
        with Path(result_path).open('wb') as stream:
            pickle.dump(RuntimeInitialization(static, runtime, graph, snapshot),
                stream, protocol=pickle.HIGHEST_PROTOCOL)
        return
    # Serialized captures describe the parent's older classes/epoch. This
    # process has never populated Django and must inspect its own fresh app.
    previous = static._runtime_member_snapshot
    static._runtime_member_snapshot = None
    with current_workspace_source_imports((root, *extra_roots)):
        snapshot = capture_current_runtime_members(static, runtime, graph)
        known = {(model.module, model.label.rsplit('.', 1)[-1]): model for model in runtime.model_catalog}
        metadata = collect_runtime_model_metadata(model_limit=10, model_reference=known)
        models = {(model.module, model.label.rsplit('.', 1)[-1]): model for model in metadata.models
            if known.get((model.module, model.label.rsplit('.', 1)[-1])) != model}
        old_models = getattr(previous, 'models', {})
        if models == old_models:
            models = old_models
        snapshot = dataclasses.replace(snapshot, models=models)
        static._runtime_member_snapshot = snapshot
        current_graph, graph_labels = refresh_runtime_model_graph(static, runtime, graph, previous, snapshot)
        delta = model_graph_delta(graph, current_graph)
        # Fresh runtime-only classes have no AST candidate in the first capture.
        if any(node.runtime_model is not None and node.model_candidate is None
                and label not in graph.nodes_by_label for label, node in current_graph.nodes_by_label.items()):
            snapshot = dataclasses.replace(capture_current_runtime_members(static, runtime, current_graph), models=models)
            static._runtime_member_snapshot = snapshot
        # Source helpers and lookup registrations can change a descriptor
        # without changing a model's graph summary. Refresh their invalidated
        # model catalogues from this fresh registry even when graph_delta is empty.
        keys_by_label = _surface_keys_by_label(static, current_graph)
        lookup_labels = {keys_by_label.get(label, label)
            for label in getattr(previous, 'invalidated_labels', ())}
        if delta is not None:
            lookup_labels.update(delta.labels)
        lookup_delta = {}
        for label in lookup_labels:
            if label in current_graph.nodes_by_label:
                lookup_delta[label] = collect_model_lookup_catalog(current_graph, runtime, label, use_current_registry=True)
            elif label in runtime.lookup_catalog.get('fields', {}):
                lookup_delta[label] = None
        runtime_metadata = metadata.to_health_dict()
    static._runtime_member_snapshot = snapshot
    labels = changed_runtime_surface_labels(previous, snapshot, keys_by_label, surface_keys)
    if labels is not None:
        labels = labels | graph_labels
    surface = (prebuild_member_surface_cache(static, runtime, current_graph) if labels is None
        else build_surface_index(static, runtime, current_graph, labels=labels))
    fingerprints = fingerprint_surface_index(surface)
    with Path(result_path).open('wb') as stream:
        pickle.dump(RuntimeMemberRefresh(snapshot, surface, fingerprints, complete=labels is None,
            runtime_metadata=runtime_metadata, graph_delta=delta, lookup_catalog_delta=lookup_delta),
            stream, protocol=pickle.HIGHEST_PROTOCOL)
