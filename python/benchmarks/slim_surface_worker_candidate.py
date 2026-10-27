"""Candidate worker entry point that does not import the RPC daemon."""
import pickle

_state = None


def initialize(path):
    global _state
    with open(path, 'rb') as stream:
        static_index, runtime, model_graph = pickle.load(stream)
    _state = (static_index, runtime, model_graph)


def prebuild():
    if _state is None:
        return {}
    static_index, runtime, model_graph = _state
    if static_index is None or runtime is None or model_graph is None:
        return {}
    from django_orm_intellisense.features.orm_members import prebuild_member_surface_cache
    return prebuild_member_surface_cache(static_index, runtime, model_graph)
