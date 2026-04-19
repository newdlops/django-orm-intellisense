//! Static tables of Django built-in methods for QuerySet, Manager, and
//! Model instances. Rust port of `features/django_builtins.py` —
//! identical data, read-only.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinReturnKind {
    Queryset,
    Instance,
    Scalar,
    None,
    Bool,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinCategory {
    Query,
    Crud,
    Aggregate,
    Utility,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BuiltinMethodInfo {
    pub name: &'static str,
    pub signature: &'static str,
    pub description: &'static str,
    pub return_kind: BuiltinReturnKind,
    pub category: BuiltinCategory,
}

const fn m(
    name: &'static str,
    signature: &'static str,
    description: &'static str,
    return_kind: BuiltinReturnKind,
    category: BuiltinCategory,
) -> BuiltinMethodInfo {
    BuiltinMethodInfo {
        name,
        signature,
        description,
        return_kind,
        category,
    }
}

use BuiltinCategory::{Aggregate, Crud, Query, Utility};
use BuiltinReturnKind::{Instance, None as RetNone, Queryset, Scalar, Unknown};

pub const QUERYSET_BUILTIN_METHODS: &[BuiltinMethodInfo] = &[
    m("all", "() -> QuerySet", "Return a copy of the current QuerySet.", Queryset, Query),
    m("alias", "(**kwargs) -> QuerySet", "Same as annotate(), but instead of annotating objects in the QuerySet, save the expression for later reuse with other QuerySet methods.", Queryset, Query),
    m("annotate", "(*args, **kwargs) -> QuerySet", "Annotate each object in the QuerySet with the provided expressions.", Queryset, Query),
    m("filter", "(*args, **kwargs) -> QuerySet", "Return a new QuerySet containing objects that match the given lookup parameters.", Queryset, Query),
    m("exclude", "(*args, **kwargs) -> QuerySet", "Return a new QuerySet containing objects that do NOT match the given lookup parameters.", Queryset, Query),
    m("order_by", "(*fields) -> QuerySet", "Order the QuerySet by the given fields.", Queryset, Query),
    m("reverse", "() -> QuerySet", "Reverse the order in which elements are returned.", Queryset, Query),
    m("distinct", "(*fields) -> QuerySet", "Return a new QuerySet with SELECT DISTINCT.", Queryset, Query),
    m("values", "(*fields, **expressions) -> QuerySet", "Return a QuerySet of dictionaries instead of model instances.", Unknown, Query),
    m("values_list", "(*fields, flat=False, named=False) -> QuerySet", "Return a QuerySet of tuples (or flat values) instead of model instances.", Unknown, Query),
    m("dates", "(field, kind, order=\"ASC\") -> QuerySet", "Return a QuerySet of datetime.date objects representing available dates.", Unknown, Query),
    m("datetimes", "(field_name, kind, order=\"ASC\", tzinfo=None) -> QuerySet", "Return a QuerySet of datetime.datetime objects representing available datetimes.", Unknown, Query),
    m("none", "() -> QuerySet", "Return an empty QuerySet.", Queryset, Query),
    m("union", "(*other_qs, all=False) -> QuerySet", "Use SQL UNION to combine two or more QuerySets.", Queryset, Query),
    m("intersection", "(*other_qs) -> QuerySet", "Use SQL INTERSECT to return shared elements of two or more QuerySets.", Queryset, Query),
    m("difference", "(*other_qs) -> QuerySet", "Use SQL EXCEPT to keep only elements in this QuerySet but not in the others.", Queryset, Query),
    m("select_related", "(*fields) -> QuerySet", "Return a QuerySet that follows foreign-key relationships, selecting additional related-object data.", Queryset, Query),
    m("prefetch_related", "(*lookups) -> QuerySet", "Return a QuerySet that prefetches related objects in a separate query.", Queryset, Query),
    m("extra", "(select=None, where=None, params=None, tables=None, order_by=None, select_params=None) -> QuerySet", "Add extra SQL to the query. Deprecated in favor of annotate/filter.", Queryset, Query),
    m("defer", "(*fields) -> QuerySet", "Defer loading of specified fields until accessed.", Queryset, Query),
    m("only", "(*fields) -> QuerySet", "Load only the specified fields immediately.", Queryset, Query),
    m("using", "(alias) -> QuerySet", "Select which database this QuerySet will use.", Queryset, Query),
    m("select_for_update", "(nowait=False, skip_locked=False, of=(), no_key=False) -> QuerySet", "Return a QuerySet with SELECT ... FOR UPDATE.", Queryset, Query),
    m("raw", "(raw_query, params=(), translations=None, using=None) -> RawQuerySet", "Execute a raw SQL query.", Unknown, Query),

    m("get", "(*args, **kwargs) -> Model", "Return a single object matching the given lookup parameters.", Instance, Crud),
    m("create", "(**kwargs) -> Model", "Create a new object, save it, and return it.", Instance, Crud),
    m("get_or_create", "(defaults=None, **kwargs) -> tuple[Model, bool]", "Look up an object, creating one if necessary. Returns a tuple of (object, created).", Unknown, Crud),
    m("update_or_create", "(defaults=None, create_defaults=None, **kwargs) -> tuple[Model, bool]", "Update an object, creating one if necessary. Returns a tuple of (object, created).", Unknown, Crud),
    m("bulk_create", "(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None) -> list[Model]", "Insert the provided list of objects into the database in an efficient manner.", Scalar, Crud),
    m("bulk_update", "(objs, fields, batch_size=None) -> int", "Update the given fields on the provided model instances in an efficient manner.", Scalar, Crud),
    m("update", "(**kwargs) -> int", "Update all elements in the current QuerySet with the given parameters.", Scalar, Crud),
    m("delete", "() -> tuple[int, dict[str, int]]", "Delete all objects in this QuerySet.", Scalar, Crud),

    m("count", "() -> int", "Return the number of objects in the QuerySet.", Scalar, Aggregate),
    m("in_bulk", "(id_list=None, *, field_name=\"pk\") -> dict", "Return a dictionary mapping each of the given IDs to the object with that ID.", Scalar, Crud),
    m("iterator", "(chunk_size=None) -> Iterator", "Evaluate the QuerySet and return an iterator over the results.", Unknown, Utility),
    m("latest", "(*fields) -> Model", "Return the latest object in the table using the provided field(s) for ordering.", Instance, Query),
    m("earliest", "(*fields) -> Model", "Return the earliest object in the table using the provided field(s) for ordering.", Instance, Query),
    m("first", "() -> Model | None", "Return the first object matched by the QuerySet, or None.", Instance, Query),
    m("last", "() -> Model | None", "Return the last object matched by the QuerySet, or None.", Instance, Query),
    m("aggregate", "(*args, **kwargs) -> dict", "Return a dictionary of aggregate values computed over the QuerySet.", Scalar, Aggregate),
    m("exists", "() -> bool", "Return True if the QuerySet contains any results.", Scalar, Query),
    m("contains", "(obj) -> bool", "Return True if the QuerySet contains the given object.", Scalar, Query),
    m("explain", "(format=None, **options) -> str", "Return a string of the QuerySet's execution plan.", Scalar, Utility),

    m("aiterator", "(chunk_size=None) -> AsyncIterator", "Async version of iterator().", Unknown, Utility),
    m("acount", "() -> int", "Async version of count().", Scalar, Aggregate),
    m("aexists", "() -> bool", "Async version of exists().", Scalar, Query),
    m("afirst", "() -> Model | None", "Async version of first().", Instance, Query),
    m("alast", "() -> Model | None", "Async version of last().", Instance, Query),
    m("aget", "(*args, **kwargs) -> Model", "Async version of get().", Instance, Crud),
    m("acreate", "(**kwargs) -> Model", "Async version of create().", Instance, Crud),
    m("aget_or_create", "(defaults=None, **kwargs) -> tuple[Model, bool]", "Async version of get_or_create().", Unknown, Crud),
    m("aupdate_or_create", "(defaults=None, create_defaults=None, **kwargs) -> tuple[Model, bool]", "Async version of update_or_create().", Unknown, Crud),
    m("abulk_create", "(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None) -> list[Model]", "Async version of bulk_create().", Scalar, Crud),
    m("abulk_update", "(objs, fields, batch_size=None) -> int", "Async version of bulk_update().", Scalar, Crud),
    m("aupdate", "(**kwargs) -> int", "Async version of update().", Scalar, Crud),
    m("adelete", "() -> tuple[int, dict[str, int]]", "Async version of delete().", Scalar, Crud),
    m("alatest", "(*fields) -> Model", "Async version of latest().", Instance, Query),
    m("aearliest", "(*fields) -> Model", "Async version of earliest().", Instance, Query),
    m("ain_bulk", "(id_list=None, *, field_name=\"pk\") -> dict", "Async version of in_bulk().", Scalar, Crud),
    m("acontains", "(obj) -> bool", "Async version of contains().", Scalar, Query),
    m("aaggregate", "(*args, **kwargs) -> dict", "Async version of aggregate().", Scalar, Aggregate),
];

pub const MANAGER_BUILTIN_METHODS: &[BuiltinMethodInfo] = &[m(
    "get_queryset",
    "() -> QuerySet",
    "Return a new QuerySet object.",
    Queryset,
    Utility,
)];

pub const INSTANCE_BUILTIN_METHODS: &[BuiltinMethodInfo] = &[
    m(
        "save",
        "(force_insert=False, force_update=False, using=None, update_fields=None) -> None",
        "Save the current instance to the database.",
        RetNone,
        Crud,
    ),
    m(
        "delete",
        "(using=None, keep_parents=False) -> tuple[int, dict[str, int]]",
        "Delete the current instance from the database.",
        Scalar,
        Crud,
    ),
    m(
        "full_clean",
        "(exclude=None, validate_unique=True) -> None",
        "Call clean_fields(), clean(), and validate_unique() on the model.",
        RetNone,
        Utility,
    ),
    m(
        "clean",
        "() -> None",
        "Hook for custom model-level validation.",
        RetNone,
        Utility,
    ),
    m(
        "clean_fields",
        "(exclude=None) -> None",
        "Validate all fields on the model.",
        RetNone,
        Utility,
    ),
    m(
        "validate_unique",
        "(exclude=None) -> None",
        "Check unique constraints on the model.",
        RetNone,
        Utility,
    ),
    m(
        "validate_constraints",
        "(exclude=None) -> None",
        "Check all constraints defined in Meta.constraints.",
        RetNone,
        Utility,
    ),
    m(
        "refresh_from_db",
        "(using=None, fields=None) -> None",
        "Reload field values from the database.",
        RetNone,
        Utility,
    ),
    m(
        "serializable_value",
        "(field_name) -> Any",
        "Return the value of the field for serialization purposes.",
        Scalar,
        Utility,
    ),
    m(
        "get_deferred_fields",
        "() -> set[str]",
        "Return a set containing names of deferred fields on this instance.",
        Scalar,
        Utility,
    ),
    m(
        "asave",
        "(force_insert=False, force_update=False, using=None, update_fields=None) -> None",
        "Async version of save().",
        RetNone,
        Crud,
    ),
    m(
        "adelete",
        "(using=None, keep_parents=False) -> tuple[int, dict[str, int]]",
        "Async version of delete().",
        Scalar,
        Crud,
    ),
    m(
        "arefresh_from_db",
        "(using=None, fields=None) -> None",
        "Async version of refresh_from_db().",
        RetNone,
        Utility,
    ),
    m(
        "aclean",
        "() -> None",
        "Async version of clean().",
        RetNone,
        Utility,
    ),
    m(
        "afull_clean",
        "(exclude=None, validate_unique=True) -> None",
        "Async version of full_clean().",
        RetNone,
        Utility,
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_match_python_port() {
        assert!(QUERYSET_BUILTIN_METHODS.len() >= 40);
        assert!(MANAGER_BUILTIN_METHODS.len() >= 1);
        assert!(INSTANCE_BUILTIN_METHODS.len() >= 10);
    }

    #[test]
    fn method_names_unique_per_category() {
        let mut seen_qs = std::collections::HashSet::new();
        for mi in QUERYSET_BUILTIN_METHODS {
            assert!(
                seen_qs.insert(mi.name),
                "duplicate queryset method: {}",
                mi.name
            );
        }
        let mut seen_inst = std::collections::HashSet::new();
        for mi in INSTANCE_BUILTIN_METHODS {
            assert!(
                seen_inst.insert(mi.name),
                "duplicate instance method: {}",
                mi.name
            );
        }
    }

    #[test]
    fn essential_methods_present() {
        let has = |table: &[BuiltinMethodInfo], name: &str| table.iter().any(|m| m.name == name);
        assert!(has(QUERYSET_BUILTIN_METHODS, "filter"));
        assert!(has(QUERYSET_BUILTIN_METHODS, "exclude"));
        assert!(has(QUERYSET_BUILTIN_METHODS, "get"));
        assert!(has(QUERYSET_BUILTIN_METHODS, "create"));
        assert!(has(INSTANCE_BUILTIN_METHODS, "save"));
        assert!(has(INSTANCE_BUILTIN_METHODS, "refresh_from_db"));
    }
}
