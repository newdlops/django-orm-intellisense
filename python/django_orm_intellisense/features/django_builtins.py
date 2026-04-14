"""Static knowledge base of Django built-in methods for QuerySet, Manager, and Model."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BuiltinMethodInfo:
    name: str
    signature: str
    description: str
    return_kind: str  # queryset | instance | scalar | none | bool | unknown
    category: str  # query | crud | aggregate | utility


# ---------------------------------------------------------------------------
# QuerySet methods
# ---------------------------------------------------------------------------

QUERYSET_BUILTIN_METHODS: dict[str, BuiltinMethodInfo] = {m.name: m for m in [
    BuiltinMethodInfo('all', '() -> QuerySet', 'Return a copy of the current QuerySet.', 'queryset', 'query'),
    BuiltinMethodInfo('alias', '(**kwargs) -> QuerySet', 'Same as annotate(), but instead of annotating objects in the QuerySet, save the expression for later reuse with other QuerySet methods.', 'queryset', 'query'),
    BuiltinMethodInfo('annotate', '(*args, **kwargs) -> QuerySet', 'Annotate each object in the QuerySet with the provided expressions.', 'queryset', 'query'),
    BuiltinMethodInfo('filter', '(*args, **kwargs) -> QuerySet', 'Return a new QuerySet containing objects that match the given lookup parameters.', 'queryset', 'query'),
    BuiltinMethodInfo('exclude', '(*args, **kwargs) -> QuerySet', 'Return a new QuerySet containing objects that do NOT match the given lookup parameters.', 'queryset', 'query'),
    BuiltinMethodInfo('order_by', '(*fields) -> QuerySet', 'Order the QuerySet by the given fields.', 'queryset', 'query'),
    BuiltinMethodInfo('reverse', '() -> QuerySet', 'Reverse the order in which elements are returned.', 'queryset', 'query'),
    BuiltinMethodInfo('distinct', '(*fields) -> QuerySet', 'Return a new QuerySet with SELECT DISTINCT.', 'queryset', 'query'),
    BuiltinMethodInfo('values', '(*fields, **expressions) -> QuerySet', 'Return a QuerySet of dictionaries instead of model instances.', 'unknown', 'query'),
    BuiltinMethodInfo('values_list', '(*fields, flat=False, named=False) -> QuerySet', 'Return a QuerySet of tuples (or flat values) instead of model instances.', 'unknown', 'query'),
    BuiltinMethodInfo('dates', '(field, kind, order="ASC") -> QuerySet', 'Return a QuerySet of datetime.date objects representing available dates.', 'unknown', 'query'),
    BuiltinMethodInfo('datetimes', '(field_name, kind, order="ASC", tzinfo=None) -> QuerySet', 'Return a QuerySet of datetime.datetime objects representing available datetimes.', 'unknown', 'query'),
    BuiltinMethodInfo('none', '() -> QuerySet', 'Return an empty QuerySet.', 'queryset', 'query'),
    BuiltinMethodInfo('union', '(*other_qs, all=False) -> QuerySet', 'Use SQL UNION to combine two or more QuerySets.', 'queryset', 'query'),
    BuiltinMethodInfo('intersection', '(*other_qs) -> QuerySet', 'Use SQL INTERSECT to return shared elements of two or more QuerySets.', 'queryset', 'query'),
    BuiltinMethodInfo('difference', '(*other_qs) -> QuerySet', 'Use SQL EXCEPT to keep only elements in this QuerySet but not in the others.', 'queryset', 'query'),
    BuiltinMethodInfo('select_related', '(*fields) -> QuerySet', 'Return a QuerySet that follows foreign-key relationships, selecting additional related-object data.', 'queryset', 'query'),
    BuiltinMethodInfo('prefetch_related', '(*lookups) -> QuerySet', 'Return a QuerySet that prefetches related objects in a separate query.', 'queryset', 'query'),
    BuiltinMethodInfo('extra', '(select=None, where=None, params=None, tables=None, order_by=None, select_params=None) -> QuerySet', 'Add extra SQL to the query. Deprecated in favor of annotate/filter.', 'queryset', 'query'),
    BuiltinMethodInfo('defer', '(*fields) -> QuerySet', 'Defer loading of specified fields until accessed.', 'queryset', 'query'),
    BuiltinMethodInfo('only', '(*fields) -> QuerySet', 'Load only the specified fields immediately.', 'queryset', 'query'),
    BuiltinMethodInfo('using', '(alias) -> QuerySet', 'Select which database this QuerySet will use.', 'queryset', 'query'),
    BuiltinMethodInfo('select_for_update', '(nowait=False, skip_locked=False, of=(), no_key=False) -> QuerySet', 'Return a QuerySet with SELECT ... FOR UPDATE.', 'queryset', 'query'),
    BuiltinMethodInfo('raw', '(raw_query, params=(), translations=None, using=None) -> RawQuerySet', 'Execute a raw SQL query.', 'unknown', 'query'),

    # Methods that evaluate the QuerySet
    BuiltinMethodInfo('get', '(*args, **kwargs) -> Model', 'Return a single object matching the given lookup parameters.', 'instance', 'crud'),
    BuiltinMethodInfo('create', '(**kwargs) -> Model', 'Create a new object, save it, and return it.', 'instance', 'crud'),
    BuiltinMethodInfo('get_or_create', '(defaults=None, **kwargs) -> tuple[Model, bool]', 'Look up an object, creating one if necessary. Returns a tuple of (object, created).', 'unknown', 'crud'),
    BuiltinMethodInfo('update_or_create', '(defaults=None, create_defaults=None, **kwargs) -> tuple[Model, bool]', 'Update an object, creating one if necessary. Returns a tuple of (object, created).', 'unknown', 'crud'),
    BuiltinMethodInfo('bulk_create', '(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None) -> list[Model]', 'Insert the provided list of objects into the database in an efficient manner.', 'scalar', 'crud'),
    BuiltinMethodInfo('bulk_update', '(objs, fields, batch_size=None) -> int', 'Update the given fields on the provided model instances in an efficient manner.', 'scalar', 'crud'),
    BuiltinMethodInfo('update', '(**kwargs) -> int', 'Update all elements in the current QuerySet with the given parameters.', 'scalar', 'crud'),
    BuiltinMethodInfo('delete', '() -> tuple[int, dict[str, int]]', 'Delete all objects in this QuerySet.', 'scalar', 'crud'),

    BuiltinMethodInfo('count', '() -> int', 'Return the number of objects in the QuerySet.', 'scalar', 'aggregate'),
    BuiltinMethodInfo('in_bulk', '(id_list=None, *, field_name="pk") -> dict', 'Return a dictionary mapping each of the given IDs to the object with that ID.', 'scalar', 'crud'),
    BuiltinMethodInfo('iterator', '(chunk_size=None) -> Iterator', 'Evaluate the QuerySet and return an iterator over the results.', 'unknown', 'utility'),
    BuiltinMethodInfo('latest', '(*fields) -> Model', 'Return the latest object in the table using the provided field(s) for ordering.', 'instance', 'query'),
    BuiltinMethodInfo('earliest', '(*fields) -> Model', 'Return the earliest object in the table using the provided field(s) for ordering.', 'instance', 'query'),
    BuiltinMethodInfo('first', '() -> Model | None', 'Return the first object matched by the QuerySet, or None.', 'instance', 'query'),
    BuiltinMethodInfo('last', '() -> Model | None', 'Return the last object matched by the QuerySet, or None.', 'instance', 'query'),
    BuiltinMethodInfo('aggregate', '(*args, **kwargs) -> dict', 'Return a dictionary of aggregate values computed over the QuerySet.', 'scalar', 'aggregate'),
    BuiltinMethodInfo('exists', '() -> bool', 'Return True if the QuerySet contains any results.', 'scalar', 'query'),
    BuiltinMethodInfo('contains', '(obj) -> bool', 'Return True if the QuerySet contains the given object.', 'scalar', 'query'),
    BuiltinMethodInfo('explain', '(format=None, **options) -> str', 'Return a string of the QuerySet\'s execution plan.', 'scalar', 'utility'),

    # Async variants
    BuiltinMethodInfo('aiterator', '(chunk_size=None) -> AsyncIterator', 'Async version of iterator().', 'unknown', 'utility'),
    BuiltinMethodInfo('acount', '() -> int', 'Async version of count().', 'scalar', 'aggregate'),
    BuiltinMethodInfo('aexists', '() -> bool', 'Async version of exists().', 'scalar', 'query'),
    BuiltinMethodInfo('afirst', '() -> Model | None', 'Async version of first().', 'instance', 'query'),
    BuiltinMethodInfo('alast', '() -> Model | None', 'Async version of last().', 'instance', 'query'),
    BuiltinMethodInfo('aget', '(*args, **kwargs) -> Model', 'Async version of get().', 'instance', 'crud'),
    BuiltinMethodInfo('acreate', '(**kwargs) -> Model', 'Async version of create().', 'instance', 'crud'),
    BuiltinMethodInfo('aget_or_create', '(defaults=None, **kwargs) -> tuple[Model, bool]', 'Async version of get_or_create().', 'unknown', 'crud'),
    BuiltinMethodInfo('aupdate_or_create', '(defaults=None, create_defaults=None, **kwargs) -> tuple[Model, bool]', 'Async version of update_or_create().', 'unknown', 'crud'),
    BuiltinMethodInfo('abulk_create', '(objs, batch_size=None, ignore_conflicts=False, update_conflicts=False, update_fields=None, unique_fields=None) -> list[Model]', 'Async version of bulk_create().', 'scalar', 'crud'),
    BuiltinMethodInfo('abulk_update', '(objs, fields, batch_size=None) -> int', 'Async version of bulk_update().', 'scalar', 'crud'),
    BuiltinMethodInfo('aupdate', '(**kwargs) -> int', 'Async version of update().', 'scalar', 'crud'),
    BuiltinMethodInfo('adelete', '() -> tuple[int, dict[str, int]]', 'Async version of delete().', 'scalar', 'crud'),
    BuiltinMethodInfo('alatest', '(*fields) -> Model', 'Async version of latest().', 'instance', 'query'),
    BuiltinMethodInfo('aearliest', '(*fields) -> Model', 'Async version of earliest().', 'instance', 'query'),
    BuiltinMethodInfo('ain_bulk', '(id_list=None, *, field_name="pk") -> dict', 'Async version of in_bulk().', 'scalar', 'crud'),
    BuiltinMethodInfo('acontains', '(obj) -> bool', 'Async version of contains().', 'scalar', 'query'),
    BuiltinMethodInfo('aaggregate', '(*args, **kwargs) -> dict', 'Async version of aggregate().', 'scalar', 'aggregate'),
]}


# ---------------------------------------------------------------------------
# Manager-only methods (in addition to all QuerySet methods)
# ---------------------------------------------------------------------------

MANAGER_BUILTIN_METHODS: dict[str, BuiltinMethodInfo] = {m.name: m for m in [
    BuiltinMethodInfo('get_queryset', '() -> QuerySet', 'Return a new QuerySet object.', 'queryset', 'utility'),
]}


# ---------------------------------------------------------------------------
# Model instance methods
# ---------------------------------------------------------------------------

INSTANCE_BUILTIN_METHODS: dict[str, BuiltinMethodInfo] = {m.name: m for m in [
    BuiltinMethodInfo('save', '(force_insert=False, force_update=False, using=None, update_fields=None) -> None', 'Save the current instance to the database.', 'none', 'crud'),
    BuiltinMethodInfo('delete', '(using=None, keep_parents=False) -> tuple[int, dict[str, int]]', 'Delete the current instance from the database.', 'scalar', 'crud'),
    BuiltinMethodInfo('full_clean', '(exclude=None, validate_unique=True) -> None', 'Call clean_fields(), clean(), and validate_unique() on the model.', 'none', 'utility'),
    BuiltinMethodInfo('clean', '() -> None', 'Hook for custom model-level validation.', 'none', 'utility'),
    BuiltinMethodInfo('clean_fields', '(exclude=None) -> None', 'Validate all fields on the model.', 'none', 'utility'),
    BuiltinMethodInfo('validate_unique', '(exclude=None) -> None', 'Check unique constraints on the model.', 'none', 'utility'),
    BuiltinMethodInfo('validate_constraints', '(exclude=None) -> None', 'Check all constraints defined in Meta.constraints.', 'none', 'utility'),
    BuiltinMethodInfo('refresh_from_db', '(using=None, fields=None) -> None', 'Reload field values from the database.', 'none', 'utility'),
    BuiltinMethodInfo('serializable_value', '(field_name) -> Any', 'Return the value of the field for serialization purposes.', 'scalar', 'utility'),
    BuiltinMethodInfo('get_deferred_fields', '() -> set[str]', 'Return a set containing names of deferred fields on this instance.', 'scalar', 'utility'),
    # Async variants
    BuiltinMethodInfo('asave', '(force_insert=False, force_update=False, using=None, update_fields=None) -> None', 'Async version of save().', 'none', 'crud'),
    BuiltinMethodInfo('adelete', '(using=None, keep_parents=False) -> tuple[int, dict[str, int]]', 'Async version of delete().', 'scalar', 'crud'),
    BuiltinMethodInfo('arefresh_from_db', '(using=None, fields=None) -> None', 'Async version of refresh_from_db().', 'none', 'utility'),
    BuiltinMethodInfo('aclean', '() -> None', 'Async version of clean().', 'none', 'utility'),
    BuiltinMethodInfo('afull_clean', '(exclude=None, validate_unique=True) -> None', 'Async version of full_clean().', 'none', 'utility'),
]}
