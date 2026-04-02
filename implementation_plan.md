# Django ORM Intellisense Implementation Plan

## 1. Objective

Build a VS Code extension that provides framework-aware Django ORM intelligence by understanding the real project, not only hand-written stubs.

The target is not "good enough autocomplete." The target is:

- accurate field and relation intelligence for real Django models
- understanding of dynamically generated ORM surfaces
- first-class handling of string-based model and module references
- useful completions, hovers, definitions, references, diagnostics, and code actions
- graceful fallback when runtime inspection is unavailable

Current repository status: this repo is still a VS Code extension scaffold, so the plan assumes a greenfield architecture.

## 2. What "Done" Means

The extension should eventually support the following cases as normal editor behavior:

- completing concrete fields, inherited fields, reverse relations, and custom managers on model instances
- completing lookup paths inside ORM calls such as `filter(author__profile__email=...)`
- understanding `QuerySet` chains and preserving model context across chained calls
- understanding `annotate`, `alias`, `values`, `values_list`, `select_related`, `prefetch_related`, `only`, and `defer`
- resolving Django relation strings such as `"app_label.ModelName"` and `"self"`
- resolving framework string references such as dotted module or class paths where Django expects them
- resolving symbols re-exported through package `__init__.py`, including `from x import *` chains where feasible
- navigating from a string reference to the real symbol definition
- showing the real origin module for re-exported imports in hover, completion detail, and definition flows
- showing diagnostics for unresolved fields, invalid lookup paths, and broken string references
- continuing to provide partial intelligence from static analysis even if `django.setup()` cannot be completed

## 3. Core Product Principles

### 3.1 Semantic graph over stubs

Stubs can help compatibility, but they cannot be the source of truth. Django ORM behavior is created by metaclasses, descriptors, app registry state, manager factories, and runtime configuration. The extension must build and query its own semantic graph.

### 3.2 Hybrid static and runtime analysis

Static analysis alone cannot fully recover Django ORM behavior. Runtime inspection alone cannot see unsaved edits and often loses source intent. We need both:

- static analysis for source graph, unsaved buffers, and call-site context
- runtime inspection for actual Django model metadata and framework-generated surfaces

### 3.3 Project-specific understanding

The extension must inspect the user's selected interpreter, Django settings, installed apps, and project source. Generic library-level assumptions are not enough.

### 3.4 Safe and incremental execution

Runtime inspection must happen in a separate subprocess with timeouts, caching, and clear degraded-mode behavior. We should never depend on arbitrary database queries or unsafe management command execution.

### 3.5 Focus on ORM semantics first

We do not need a full Python type checker before delivering value. We need excellent Django ORM understanding first, then broader framework patterns around it.

## 4. Recommended Architecture

Use a hybrid architecture with a TypeScript VS Code client and a Python analysis daemon.

### 4.1 VS Code client responsibilities

- activation and workspace setup
- interpreter and settings selection UX
- document synchronization
- completion, hover, definition, references, diagnostics, and code action wiring
- status, logging, commands, and configuration UI
- process lifecycle management for the Python analysis daemon

### 4.2 Python analysis daemon responsibilities

- project discovery
- static Python source indexing
- Django runtime inspection
- semantic graph construction and caching
- ORM query analysis
- string reference resolution
- feature responses over JSON-RPC or LSP-compatible transport

### 4.3 Why the analysis engine should be Python, not TypeScript

The authoritative ORM behavior lives in Python and Django internals. Reimplementing Django model semantics in TypeScript would be slower, less accurate, and harder to maintain. A Python daemon can:

- use Python AST tooling directly
- inspect Django internals with the workspace interpreter
- understand project imports and model metadata without translation layers

### 4.4 Optional compatibility layer

We may later generate temporary overlay stubs for compatibility with other Python tooling, but these should be a byproduct of the semantic graph, not the primary implementation strategy.

## 5. Proposed Repository Shape

Restructure the repo early so the client and analysis engine can evolve independently.

```text
src/
  client/
    extension.ts
    lspClient.ts
    commands/
    config/
    diagnostics/
python/
  django_orm_intellisense/
    __main__.py
    server/
    discovery/
    static_index/
    runtime/
    semantic/
    features/
fixtures/
  minimal_project/
  relations_project/
  advanced_queries_project/
tests/
  integration/
  snapshots/
docs/
```

## 6. Canonical Semantic Graph

The semantic graph is the core abstraction. Every feature should read from it.

### 6.1 Primary node types

- workspace
- Python environment
- Django project
- app
- module
- export surface
- class
- model
- field
- relation
- manager
- queryset
- annotation
- string reference
- import alias
- function or call-site pattern

### 6.2 Important edges

- model -> field
- model -> reverse relation
- field -> related model
- module -> exported symbol
- exported symbol -> origin module
- manager -> queryset
- queryset -> result model
- string reference -> resolved symbol
- source location -> semantic node
- unsaved document overlay -> existing semantic node

### 6.3 Merge policy

When static and runtime information disagree:

- prefer runtime facts for actual model metadata
- prefer static facts for unsaved buffers and in-flight edits
- keep provenance so the UI can explain why a result is partial or uncertain

## 7. Analysis Pipelines

### 7.1 Project discovery

We need a reliable way to discover:

- workspace root
- Python interpreter
- virtual environment
- `manage.py`, `pyproject.toml`, `settings.py`, or explicit settings module
- installed apps and Django project entry points

Deliverables:

- interpreter selection command
- settings module override support
- project health diagnostics when setup is ambiguous

### 7.2 Static source indexer

The static indexer should parse Python source and build a fast symbol graph without executing user code.

It should collect:

- imports and aliases
- package re-exports and `__all__`
- star import provenance where statically recoverable
- class definitions
- model subclasses
- manager and queryset subclasses
- assignments and local symbol bindings relevant to ORM inference
- known call sites that accept string references
- string literal candidates and their context

Requirements:

- support incremental updates for open editors
- support unsaved buffer overlays
- avoid full-project reindex on every file change
- preserve origin information so editor features can show where a re-exported symbol actually comes from

### 7.3 Runtime Django inspector

The runtime inspector should run in a subprocess using the selected workspace interpreter.

It should:

- set the discovered `DJANGO_SETTINGS_MODULE`
- set an analysis marker such as `DJANGO_ORM_INTELLISENSE=1`
- call `django.setup()`
- inspect `apps.get_models()` and model `_meta`
- collect fields, reverse relations, managers, bases, swappable models, and related accessors
- collect enough metadata to understand actual ORM-generated members without touching user data

Safety requirements:

- hard timeout
- subprocess isolation
- no management commands
- no ORM queries
- explicit degraded mode when startup fails

### 7.4 Semantic merge engine

The merge engine should produce one canonical graph from:

- static source facts
- runtime Django metadata
- active editor overlays

This layer should assign stable IDs so features, caches, and snapshots remain comparable across runs.

### 7.5 ORM query analyzer

This is the part that turns the model graph into actual editor intelligence.

The analyzer must infer:

- the base model behind a manager or queryset expression
- how query chains transform result shape
- lookup path validity across relations
- annotation names and their approximate types
- how `values` and `values_list` change the output contract
- whether a cursor is inside a model field access, a queryset method chain, or a string-based lookup

Initial scope:

- `filter`, `exclude`, `get`
- `order_by`
- `values`, `values_list`
- `annotate`, `alias`, `aggregate`
- `select_related`, `prefetch_related`
- `only`, `defer`
- `create`, `update`, `bulk_create`

Next scope:

- `Q`, `F`, `Case`, `When`
- `Subquery`, `OuterRef`, `Exists`
- `Prefetch`
- custom queryset methods

### 7.6 String reference resolver

String references need their own subsystem rather than ad hoc special cases.

The resolver should use a registry of known Django patterns, including:

- relation targets like `ForeignKey("app.Model")`
- self references like `"self"`
- project-level settings like `AUTH_USER_MODEL`
- APIs such as `apps.get_model(...)`
- dotted module or class paths used by framework configuration

Capabilities:

- completion inside recognized string literals
- go to definition from string
- find references to the resolved symbol
- diagnostics for unresolved or ambiguous strings
- rename support only where we can guarantee safety

### 7.7 Import and re-export resolver

Import resolution also needs a first-class subsystem because Django projects often flatten APIs through package `__init__.py` files.

The resolver should understand:

- direct re-exports such as `from .models import Foo`
- package surfaces defined by `__all__`
- `from .submodule import *` when the exported surface is statically recoverable
- chained re-exports across multiple package levels

Capabilities:

- show the origin module path for a symbol imported from a package surface
- go to definition through re-export layers
- show completion detail such as "re-exported from package, defined in module X"
- diagnose ambiguous or non-recoverable star export cases instead of pretending they are precise

## 8. Feature Roadmap

### Phase 0. Foundation

- split the repo into client and Python engine areas
- create JSON-RPC or LSP transport between extension and daemon
- add logging, tracing, and debug commands
- create fixture Django projects for testing

Exit criteria:

- extension launches daemon successfully
- fixture workspace can be analyzed end to end

### Phase 1. Discovery and bootstrap

- detect interpreter and settings
- implement health checks and setup diagnostics
- build cache keys from workspace, interpreter, and settings fingerprints

Exit criteria:

- the extension can reliably find a Django project or explain why it cannot

### Phase 2. Static model and symbol indexing

- parse models, managers, querysets, and relevant imports
- track string-reference call sites
- index package export surfaces and recover `__init__.py` re-export chains
- support incremental updates from changed files

Exit criteria:

- static graph can answer basic symbol, re-export origin, and string-reference queries without runtime help

### Phase 3. Runtime ORM graph

- introspect actual models and runtime-generated members
- capture relations, reverse accessors, manager wiring, and swappable model info
- merge runtime data into the canonical graph

Exit criteria:

- field and relation completion works on standard models in fixture projects

### Phase 4. Core language features

- field completion on model instances
- manager and queryset completion
- hover and go-to-definition for models and fields
- hover and definition should show origin modules for symbols re-exported via package `__init__.py`
- diagnostics for obviously broken field usage

Exit criteria:

- the extension is already useful for everyday CRUD-style Django code

### Phase 5. Query semantics

- analyze queryset chains
- autocomplete lookup paths in `filter(...)` style calls
- support annotations and output-shape transforms
- validate relation traversal and lookup suffixes

Exit criteria:

- users can author non-trivial ORM queries with reliable editor guidance

### Phase 6. String reference intelligence

- resolve relation strings and dotted framework references
- provide completion, definition, references, and diagnostics inside strings
- add safe rename support where feasible

Exit criteria:

- string-based references are treated as first-class symbols, not plain text

### Phase 7. Hard Django cases

- abstract base models
- proxy models
- multi-table inheritance
- swapped models
- custom fields and descriptors
- `Manager.from_queryset(...)` and `as_manager()`
- advanced expressions and subqueries

Exit criteria:

- the extension handles the dynamic parts of Django that usually break stub-only tooling

### Phase 8. Stabilization and release

- performance tuning
- error recovery and degraded mode polish
- documentation and settings UX
- packaging and release pipeline

Exit criteria:

- stable marketplace-ready extension with reproducible integration coverage

## 9. Testing Strategy

We need tests at several layers because correctness failures will be subtle.

### 9.1 Fixture projects

Create dedicated Django fixture workspaces that cover:

- simple models
- cross-app relations
- abstract and inherited models
- package APIs flattened through `__init__.py`
- star re-export cases with and without explicit `__all__`
- custom managers and querysets
- annotations and advanced query expressions
- swapped auth model usage
- string-based model and module references
- intentional setup failures for degraded-mode testing

### 9.2 Test layers

- unit tests for VS Code client behavior
- unit tests for static indexer and semantic graph construction
- unit tests for runtime inspector serialization
- snapshot tests for semantic graph output
- cursor-based feature tests for completion, hover, definition, and diagnostics
- end-to-end extension tests against fixture workspaces

### 9.3 Golden scenarios

Maintain a set of representative source files with marked cursor positions and expected outcomes:

- completion items
- resolved definition target
- hover text
- diagnostics
- query path inference results

This will be more valuable than generic smoke tests.

## 10. Performance and Reliability Targets

Exact budgets can be tuned after the first prototype, but the plan should assume:

- cached completion responses should usually return within interactive editor latency
- single-file edits should not trigger full-project recomputation
- runtime inspection results should be cached per interpreter and settings fingerprint
- failures in Django bootstrap should not disable static-only features

Operational requirements:

- structured logs
- explainable health state in the UI
- manual restart command for the daemon
- deterministic cache invalidation

## 11. Main Risks and Mitigations

### Risk: `django.setup()` triggers project side effects

Mitigation:

- always use a subprocess
- set a dedicated analysis environment variable
- document best practices for user projects
- keep a static-only fallback path

### Risk: unsaved editor state diverges from runtime state

Mitigation:

- treat runtime data as a base layer
- overlay unsaved AST facts before serving language features

### Risk: custom metaprogramming defeats generic inference

Mitigation:

- add an extensible registry for known framework and project patterns
- allow explicit user overrides later if required

### Risk: performance collapses on large monorepos

Mitigation:

- lazy graph materialization
- app-scoped invalidation
- cache aggressively at graph boundaries

### Risk: Django version differences create brittle behavior

Mitigation:

- encode version capabilities explicitly
- test against a supported matrix instead of assuming one behavior

## 12. Near-Term Execution Order

The first concrete implementation steps should be:

1. Restructure the repo for a client/daemon split.
2. Add at least three Django fixture projects that reflect realistic ORM complexity.
3. Implement project discovery and a runtime inspection proof of concept.
4. Build the first canonical model graph from runtime metadata.
5. Add field completion and go-to-definition as the first user-visible feature slice.
6. Expand into queryset semantics and string reference resolution after the graph is stable.

## 13. Explicit Non-Goals for the First Release

These should not block the first usable release:

- full general-purpose Python type checking
- SQL query plan analysis
- database schema introspection through live queries
- migration authoring automation
- support for every third-party Django extension on day one

They can be added later, but they should not dilute the first architecture decisions.

## 14. Summary

To achieve "complete" Django ORM intellisense, we should not begin with stubs and patch exceptions forever. We should build a framework-aware semantic system:

- TypeScript client for editor integration
- Python daemon for source and runtime understanding
- canonical semantic graph as the product core
- phased delivery that starts with real model intelligence and grows into queryset semantics and string reference resolution

This plan keeps the architecture aligned with Django's actual behavior instead of fighting it.
