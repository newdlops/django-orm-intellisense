"""Merge pure settings snapshots without overwriting another registry's data."""
from __future__ import annotations

import hashlib


def merge_surface(left, right, *, prefer_right=False):
    result = dict(left)
    for kind, members in right.items():
        previous = result.get(kind, {})
        result[kind] = ({**previous, **members} if prefer_right else {**members, **previous})
    return result


def merge_fallback(left, right, *, prefer_right=False):
    if not left:
        return right
    result = {**right, **left}
    for key in ('fields', 'relations', 'reverseRelations'):
        result[key] = sorted(set(left.get(key, ())) | set(right.get(key, ())))
    result['fieldDetails'] = ({**left.get('fieldDetails', {}), **right.get('fieldDetails', {})}
        if prefer_right else {**right.get('fieldDetails', {}), **left.get('fieldDetails', {})})
    result['runtimeOnly'] = bool(left.get('runtimeOnly') and right.get('runtimeOnly'))
    return result


class CatalogUnion:
    def __init__(self):
        self.value = {key: {} for key in ('fields', 'types', 'expressionFields', 'relationPaths', 'kinds')}
        self._pairs = {}

    def type_union(self, left, right):
        if left == right or right is None:
            return left
        if left is None:
            return right
        pair = tuple(sorted((left, right)))
        previous = self._pairs.get(pair)
        if previous is not None:
            return previous
        types = self.value['types']
        first, second = types.get(left), types.get(right)
        if first is None or second is None:
            # Model-bound field types are lazy references, not descriptors.
            if left.startswith('model:') and right.startswith('model:'):
                _, a_model, a_type = left.split(':', 2)
                _, b_model, b_type = right.split(':', 2)
                if a_model == b_model:
                    return 'model:' + a_model + ':' + self.type_union(a_type, b_type)
            return left
        merged_id = 'settings-union:' + hashlib.sha256('\0'.join(pair).encode()).hexdigest()[:24]
        # Install the reference before following cyclic transforms (JSON etc.).
        self._pairs[pair] = merged_id
        merged = {**first, 'lookups': sorted(set(first.get('lookups', ())) | set(second.get('lookups', ()))),
                  'transforms': {}}
        types[merged_id] = merged
        if first.get('fieldKind') != second.get('fieldKind'):
            merged['fieldKind'] = 'Field'
            merged.pop('baseKind', None)
        for name in ('runtimeTransforms', 'runtimeLookups'):
            if first.get(name) or second.get(name):
                merged[name] = True
        a_transforms, b_transforms = first.get('transforms', {}), second.get('transforms', {})
        for name in dict.fromkeys((*a_transforms, *b_transforms)):
            merged['transforms'][name] = self.type_union(a_transforms.get(name), b_transforms.get(name))
        a_dynamic, b_dynamic = first.get('dynamicTransform'), second.get('dynamicTransform')
        if a_dynamic and b_dynamic and a_dynamic['kind'] == b_dynamic['kind']:
            dynamic = {**a_dynamic, 'outputType': self.type_union(a_dynamic.get('outputType'), b_dynamic.get('outputType'))}
            if 'sliceType' in a_dynamic or 'sliceType' in b_dynamic:
                dynamic['sliceType'] = self.type_union(a_dynamic.get('sliceType'), b_dynamic.get('sliceType'))
            dynamic['blockedNames'] = sorted(set(a_dynamic.get('blockedNames', ())) & set(b_dynamic.get('blockedNames', ())))
            merged['dynamicTransform'] = dynamic
        elif not a_dynamic and b_dynamic:
            merged['dynamicTransform'] = b_dynamic
        return merged_id

    def add(self, catalog):
        self.value['types'].update(catalog.get('types', {}))
        for key in ('fields', 'expressionFields'):
            for label, fields in catalog.get(key, {}).items():
                combined = dict(self.value[key].get(label, {}))
                for name, type_id in fields.items():
                    combined[name] = self.type_union(combined.get(name), type_id)
                self.value[key][label] = combined
        for label, paths in catalog.get('relationPaths', {}).items():
            self.value['relationPaths'][label] = {**paths, **self.value['relationPaths'].get(label, {})}
        return self.merge_kinds(self.value['kinds'], catalog.get('kinds', {}))

    def merge_kinds(self, left, right):
        for kind, type_id in right.items():
            left[kind] = self.type_union(left.get(kind), type_id)
        return left
