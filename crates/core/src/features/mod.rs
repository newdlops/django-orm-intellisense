//! Static knowledge bases and helpers used by completion providers.
//! Rust port of `python/django_orm_intellisense/features/`.

pub mod django_builtins;
pub mod lookup_paths;
pub mod orm_members;
pub mod reexports;
pub mod relation_targets;

pub use django_builtins::{
    BuiltinCategory, BuiltinMethodInfo, BuiltinReturnKind, INSTANCE_BUILTIN_METHODS,
    MANAGER_BUILTIN_METHODS, QUERYSET_BUILTIN_METHODS,
};
pub use lookup_paths::{
    clear_descendant_cache, is_default_lookup_operator, is_filter_method, is_relation_only_method,
    list_lookup_path_completions, resolve_lookup_path, LookupPathCompletionsResult, LookupPathItem,
    LookupResolution, LookupSegment, DEFAULT_LOOKUP_OPERATORS, FILTER_LOOKUP_METHODS,
    RELATION_ONLY_METHODS,
};
pub use orm_members::{
    build_surface_index, build_wire_surface_index, list_orm_member_completions,
    project_method_item, OrmMemberItem, OrmMemberCompletionsResult, SurfaceIndex, SurfaceModelEntry,
};
pub use reexports::{
    clear_export_cache, resolve_export_origin, resolve_module, ExportResolution, ModuleResolution,
};
pub use relation_targets::{
    list_relation_targets, resolve_relation_target, RelationTarget, ResolutionResult,
};
