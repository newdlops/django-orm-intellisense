"""Install constructor-argument pickle for fixed immutable record fields."""
import dataclasses
from django_orm_intellisense.discovery.workspace import PythonSourceEntry
from django_orm_intellisense.runtime.inspector import RuntimeFieldSummary, RuntimeRelationSummary
from django_orm_intellisense.semantic.graph import ModelGraphNode, ModelGraphEdge
from django_orm_intellisense.static_index.indexer import (
    DefinitionLocation, ModelCandidate, PendingFieldCandidate, FieldCandidate, ImportBinding)

RECORDS = (PythonSourceEntry, DefinitionLocation, ModelCandidate, PendingFieldCandidate,
           FieldCandidate, ImportBinding, RuntimeFieldSummary, RuntimeRelationSummary,
           ModelGraphNode, ModelGraphEdge)


def install_default_slot_state_pickle():
    # Match the dataclass-generated frozen slots implementation used before
    # production added direct state methods, including its per-call fields().
    def getstate(self):
        return [getattr(self, field.name) for field in dataclasses.fields(self)]

    def setstate(self, state):
        for field, value in zip(dataclasses.fields(self), state):
            object.__setattr__(self, field.name, value)

    for record in RECORDS:
        record.__getstate__ = getstate
        record.__setstate__ = setstate


def install_constructor_pickle():
    for record in RECORDS:
        names = record.__slots__

        def reduce(self, protocol, names=names):
            return type(self), tuple(getattr(self, name) for name in names)

        record.__reduce_ex__ = reduce


def install_tuple_state_pickle():
    for record in RECORDS:
        names = record.__slots__

        def getstate(self, names=names):
            return tuple(getattr(self, name) for name in names)

        def setstate(self, state, names=names):
            for name, value in zip(names, state):
                object.__setattr__(self, name, value)

        record.__getstate__ = getstate
        record.__setstate__ = setstate


def install_direct_state_pickle():
    for record in RECORDS:
        names = record.__slots__
        getter = 'def getstate(self):\n    return (' + ', '.join('self.' + name for name in names) + ',)\n'
        setter = 'def setstate(self, state):\n'
        setter += '    ' + ', '.join(names) + ' = state\n'
        setter += '    assign = object.__setattr__\n'
        setter += ''.join(f'    assign(self, {name!r}, {name})\n' for name in names)
        namespace = {}
        exec(getter + setter, namespace)
        record.__getstate__ = namespace['getstate']
        record.__setstate__ = namespace['setstate']
