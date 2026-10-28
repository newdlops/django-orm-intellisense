# Changelog

## 0.2.2030 — 2026-10-28

- Analyze every concrete Django settings registry even when several settings
  share one project root. A declared or explicit default prioritizes collection
  without excluding the other services. Follow inherited settings statically
  and keep unrelated non-Django settings out of registry collection.
- Combine models, reverse relations, custom members and lookup descriptors;
  deduplicate common source models and distinguish identical Django labels
  owned by different sources. Refresh all dependent settings after a save.
- Share parsed source modules and equal immutable member records. Run registry
  collectors serially, verify source identity before reusing a static seed,
  and report each settings module's ready, pending or failed state in status.
- Keep ready model metadata when an optional manager's `get_queryset()` fails
  during member inspection, falling back to its declared QuerySet class.
- Allow a serial registry collector up to 60 seconds above 10,000 source files;
  retain the 30-second bound for smaller workspaces and immediate cancellation.
- Publish complete child snapshots atomically and reap owned collectors even
  when project imports start unrelated background threads. Normalize document
  source aliases before selecting a project.
- Select the Python environment automatically from VS Code's public Python
  selection API, its default interpreter setting, or a project virtualenv.
  Explicit extension settings and legacy overrides retain precedence.
- Follow initial Python readiness and environment changes, including recovery
  after a failed fallback start. Keep unopened analysis lazy, coalesce overlapping
  changes, and discard reconciliation after a stop or session replacement.
- Resolve interpreters using the requesting file's workspace instead of another
  active editor or the first workspace folder. Preserve virtualenv executable paths.
- Retain a matching project virtualenv when the public selection reports its
  resolved base executable, so project-installed dependencies remain visible.
  Explicitly selected external virtualenvs keep their own package scope.
- Check Python 3.10 compatibility before importing the daemon, with a shared
  result that invalidates when the executable or version pins change. Report the
  incompatible version directly instead of repeatedly crashing on module imports.
- Show automatically selected interpreters in status and reserve the manual
  interpreter recommendation for unresolved fallback selection.
- Exclude local logs and emitted benchmark helpers from the extension package.

## 0.2.2029 — 2026-10-27

- Discover settings across a repository, including independent nested Django
  projects, WSGI/ASGI declarations and declared `src` layouts. Use the containing
  VS Code workspace folder as the default analysis root.
- Analyze each project's registry independently and expose all apps/models
  together. Keep duplicate model names, custom members and lookup descriptors
  separate, and route editor requests using their source document.
- Collect registries serially in owned short-lived children. Preserve other
  projects when one settings module fails, reconcile new settings directories,
  and refresh saved fields without configuring Django in the parent process.
- Validation: 131 relevant Python checks passed on each of Django 5 and 6,
  plus 17 client/native/LSP check programs. A real VS Code 1.143.1 host with
  Python and Pylance passed eight editor actions for each of two Django 6
  projects, including project-specific diagnostics and saved-field refresh.
  Model descriptions in hover retain their original Django labels.
- Multi-project metadata remains in the current session rather than using
  the single-project startup cache. Each project uses the selected Python
  interpreter, which must contain its dependencies.

## 0.2.2028 — 2026-10-27

- Release the validated workspace, provider, cache and process-lifecycle
  improvements, including the single-pass member surface construction.
- Keep pending hover/signature requests alive during provider promotion and
  wait within the existing request budget for owned native source preparation.
- Track native daemon, worker and resource-tracker ownership through startup,
  cancellation, restart and parent termination. Keep source watchers owned by
  the active workspace and process session.
- Reuse a confirmed full initialization snapshot and overlap the existing
  idle delay with owned runtime warm-up to avoid an additional complete wait.
- Validation: 3,796 backend checks passed across Django 5/6 configurations,
  with 36 historical skips, plus 104 RPC checks in eight native lifecycles.
  Cached startup around 555–557ms and full cold readiness around 3.91–3.92s
  are observations, not guarantees; the 500ms/3s targets remain unmet.
  The latest source revision has not repeated the full VS Code/IR suite.
  A later experimental checked-code cache was excluded from this release.

- Verify current Python source membership and file identity before restoring
  cached initialization metadata. Detect same-size edits with restored mtimes
  and atomic replacements through change time, device and inode fingerprints.
  Reuse verified static caches without loading a second source snapshot;
  preserve path order and build directory parent edges once per directory.
- Wait for language-server confirmation that source updates were applied.
  Recover failed delta or snapshot delivery from the latest complete state,
  coalesce retries with bounded backoff, and resync after a server restart.
  Force a full rebuild after an interrupted incremental application.
- Avoid an unnecessary full rebuild when fallback fingerprints are omitted.
  Apply full fallback replacements, subsequent batch deltas and explicit
  clearing even when no runtime surface labels changed.
- Preserve nested property receivers when a ready-state or reindex update
  clears resolution caches during completion. Keep recursive visit limits
  separate for the dynamic and static top-level walks.
- Read editable JSON metadata directly through owned descriptors, preserving
  strict UTF-8, full large/short reads, fresh results and descriptor cleanup.
  Avoid per-file text streams and repeated metadata-path joins/open flag work.
- Keep background diagnostics and inlay hints on the active daemon session;
  stale document scopes cannot restart or retarget foreground initialization.
  Cancel diagnostic work when its process session changes.
- Serialize source reindex batches through delta publication and retain failed
  file reindexes for retry while they remain in the active source scope.
- Discard stale reindex responses and batch deltas across daemon restarts;
  retain still-owned file events for the current process session.
- Preserve queued file changes and deletions when editable watcher roots refresh
  in the same workspace. Drop events for revoked roots or a different workspace.
- Defer Python provider priority changes while completion, hover, definition,
  or signature responses are in flight. Preserve responses across promotion
  requests and release the guard after results, timeouts, errors or cancellation.
- Recover indexed external module names after package-directory deletion,
  including alias paths, without scanning the whole module map or removing
  an unrelated module with the same filename.
- Handle collapsed folder-delete events and watched source-root deletion in
  VS Code. Expand missing indexed source paths without recursively scanning
  disk, retain deletion requests until ready, and keep canonical editable
  watcher roots stable for the daemon session.
- Scan and read editable metadata relative to one opened site-packages
  directory on supported platforms. Preserve portable reads, fresh metadata,
  symlink consistency and descriptor cleanup on failures.
- Scan repeated editable source roots once while retaining every install entry
  and preserving distinct path aliases and source fingerprints.
- Refresh models saved in discovered editable roots and watch their source
  changes, creation and deletion in VS Code. Preserve alias paths and report
  rejected reindex requests instead of treating them as successful changes.
- Share immutable lookup and blocked-name rows, including restored runtime
  caches, without changing JSON output or dropping large/custom registries.
  Detach caller rows and base transform maps from catalogue snapshots.
- Reuse runtime callable candidate names within a surface build while checking
  namespace names, value identities and function code. Keep visibility,
  descriptor selection and annotations live, with dynamic fallback and cleanup.
- Store builtin member metadata once with per-surface model/manager bindings,
  retain full custom records, and export receiver metadata without creating
  bound builtin records. Preserve order, duplicate winners and weak ownership.
- Compact member records and share immutable surface return metadata within
  each model, including cached surfaces, while preserving JSON output.
- Release recursive catalogue, declaration and field-resolver closures on
  completion and failure, so temporary fields, bindings and replaced indexes
  do not wait for cyclic GC. Preserve recursion budgets and descriptor identity.
  Handle a missing runtime snapshot before rebuilding its model graph.
- Overlay already committed model surfaces when adopting a background build,
  preserve current lookup revision fingerprints, and rebuild missing entries.
  Prepare surface notifications outside state/write locks, discard encoded
  stale snapshots before publication, coalesce full notifications after saves,
  and retry through successive edit bursts.
- Keep member cache lookups tied to their source snapshot across concurrent
  builds. Adopt expected owners and invalidate affected models atomically,
  prevent late work from evicting or resurrecting entries, and index cache keys
  by model. Preserve catalogue-only and unchanged-index reuse with weak owners;
  invalidate potentially mixed surfaces with cache schema 34.
- Share static manager declaration analysis across receivers in one surface
  build, with fresh stat checks, independent result dictionaries and isolated
  build contexts. Detect manager, field and imported constant source changes
  using size, ctime and file identity as well as mtime; invalidate potentially
  stale snapshots with cache schema 33.
- Resolve standalone scalar helper edits only in dependent model modules,
  preserving unrelated forward groups and reverse relations. Use general
  resolution for inheritance, duplicate labels, relation/PK changes and
  unpacked constructor options; invalidate older snapshots with cache schema 32.
- Materialize imported literals inside mixed list/tuple/dict/set field options
  under one shared expansion budget. Track mutable aliases and container views
  so mutation cannot publish an old literal value; keep rebinding independent
  and invalidate older snapshots with cache schema 31.
- Refresh scalar lookup metadata after referenced workspace literal constants
  change, including aliases and explicit re-exports. Preserve source snapshots,
  instance lookups and graph-cache restoration without executing edited source;
  invalidate older constructor dependency caches with schema 30.
- Reuse expanded field groups during general resolution and skip inherited-name
  sets for standalone models. Preserve duplicate label expansion, field winners
  and the exact ordering of supplied resolved cache fields.
- Avoid allocating text readers for absent editable-install metadata while
  retaining fresh metadata reads and closing file descriptors on all outcomes.
- Share runtime source-path membership within one surface build, including
  excluded library files, then release it after success or failure. Keep
  workspaces, concurrent builds and mutable membership sets separate while
  re-inspecting live class members.
- Classify already-read lookup registry entries for Django's default resolution
  methods, including stable transform output fields. Preserve custom overrides,
  computed output-field dispatch, instance registrations and dynamic transforms.
- Select workspace callable names before static descriptor inspection, reducing
  repeated Django library introspection during member surface rebuilds. Retain
  subclass hiding, metaclass descriptors, custom directory visibility and
  DynamicClassAttribute fallback behavior without invoking project properties.
- Reuse runtime/static label joins across unchanged candidate and graph links,
  freezing runtime catalogue membership and invalidating joins on model or label
  changes. Remove prior graph labels after catalogue replacement, retain
  collision ordering, and invalidate older graph caches with schema 29.
- Reuse resolved forward field groups and reverse field tuples on supported
  scalar saves, avoiding repeated Python filtering of unchanged fields. Refresh
  partitions after relation/coverage changes, and preserve both declarations
  when multiple static models share one label. Invalidate older caches with schema 28.
- Update model name/import graph indexes and fallback field checks for affected
  models only, retaining unrelated groups and collision behavior. Prevent saved
  models with runtime app labels from creating duplicate static graph nodes;
  invalidate older graph caches with schema 27.
- Refresh parameterized field lookups after module-local literal constants or
  aliases change, preserving declaration-time assignments, import bindings and
  class-local constant precedence.
  Bound expansion, reject unsupported dynamic values, and invalidate schema-25 caches.
- Remember when a module's field declarations depend only on local Django
  types and literal/self relations, avoiding repeated declaration scans on
  model creation/deletion while revalidating edited and dependent modules.
- Update module statistics by delta during model creation/deletion, reuse
  unchanged reverse fields and field lookup keys across model coverage changes,
  and refresh relation-source indices when models become abstract or concrete.
- Replace Python lookup descriptor chunks by model, preserving older snapshots
  without copying or scanning the complete type table on each edit. Flatten
  the catalogue at full IPC, cache and fingerprint serialization boundaries.
- Keep unknown native property/method return types from hiding annotated model
  chains before runtime readiness; reuse prepared return metadata when available.
- Preserve excluded runtime source paths in the method cache, inspect inherited
  members once, and honour methods hidden by subclass attributes.
- Reuse unchanged related-model surfaces during scalar saves while rebuilding
  source/import dependents; skip unrelated class defaults in model lookup deltas.
- Measure complete ready-runtime edit RPCs, repeated catalogue updates and
  transform-chain correctness; invalidate surfaces from the previous method scan.
- Refresh lookup output after same-kind field constructor edits, including
  nested array base fields and generated output fields, using current declarations.
- Index PostgreSQL field imports and retain constructor fingerprints through
  inheritance and cache restoration; invalidate older cache schemas.
- Send per-model lookup metadata deltas through the daemon and language server,
  preserve unrelated model metadata and replace old descriptors on repeated edits.
- Reuse unchanged local fields and literal relation targets through model coverage
  changes; clone module containers only when inheritance expansion modifies them.
- Update warmed source-path membership incrementally on file creation/deletion,
  preserving shared canonical paths and detecting retargeted or removed symlinks.
- Include every top-level directory in source tree fingerprints and invalidate
  older caches that could omit changes. Preserve saves during cache verification,
  scan on a separate process, and publish initialization metadata atomically.
- Carry saved field overrides and model deletion markers through runtime warm-up
  and cache refresh; keep modified runtime state out of source-keyed caches.
- Decode editable file URLs containing spaces, Unicode or localhost, and ignore
  malformed metadata without interrupting virtualenv discovery.
- Reuse unchanged scalar field groups and graph candidates, and verify saved
  fields survive the complete background cache refresh in file-tier benchmarks.
- Reuse unchanged built-in scalar fields on model creation/deletion while
  re-resolving symbol relations; verify created-model completion and deleted
  model name removal through the actual VS Code watcher.
- Reuse import/inheritance dependency graphs and changed-field labels during
  incremental invalidation; handle safe standalone scalar deletion without a
  global field rebuild while preserving import and inheritance changes.
- Send static fallback changes as model deltas, preserve complete native model
  coverage during warm-up, and serialize/write language-server caches asynchronously.
- Preserve package/file collision winners through edits and deletion; distinguish
  document opens from edits so bursts of real saves are all reindexed.
- Batch discovery work, reuse unchanged source-path sets, and handle external
  editable packages through source fingerprints and full/partial cache restoration.
- Keep edited field types and deletions ahead of cached runtime model metadata,
  including lookup completion after changing a field type in a running workspace.
- Measure fresh-process initialization and complete reindex RPCs separately from
  compute-only benchmarks, with explicit checks against file-tier performance targets.
- Build, merge and release native state off the editor event loop, with ordered
  snapshot installation, chunked field-only input and cancellation guards.
- Reuse unchanged immutable fields and lookup maps during incremental indexing;
  preserve inherited model labels and isolate inheritance expansion snapshots.
- Refresh import dependents, old reverse targets, export locations and receiver
  caches after source edits, including changes with no model surface delta.
- Bound native export cache generations, share cached export tables, and validate
  deterministic stress data with complete FK traversal assertions.
- Preserve completion receivers after comments and triple-quoted strings, and
  verify helper creation, source movement and deletion through the file watcher.
- Use per-field runtime lookup metadata, including instance registrations,
  transform chains, generated output fields, and composite primary keys.
- Restore runtime completion for parameterized transforms; support JSON keys,
  PostgreSQL array/HStore/range continuations, and raster band metadata.
- Support async lookup methods, Django 6.1 `fetch_mode()`, and the new bitwise
  aggregate expression field paths. Update constraint fixtures to `condition=`.
- Preserve typed annotation transform chains and resolve annotation fields
  through configured `Manager.from_queryset()` classes.
- Cache transform and lookup tables, remove the 200-name cutoff, reuse runtime
  type descriptors, and refresh completion caches when lookup metadata changes.
- Add real-Django query comparison tests and repeatable lookup benchmarks.
- Support positional aggregate aliases containing `__`, Unicode lookup contexts,
  scalar expression outputs for foreign keys, and parameterized array annotations.
- Preserve the latest annotation type across variable reassignment and distinguish
  `select_related()` paths from `prefetch_related()` accessors and `only()`/`defer()` paths.
- Add version-aware `totally_ordered` property completion and calendar-version parsing.
  Finish projection transforms without adding an unusable `__` suffix.
- Use cache generations for rebuilt Rust indices/graphs and binding-aware receiver
  cache keys; keep temporary field identities stable during metadata collection.

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
- Lazy cold start: daemon, language server, Pylance activation, and stub overrides are opt-in or first-use only
- ORM diagnostics remain enabled by default but start lazily with the daemon
- Large-file diagnostics default to visible-range scanning; full-document diagnostics are opt-in via `djangoOrmIntellisense.diagnostics.fullDocument`
- 67 E2E tests covering completion, hover, definition, and diagnostics

## 0.0.1

- Initial VS Code extension scaffold.
