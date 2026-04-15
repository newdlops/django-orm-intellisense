# Changelog

## 0.1.0 — 2026-04-15

First public release.

### ORM Lookup Paths
- Autocomplete for keyword arguments in `filter()`, `exclude()`, `get()`, `order_by()`, and other queryset methods
- Foreign key chain traversal with depth-aware dynamic limits
- Reverse relation and `related_query_name` lookup support
- Lookup operator suggestions (`__icontains`, `__gte`, `__isnull`, etc.)
- Diagnostic warnings for invalid ORM lookup paths

### String Path Intelligence
- Completion, hover, and go-to-definition for `values()`, `values_list()`, `select_related()`, `prefetch_related()`, `only()`, `defer()` string arguments
- Relation-string resolution for `ForeignKey`, `OneToOneField`, `ManyToManyField` declarations

### Receiver Inference
- Base model inference for local queryset variables
- Helper function, `self`, `cls`, `super()` return type resolution
- Loop and comprehension target inference from querysets and typed collections
- Custom manager and queryset method chain tracking

### Expression Support
- `Q()`, `F()`, `When()`, `Case()` expression field paths
- `annotate()` / `alias()` member propagation to downstream lookups
- `Subquery`, `OuterRef`, aggregate and window expression field paths
- `Meta` index and constraint field contexts
- Multiline parenthesized expression handling

### Import Resolution
- Package `__init__.py` re-export resolution with hover and go-to-definition
- Relative and multiline import support
- Module import hover and definition

### Django Integration
- Hover for Django builtin instance and queryset methods (`.save()`, `.delete()`, `.filter()`, etc.)
- Django class and manager/queryset hover with inheritance display
- Type hint hover for Django and general Python types
- Pylance false positive suppression for dynamic ORM attributes
- `django-stubs` path exclusion from Pylance analysis

### Infrastructure
- Split architecture: TypeScript VS Code client + Python analysis daemon
- Hybrid static + runtime analysis (static indexing with runtime `django.setup()` enrichment)
- Cached source snapshots and static indexes for fast restarts
- File watcher for workspace root reindexing
- Background process pool with thread fallback
- Async chunked diagnostic scanning with time budgets
- 67 E2E tests covering completion, hover, definition, and diagnostics

## 0.0.1

- Initial VS Code extension scaffold.
