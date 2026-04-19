//! Model graph. Rust port of `python/django_orm_intellisense/semantic/
//! graph.py`, minus runtime `_meta` integration (CPython bound, stays
//! on the Python side) and reverse-relation emission (requires full
//! P4.2 — will land with that work).

pub mod graph;

pub use graph::{build_model_graph, ModelGraph, ModelGraphEdge, ModelGraphNode};
