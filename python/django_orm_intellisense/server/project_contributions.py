"""Generation-owned qualified records and incremental repository model tables."""
from __future__ import annotations

from dataclasses import dataclass

from ..features.orm_members import fingerprint_surface_index
from .settings_union import CatalogUnion, merge_fallback, merge_surface


@dataclass
class _Contribution:
    sources: tuple
    labels: dict
    surface: dict
    fallback: dict
    catalog: dict
    models: dict
    runtime_labels: frozenset
    statistics: tuple
    names: tuple
    custom_lookups: dict


def _same_sources(left, right):
    return len(left) == len(right) and all(a is b for a, b in zip(left, right))


def _qualify_rows(wire, rows, old_rows, qualified, labels_unchanged):
    return {wire.label(label): qualified[wire.label(label)]
        if labels_unchanged and label in old_rows and old_rows[label] == row
            and wire.label(label) in qualified else wire.metadata(row)
        for label, row in rows.items()}


def _contribution(state, root, previous):
    engine, wire = state.engine, state.wire
    runtime = engine.runtime_inspection
    sources = (engine._last_surface_index, engine._last_static_fallback, runtime.lookup_catalog,
        engine.model_graph, runtime.model_catalog, engine._last_model_names, runtime.custom_lookups)
    if previous is not None and _same_sources(previous.sources, sources) and previous.labels == wire.label_map:
        return previous
    labels_unchanged = previous is not None and previous.labels == wire.label_map
    surface = _qualify_rows(wire, sources[0] or {}, previous.sources[0] or {} if previous else {},
        previous.surface if previous else {}, labels_unchanged)
    fallback = _qualify_rows(wire, sources[1] or {}, previous.sources[1] or {} if previous else {},
        previous.fallback if previous else {}, labels_unchanged)
    catalog = (previous.catalog if labels_unchanged and previous.sources[2] == sources[2]
               else wire.catalog(runtime.lookup_catalog))
    models = previous.models if previous is not None and previous.sources[3] is sources[3] and labels_unchanged else wire.context(root)['models']
    graph = engine.model_graph
    runtime_labels = frozenset(wire.label(label) for label, node in graph.nodes_by_label.items() if node.runtime_model is not None)
    if previous is not None and previous.sources[3] is sources[3] and labels_unchanged:
        statistics = previous.statistics
    else:
        fields, relations, reverse, managers, apps, models_seen = set(), set(), set(), set(), set(), set()
        group = wire.project.group_namespace or wire.project.namespace
        for local, node in graph.nodes_by_label.items():
            model = node.runtime_model
            if model is None:
                continue
            label = wire.label(local)
            models_seen.add(label)
            for field in model.fields:
                fields.add((label, field.name))
                if field.is_relation:
                    (reverse if field.direction == 'reverse' else relations).add((label, field.name))
            managers.update((label, name) for name in model.manager_names)
            if not state.runtime.app_names:
                apps.add((group, model.label.split('.', 1)[0]))
        apps.update((group, name) for name in state.runtime.app_names)
        statistics = tuple(frozenset(values) for values in (apps, models_seen, fields, relations, reverse, managers))
    return _Contribution(sources, dict(wire.label_map), surface, fallback, catalog, models,
        runtime_labels, statistics, tuple(engine._last_model_names or ()), runtime.custom_lookups)


class ProjectContributions:
    """No process-global pool: old published tables remain immutable to callers."""
    def __init__(self):
        self.profiles = {}
        self.surface = {}
        self.fallback = {}
        self.fingerprints = {}
        self.catalog = CatalogUnion().value
        self.groups = {}
        self.names = []
        self.counts = {key: 0 for key in ('appCount', 'modelCount', 'fieldCount',
            'relationCount', 'reverseRelationCount', 'managerCount')}
        self.previews = []

    def sync(self, projects, states, root):
        next_profiles = {project.namespace: _contribution(states[project.namespace], root,
            self.profiles.get(project.namespace)) for project in projects if project.namespace in states}
        changed = {namespace for namespace in self.profiles.keys() | next_profiles.keys()
            if self.profiles.get(namespace) is not next_profiles.get(namespace)}
        if not changed:
            return
        dirty_surface, dirty_fallback = set(), set()
        catalog_changed = False
        for namespace in changed:
            old, new = self.profiles.get(namespace), next_profiles.get(namespace)
            for target, name in ((dirty_surface, 'surface'), (dirty_fallback, 'fallback')):
                before, after = getattr(old, name, {}), getattr(new, name, {})
                for label in before.keys() | after.keys():
                    if before.get(label) is not after.get(label) or (label in (old.runtime_labels if old else ())
                            ) != (label in (new.runtime_labels if new else ())):
                        target.add(label)
            catalog_changed |= old is None or new is None or old.catalog is not new.catalog
        self.surface = self._merge_rows(next_profiles, dirty_surface, 'surface', self.surface, merge_surface)
        self.fallback = self._merge_rows(next_profiles, dirty_fallback, 'fallback', self.fallback, merge_fallback)
        if dirty_surface:
            fingerprints = dict(self.fingerprints)
            fingerprints.update(fingerprint_surface_index(self.surface, labels=dirty_surface))
            for label in dirty_surface - self.surface.keys():
                fingerprints.pop(label, None)
            self.fingerprints = fingerprints
        catalogs = CatalogUnion()
        if catalog_changed:
            for value in next_profiles.values():
                catalogs.add(value.catalog)
        else:
            # Group kind joins must use the same descriptor table as the
            # published global catalogue; unchanged metadata retains identity.
            catalogs.value = self.catalog
        groups, names, previews = {}, set(), {}
        statistics = [set() for _ in range(6)]
        for project in projects:
            group = project.group_namespace or project.namespace
            context = groups.setdefault(group, {**project.to_dict(), 'namespace': group,
                'models': {}, 'lookupKinds': {}, 'rootAliases': [], 'customLookups': {}})
            if not catalog_changed:
                context['lookupKinds'] = self.groups.get(group, {}).get('lookupKinds', {})
            value = next_profiles.get(project.namespace)
            if value is None:
                continue
            state = states[project.namespace]
            for label, row in value.models.items():
                if label not in context['models'] or label in value.runtime_labels and label not in context.setdefault('_runtimeLabels', set()):
                    context['models'][label] = row
            context.setdefault('_runtimeLabels', set()).update(value.runtime_labels)
            context['rootAliases'] = sorted(set(context['rootAliases']) | set(state.wire.root_aliases))
            if catalog_changed:
                catalogs.merge_kinds(context['lookupKinds'], value.catalog['kinds'])
            for kind, lookups in value.custom_lookups.items():
                context['customLookups'][kind] = sorted(set(context['customLookups'].get(kind, ())) | set(lookups))
            names.update(value.names)
            for combined, values in zip(statistics, value.statistics):
                combined.update(values)
            for row in state.engine.runtime_inspection.model_preview:
                previews.setdefault(state.wire.label(row.label), state.wire.result(row.to_dict()))
        for context in groups.values():
            context.pop('_runtimeLabels', None)
        if catalog_changed:
            self.catalog = catalogs.value
        self.groups, self.names = groups, sorted(names)
        self.counts = dict(zip(('appCount', 'modelCount', 'fieldCount', 'relationCount', 'reverseRelationCount', 'managerCount'), map(len, statistics)))
        self.previews = list(previews.values())[:10]
        self.profiles = next_profiles

    @staticmethod
    def _merge_rows(profiles, dirty, name, published, merge):
        replacements = {}
        removed = set()
        for label in dirty:
            row, preferred = {}, False
            found = False
            for value in profiles.values():
                current = getattr(value, name).get(label)
                if current is None:
                    continue
                runtime = label in value.runtime_labels
                row = merge(row, current, prefer_right=runtime and not preferred)
                preferred |= runtime
                found = True
            if found:
                if published.get(label) != row:
                    replacements[label] = row
            elif label in published:
                removed.add(label)
        if not replacements and not removed:
            return published
        result = {**published, **replacements}
        for label in removed:
            result.pop(label, None)
        return result

    def clear(self):
        self.__init__()
