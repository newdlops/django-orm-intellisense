"""Model-at-a-time records for a source-bound runtime member snapshot."""
from __future__ import annotations

import dataclasses
import hashlib
import json

from ..features.orm_members import OrmMemberItem, RuntimeMemberSnapshot
from ..runtime.inspector import RuntimeModelSummary

VERSION = 1
_KINDS = frozenset(('instance', 'model_class', 'manager', 'queryset', 'related_manager'))
_FIELDS = ('name', 'member_kind', 'model_label', 'receiver_kind', 'detail', 'source',
    'return_kind', 'return_model_label', 'manager_name', 'file_path', 'line', 'column',
    'field_kind', 'is_relation', 'signature')
_TEXT = frozenset(('name', 'member_kind', 'model_label', 'receiver_kind', 'detail', 'source'))
_OPTIONAL_TEXT = frozenset(('return_kind', 'return_model_label', 'manager_name', 'file_path',
    'field_kind', 'signature'))


@dataclasses.dataclass(frozen=True, slots=True)
class RestoredRuntimeModel:
    label: str
    digest: str
    complete: bool
    invalidated: bool
    managers: tuple[str, ...] | None
    receivers: dict
    models: dict


def _strings(value):
    if type(value) is not list or any(type(item) is not str for item in value):
        raise ValueError('Invalid runtime member names.')
    if len(set(value)) != len(value):
        raise ValueError('Duplicate runtime member name.')
    return tuple(value)


def _item(row, strings):
    if type(row) is not list or len(row) != len(_FIELDS):
        raise ValueError('Invalid runtime member record.')
    for name, value in zip(_FIELDS, row):
        if name in _TEXT:
            valid = type(value) is str
        elif name in _OPTIONAL_TEXT:
            valid = value is None or type(value) is str
        elif name == 'is_relation':
            valid = type(value) is bool
        else:
            valid = value is None or type(value) is int and value >= 0
        if not valid:
            raise ValueError('Invalid runtime member property: ' + name)
    return OrmMemberItem(**{name: strings.setdefault(value, value) if type(value) is str else value
        for name, value in zip(_FIELDS, row)})


def model_from_row(label, row):
    if type(label) is not str or type(row) is not dict or row.keys() != {
            'complete', 'invalidated', 'managerNames', 'receivers', 'models'}:
        raise ValueError('Invalid runtime model record.')
    if type(row['complete']) is not bool or type(row['invalidated']) is not bool:
        raise ValueError('Invalid runtime model completeness.')
    managers = None if row['managerNames'] is None else _strings(row['managerNames'])
    strings = {label: label}
    if managers is not None:
        managers = tuple(strings.setdefault(value, value) for value in managers)
    if type(row['receivers']) is not list or type(row['models']) is not list:
        raise ValueError('Invalid runtime model collections.')
    receivers = {}
    for entry in row['receivers']:
        if type(entry) is not list or len(entry) != 3:
            raise ValueError('Invalid runtime receiver record.')
        kind, manager, values = entry
        if (type(kind) is not str or kind not in _KINDS
                or manager is not None and type(manager) is not str or type(values) is not list):
            raise ValueError('Invalid runtime receiver owner.')
        key = (strings.setdefault(kind, kind), strings.setdefault(manager, manager) if manager is not None else None)
        if key in receivers:
            raise ValueError('Duplicate runtime receiver.')
        items = tuple(_item(value, strings) for value in values)
        if any(item.model_label != label for item in items):
            raise ValueError('Invalid runtime member owner.')
        # Manager and QuerySet implementations may share a name. Their
        # original order participates in the existing surface precedence.
        # A related-manager capture legitimately contains receiverKind=manager.
        # Preserve the complete original record instead of rewriting its kind.
        receivers[key] = items
    models = {}
    for entry in row['models']:
        if (type(entry) is not list or len(entry) != 3 or type(entry[0]) is not str
                or type(entry[1]) is not str or type(entry[2]) is not dict):
            raise ValueError('Invalid captured runtime model metadata.')
        key = (entry[0], entry[1])
        if key in models:
            raise ValueError('Duplicate captured runtime model metadata.')
        model = RuntimeModelSummary.from_dict(entry[2])
        # Compare JSON types as well as values (True must not accept integer1).
        if (model.label != label or json.dumps(model.to_dict(), sort_keys=True)
                != json.dumps(entry[2], sort_keys=True)):
            raise ValueError('Invalid captured runtime model properties.')
        models[key] = model
    return RestoredRuntimeModel(label, row_digest(row), row['complete'], row['invalidated'], managers, receivers, models)


def row_digest(row):
    encoded = json.dumps(row, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
    return hashlib.sha256(encoded).hexdigest()


def fingerprint_digests(digests):
    digest = hashlib.sha256(b'django-runtime-member-catalog-v1\0')
    for label in sorted(digests):
        digest.update(json.dumps(label, ensure_ascii=True).encode('ascii'))
        digest.update(b'\0' + digests[label].encode('ascii') + b'\0')
    return digest.hexdigest()


def snapshot_rows(snapshot):
    """Index existing owned records without duplicating their item payloads."""
    labels = set(snapshot.complete_labels) | set(snapshot.invalidated_labels) | set(snapshot.manager_names)
    receivers, models = {}, {}
    for (label, kind, manager), items in snapshot.items.items():
        labels.add(label)
        receivers.setdefault(label, []).append((kind, manager, items))
    for (module, name), model in snapshot.models.items():
        labels.add(model.label)
        models.setdefault(model.label, []).append((module, name, model))
    def row(label):
        return {'complete': label in snapshot.complete_labels, 'invalidated': label in snapshot.invalidated_labels,
            'managerNames': list(snapshot.manager_names[label]) if label in snapshot.manager_names else None,
            'receivers': [[kind, manager, [[getattr(item, name) for name in _FIELDS] for item in items]]
                for kind, manager, items in receivers.get(label, ())],
            'models': [[module, name, model.to_dict()] for module, name, model in models.get(label, ())]}
    return labels, row


def restore_snapshot(payload, identity, *, expected_identity, expected_fingerprint):
    if (type(identity) is not list or len(identity) != 3
            or any(item is not None and type(item) is not str for item in identity)
            or tuple(identity) != expected_identity or type(payload) is not dict):
        raise ValueError('Invalid runtime member snapshot identity.')
    if (type(expected_fingerprint) is not str or len(expected_fingerprint) != 64
            or any(char not in '0123456789abcdef' for char in expected_fingerprint)):
        raise ValueError('Invalid runtime member fingerprint.')
    items, managers, complete, invalidated, models, digests = {}, {}, set(), set(), {}, {}
    for label, row in payload.items():
        value = row if type(row) is RestoredRuntimeModel else model_from_row(label, row)
        if value.label != label:
            raise ValueError('Restored runtime model belongs to another label.')
        digests[label] = value.digest
        if value.complete: complete.add(label)
        if value.invalidated: invalidated.add(label)
        if value.managers is not None: managers[label] = value.managers
        for (kind, manager), records in value.receivers.items():
            items[(label, kind, manager)] = records
        if models.keys() & value.models.keys():
            raise ValueError('Duplicate runtime model across owners.')
        models.update(value.models)
    if fingerprint_digests(digests) != expected_fingerprint:
        raise ValueError('Incomplete or changed runtime member catalog.')
    return RuntimeMemberSnapshot(tuple(identity), items, managers, frozenset(complete),
        frozenset(invalidated), models)
