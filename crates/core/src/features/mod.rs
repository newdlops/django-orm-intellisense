//! Static knowledge bases and helpers used by completion providers.
//! Rust port of `python/django_orm_intellisense/features/`.

pub mod django_builtins;
pub mod lookup_paths;
pub mod orm_members;
pub mod relation_targets;

pub use django_builtins::{
    BuiltinCategory, BuiltinMethodInfo, BuiltinReturnKind, INSTANCE_BUILTIN_METHODS,
    MANAGER_BUILTIN_METHODS, QUERYSET_BUILTIN_METHODS,
};
pub use lookup_paths::{
    is_default_lookup_operator, is_filter_method, is_relation_only_method, resolve_lookup_path,
    LookupResolution, LookupSegment, DEFAULT_LOOKUP_OPERATORS, FILTER_LOOKUP_METHODS,
    RELATION_ONLY_METHODS,
};
pub use orm_members::{
    build_surface_index, build_wire_surface_index, OrmMemberItem, SurfaceIndex, SurfaceModelEntry,
};
pub use relation_targets::{
    list_relation_targets, resolve_relation_target, RelationTarget, ResolutionResult,
};
