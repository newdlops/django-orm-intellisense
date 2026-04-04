# Django `db.models` Support Matrix

This matrix defines the intended editor-support surface for `django.db.models`
under the Django 5.x E2E harness. The goal is not to reimplement Django, but
to support the parts of the API that materially affect completion, hover,
definition, diagnostics, and receiver/type propagation in real projects.

## Status

Legend:

- `done`: covered by the current E2E suite and intended to stay green
- `in_progress`: partially supported or only supported in a subset of contexts
- `planned`: not implemented yet, but part of the committed support scope

## Query API

| Surface | Completion | Hover | Definition | Diagnostics | Type/receiver propagation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `filter`, `exclude`, `get` keyword lookups | yes | yes | yes | yes | yes | done |
| `values`, `values_list`, `order_by` string paths | yes | yes | yes | yes | n/a | done |
| `select_related`, `prefetch_related`, `only`, `defer` string paths | yes | yes | yes | yes | queryset | done |
| `annotate` keyword aliases | yes | yes | yes | yes | yes | done |
| `alias` keyword aliases | yes | yes | yes | yes | yes | done |
| `aggregate` keyword aliases | yes | yes | yes | yes | scalar/dict | done |
| `create`, `get_or_create`, `update_or_create` | yes | yes | yes | yes | instance/tuple | done |
| `update`, `bulk_create`, `bulk_update` | yes | yes | yes | yes | scalar/list | done |

## Expression API

| Surface | Completion | Hover | Definition | Diagnostics | Receiver/type propagation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `Q` | yes | yes | yes | yes | queryset lookup | done |
| `F` | yes | yes | yes | yes | expression field path | done |
| `OuterRef` | yes | yes | yes | yes | expression field path | done |
| `Count`, `Sum`, `Avg`, `Min`, `Max` | yes | yes | yes | yes | annotation scalar | done |
| `Case`, `When` | yes | yes | yes | yes | conditional expression | done |
| `Value`, `Func`, `Cast`, `Coalesce`, `ExpressionWrapper` | yes | yes | yes | yes | expression composition | done |
| `Subquery`, `Exists` | yes | yes | yes | yes | nested query / boolean | done |

## Model / Field / Schema API

| Surface | Completion | Hover | Definition | Diagnostics | Type/receiver propagation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| model instance fields / relations | yes | yes | yes | n/a | yes | done |
| manager / queryset methods | yes | yes | yes | n/a | yes | done |
| inherited model fields | yes | yes | yes | n/a | yes | done |
| relation attname aliases | yes | yes | yes | yes | yes | done |
| field declarations (`ForeignKey`, `OneToOneField`, `ManyToManyField`) | yes | yes | yes | yes | n/a | done |
| `Meta.indexes`, `Meta.constraints` | yes | yes | yes | yes | n/a | done |
| custom manager / queryset declarations | yes | yes | yes | n/a | yes | done |

## Import / Module Resolution

| Surface | Completion | Hover | Definition | Diagnostics | Type/receiver propagation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| package re-export imports | yes | yes | yes | n/a | yes | done |
| module alias imports | yes | yes | yes | n/a | yes | done |
| package/module collision (`pkg/mod.py` + `pkg/mod/__init__.py`) | yes | yes | yes | n/a | yes | done |

## Acceptance Rules

- New `django.db.models` support must land with Django 5.x E2E coverage.
- A feature is only `done` when it is verified in completion and at least one of
  hover/definition/diagnostics, depending on the surface.
- Real-workspace collision patterns take precedence over synthetic fixtures.
