//! Django static ORM index builder. Rust port of
//! `python/django_orm_intellisense/static_index/indexer.py`.
//!
//! Scope for P4.1 (current): file-level AST parsing and per-module
//! extraction of:
//!   - `class X(...)` candidates that plausibly inherit from Django's
//!     `Model` (direct models.Model, Model, or a name listed among the
//!     declared bases — broader filtering happens in post-processing).
//!   - Field declarations of the form `name = <Call>(...)` where the
//!     callable name matches a known Django field class.
//!   - Import bindings necessary to resolve non-qualified field/model
//!     references.
//!
//! Deferred to P4.2 (new task spawned by P4.1):
//!   - Cross-module base class resolution (chained abstract models).
//!   - `related_name` inference and reverse relation emission.
//!   - Editable install source dir walk.
//!   - `register_lookup()` detection (covered separately by runtime
//!     inspector).

pub mod indexer;
pub mod resolver;
pub mod types;
pub mod visitor;

pub use indexer::{build_static_index, build_static_index_resolved, parse_module};
pub use resolver::{expand_via_inheritance, resolve_fields, synthesize_reverse_relations};
pub use types::{
    DefinitionLocation, FieldCandidate, ImportBinding, ModelCandidate, ModuleIndex,
    PendingFieldCandidate, ProjectMethod, StaticIndex,
};
