# Django ORM Intellisense

Framework-aware autocomplete, hover, go-to-definition, and optional diagnostics for Django ORM — right inside VS Code.

Stop guessing lookup paths like `author__profile__timezone__icontains` or relation strings like `"app_label.ModelName"`. This extension understands your Django project's models, relations, managers, and querysets at runtime, and gives you real-time feedback as you type.

## Features

### ORM Lookup Path Completion & Validation

Autocomplete for keyword arguments in `filter()`, `exclude()`, `get()`, `order_by()`, and other queryset methods. The extension resolves foreign key chains, reverse relations, and lookup operators (`__icontains`, `__gte`, etc.) based on your actual model graph.

```python
# Autocomplete suggests: author, author__profile, author__profile__timezone, ...
Product.objects.filter(author__profile__timezone__icontains="Asia")
```

Invalid lookup paths can be flagged with diagnostics when `djangoOrmIntellisense.diagnostics.enabled` is turned on.

Recommendations use the installed Django field and instance lookup registry,
including custom registrations and transform output types. Transform chains,
JSON keys and indices, and PostgreSQL array, HStore, and range transforms are
resolved locally from shared metadata. Unknown parameterized transforms fall
back to the Python runtime. Date and time transforms also work in field
projections such as `values()` and `order_by()`.

Saved scalar field options also refresh lookup output when they reference
module-local literal constants or aliases. Assignment order is preserved;
supported nested Django field/expression constructors are inspected without
executing project source. Imported constants, arbitrary custom constructors,
dynamic expressions and relation/primary-key metadata still have limitations.

Annotation paths preserve source and output types for `F()`, aggregates,
`ArrayAgg()`, and explicit array output fields. Positional aggregate aliases
such as `id__count`, Unicode names, and numeric JSON keys are supported.
`select_related()` offers single-valued relations; `prefetch_related()` uses
relation accessors. Django 6.1 `fetch_mode()` and `totally_ordered` follow the
project's Django version. Audit evidence and limits are recorded in
[the lookup audit](docs/django-lookup-audit.json).

### String Lookup Path Intelligence

Completion, hover, and go-to-definition for string-based ORM paths used in `values()`, `values_list()`, `select_related()`, `prefetch_related()`, `only()`, `defer()`, and more.

```python
Product.objects.select_related("author__profile")
Product.objects.values("author__profile__timezone")
```

### Relation String Resolution

Autocomplete and hover for Django relation-string targets inside `ForeignKey(...)`, `OneToOneField(...)`, and `ManyToManyField(...)` declarations.

### Queryset Receiver Inference

The extension infers the base model for queryset variables, method return values, and chained calls:

```python
products = Product.objects.active()
products.filter(...)  # knows this is a Product queryset

# Also works with:
# - self.get_queryset().filter(...)
# - cls.available().filter(...)
# - super().base_queryset().filter(...)
# - for item in qs: item.  (loop target inference)
# - build_products().filter(...)  (helper return inference)
```

### Expression & Annotation Support

- `Q()`, `F()`, `When()`, `Case()` expression field paths
- `annotate()` / `alias()` member propagation to downstream lookups and instance access
- `Subquery`, `OuterRef`, aggregate and window expression field paths
- `Meta` index and constraint field contexts

### Multiline Support

Handles multiline parenthesized expressions, chained method calls, and complex nested `Q`/`When`/`Case` constructs.

### Import & Re-export Resolution

Hover on `from package import Symbol` shows the origin module behind `__init__.py` re-exports. Go-to-definition navigates to the actual source, not the re-export shim.

### Django Builtin Method Hover

Hover on Django builtin methods like `.save()`, `.delete()`, `.filter()`, `.get()` shows method signatures with documentation.

### Pylance Integration

Optional suppression of Pylance false positives for dynamic Django ORM attributes that cannot be inferred statically.

## Requirements

- **VS Code** 1.90.0 or later
- **Python 3.10+** with Django installed in the project's virtual environment
- The extension runs a Python analysis daemon that needs access to your Django project's dependencies

## Quick Start

1. Install the extension from the VS Code Marketplace.
2. Open a Django project in VS Code.
3. The extension follows the Python environment selected in VS Code, then `python.defaultInterpreterPath`, then a project `.venv`, `venv`, `env`, or `.env` virtualenv. Use **Django ORM: Select Python Interpreter** (`Cmd+Shift+P`) when you need an explicit override. Python 3.10 or newer is required.
4. The extension discovers settings throughout the workspace, including nested Django projects and `src` layouts. All concrete Django settings contribute apps and models, including several services sharing one project root. Shared base settings are followed through their consumers. **Django ORM: Select Settings Module** prioritizes a default without excluding the other settings; **Show Status** lists each registry's progress or failure.
5. Start typing in a `filter()`, `values()`, or relation field — completions appear automatically.
6. For eager warm-up instead of lazy first-use startup, set `djangoOrmIntellisense.autoStart` to `true`.

## Commands

| Command | Description |
|---------|-------------|
| **Django ORM: Show Status** | Display daemon health, workspace info, and model index stats |
| **Django ORM: Restart Daemon** | Restart the Python analysis daemon |
| **Django ORM: Select Python Interpreter** | Choose the Python executable or virtualenv for analysis |
| **Django ORM: Select Settings Module** | Prioritize a Django settings module |
| **Django ORM: Suppress Pylance False Positives** | Configure Pylance diagnostic overrides for dynamic ORM attributes |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoOrmIntellisense.pythonInterpreter` | `""` | Optional override for automatic interpreter selection. Supports directory (`.venv`) or executable (`.venv/bin/python`) paths. Otherwise follows VS Code's selected/default interpreter or a project virtualenv. |
| `djangoOrmIntellisense.settingsModule` | `""` | Prioritized `DJANGO_SETTINGS_MODULE`; defaults to the declared project setting. Other concrete settings remain included. |
| `djangoOrmIntellisense.workspaceRoot` | `""` | Analysis root. Defaults to the containing VS Code workspace folder, including all nested Django projects. Set an explicit root to limit the analysis scope. |
| `djangoOrmIntellisense.autoStart` | `false` | Auto-start the analysis daemon when a Python file is opened. Disabled by default so activation stays lightweight; providers start the daemon lazily on first use. |
| `djangoOrmIntellisense.diagnostics.enabled` | `true` | Enable live Django ORM diagnostics. Diagnostics are lazy by default and run only after the analysis daemon is already started. |
| `djangoOrmIntellisense.diagnostics.fullDocument` | `false` | Continue large-file diagnostics beyond the visible range to scan the whole document. Disabled by default to keep diagnostic CPU and memory cost low. |
| `djangoOrmIntellisense.pylance.autoApplyStubOverrides` | `false` | Automatically write Django stub overrides and restart Pylance on activation. Disabled by default; use the configure command to apply overrides manually. |
| `djangoOrmIntellisense.logLevel` | `"info"` | Daemon log verbosity (`off`, `info`, `debug`). |

Every settings module gets an isolated Django registry. Within one project, common source models are deduplicated and settings-specific members and lookups are combined. Independent projects and different source classes with the same Django label keep separate identities. Parsed source modules and equal immutable member records are shared; registry collection runs serially in short-lived child processes, using the selected Python interpreter. Its environment must contain the dependencies required by the settings. A failing settings module preserves other results and remains visible in status. Multi-registry metadata stays in the current session rather than using the single-project startup cache.

## Architecture

The extension uses a split architecture:

- **TypeScript client** — VS Code integration, UI, provider registration
- **Python daemon** — Semantic analysis via hybrid static indexing + runtime Django inspection

The daemon bootstraps `django.setup()` inside your project's virtualenv to access the full model registry, then builds a semantic graph of models, fields, relations, managers, and querysets. Static indexing handles import resolution and re-export chains without Django being importable.

## Known Limitations

- The daemon must run inside the same Python environment where Django and project dependencies are installed.
- Very large projects (1000+ models) may experience brief delays on first indexing; subsequent operations use cached indexes.
- Anonymous or dynamic model classes (e.g., generated at runtime by meta-programming) may not be fully indexed.

## Development checks

Build the current native addon before measuring it:

```sh
npm run build:native:dev
npm run compile
cargo test --workspace
PYTHONPATH=python python -m unittest discover -s python/tests
npm run benchmark:full
npm run benchmark:native
PYTHONPATH=python python -m benchmarks.bench_reindex --models 1500 --json
PYTHONPATH=python python -m benchmarks.bench_daemon_lifecycle --models 1000
PYTHONPATH=python python -m benchmarks.bench_daemon_lifecycle --tiers
PYTHONPATH=python python -m benchmarks.bench_ready_runtime --models 1000 --files 10000
PYTHONPATH=python python -m benchmarks.bench_ready_runtime --models 1000 --files 10000 --local-constants
PYTHONPATH=python python -m benchmarks.bench_catalog_delta --models 1000 --repetitions 100
PYTHONPATH=python python -m benchmarks.bench_lookup_selection --repetitions 100
PYTHONPATH=python python -m benchmarks.bench_surface_paths --repetitions 1000
PYTHONPATH=python python -m benchmarks.bench_callable_candidates --repetitions 1000
PYTHONPATH=python python -m benchmarks.bench_manager_bindings --repetitions 1000
PYTHONPATH=python python -m benchmarks.bench_member_cache --models 1000 --repetitions 1000
PYTHONPATH=python python -m benchmarks.bench_surface_heap --models 1000
PYTHONPATH=python python -m benchmarks.bench_lookup_storage --models 1000 --repetitions 100
PYTHONPATH=python python -m benchmarks.bench_venv_metadata --repetitions 7
PYTHONPATH=python python -m benchmarks.bench_venv_metadata --repetitions 7 --compare-backends
PYTHONPATH=python python -m benchmarks.bench_editable_roots --metadata 500 --files 1000
PYTHONPATH=python python -m benchmarks.bench_imported_constants --models 1000 --files 10000 --repetitions 100
PYTHONPATH=python python -m benchmarks.bench_imported_constants --models 1000 --files 10000 --repetitions 100 --mixed-containers
PYTHONPATH=python python -m benchmarks.bench_model_coverage
PYTHONPATH=python python -m benchmarks.bench_source_paths --models 1000 --files 10000
DJLS_LOOKUP_TEST_PYTHON=/path/to/django/python node --expose-gc scripts/benchmark-catalog-deltas.cjs 1000
node scripts/check-lsp-saves.cjs
npm run stress -- 100000 --json
```

The native benchmark checks editor event-loop gaps, concurrent query latency,
snapshot races, export invalidation, cache-save responsiveness and live-state
retention. `bench_reindex` measures the indexer and daemon compute stage;
`bench_daemon_lifecycle` additionally includes commit, serialization, compression,
transport and fresh-process initialization. Its file tiers retain failing plan
budget checks instead of treating a successful run as proof of meeting targets.
They also wait for cached source verification to finish and check that a saved
field survives the refresh and remains available to lookup resolution.
`bench_ready_runtime` creates a configured Django app and measures full edit RPCs
after runtime inspection. It changes every model's parameterized field, repeats
the first model's edits, checks descriptor retention and resolves the resulting
transform chain through the daemon. Its ready-runtime timings are separate from
the settings-free lifecycle tiers. `--local-constants` keeps field calls unchanged
and edits only their module-local size constant.
The default request deadline is 30 seconds. `--request-timeout 60` allows a
longer diagnostic wait while retaining measured latency and budget failures;
the report records whether initialization exceeded the default deadline.
Timed-out requests retain the daemon log for phase-level diagnosis.
`bench_catalog_delta` isolates Python catalogue replacement after every model
has been edited. It checks repeated-edit retention and older snapshots, and
measures full JSON export separately from incremental updates.
`bench_lookup_selection` compares registry-entry classification with Django's
per-name method resolution using the real lookup oracle fixture. It verifies
identical catalogues and profiles method calls; it excludes complete daemon
RPC, bootstrap and SQL costs. Its legacy guard mock adds baseline overhead.
`bench_surface_paths` compares source-path sharing across three receiver member
inspections in one build. It uses installed Django and a local queryset compiled
through a symlink, verifies identical metadata and counts path resolution calls.
Its scope excludes complete surface construction, discovery and daemon RPC.
`bench_callable_candidates` compares three receiver inspections with shared
source paths on both sides, disabling only candidate sharing for the baseline.
It includes namespace/code guards, current visibility and annotation reads;
candidate snapshots last for one build and exclude full surface/RPC timing.
`bench_manager_bindings` compares four static manager declaration inspections
within one build, with zero or two declared managers. It checks equivalent
metadata and reports source stat and AST analysis counts separately; it excludes
runtime inspection, complete surfaces and daemon RPC.
`bench_member_cache` compares the former full cache-key scan with model-indexed
invalidation across five receivers per model. It verifies refilled metadata,
unrelated surface identity and bounded bookkeeping; refill and complete RPC
costs are excluded from its timings.
`bench_surface_heap` counts reachable member-cache and surface containers,
records and scalar values once by identity, using real static/graph metadata
and pending runtime. It reports a separate explicit full-GC diagnostic; it
excludes other workspace objects, process RSS and complete RPC latency.
The cache retains shared builtin templates and local model/manager bindings;
individual queries return full member records, and full surface export reads
template metadata directly. Custom and runtime records retain their source
locations, annotations and signatures.
`bench_lookup_storage` independently collects each synthetic model's catalogue
using the real Django lookup fixture. It measures owned catalogue containers
after all models have private chunks, with explicit GC and full export measured
separately. Source reconstruction, other runtime/workspace objects, RSS and RPC
are excluded. Lookup and dynamic blocked-name rows share immutable tuples;
JSON arrays and fingerprints remain compatible, including cached catalogues.
`bench_venv_metadata` measures complete synchronous venv discovery with mixed
legacy/modern editables, ordinary and malformed metadata, and missing files.
It verifies every editable result at 0/500/2000 distributions and retains
failed 5ms budget checks; no stale metadata cache or recursive scanning is used.
Supported platforms scan and open metadata relative to one site-packages
directory descriptor. The portable path remains available; `--compare-backends`
alternates both modes on the same fixture with complete editable verification.
`--compare-readers` alternates the previous text stream and current descriptor
byte reader on the same complete metadata fixture, recording wall and CPU time.
The current reader consumes all chunks, including short reads, decodes strictly
as UTF-8 and closes its descriptor on success or failure.
Repeated editable paths are scanned once while install entries remain intact.
`bench_editable_roots` verifies external model initialization and a saved field
type change, followed by deletion of its whole package, through complete
deferred-runtime RPCs. Indexed external module names are recovered through
the deleted path's possible import names and matching source paths.
VS Code watches discovered
editable roots and forwards their saves and file creation/deletion events.
Folder deletion can arrive as one parent event. The daemon lists missing
indexed sources below that path for reindexing, including parse-failed and
shadowed workspace files. File deletion uses a direct module lookup;
directory deletion filters indexed paths without recursively scanning disk.
Nonrecursive parent watchers also detect deletion of a source root itself.
Watcher root refreshes retain queued changes and deletions that still belong
to the same workspace; revoked roots and workspace switches discard old work.
Reindex batches run one at a time. Failed file reindexes stay queued for retry
while their source paths remain in the active workspace's scope.
Responses and batch deltas from an invalidated daemon session are discarded;
still-owned file events can be processed again by the current session.
Source updates wait for the language server to confirm application. Failed
delivery schedules a fresh complete snapshot with retry intervals increasing
from 300ms to 5s. Saved changes made while the server is stopped are included
when it starts again. Each acknowledgement has a 10s timeout; an interrupted
incremental build forces a full rebuild on recovery.
Initialization checks current Python files before restoring cached metadata,
including discovered editable sources. Source fingerprints include change
time and file identity to detect same-size edits with preserved mtimes.
Unchanged static indexes are reused after that check; prior source snapshot
fingerprint formats are invalidated without changing the surface wire schema.
Background diagnostics and inlay hints use the active daemon session and
cannot retarget foreground initialization from an older document scope.
`node scripts/benchmark-source-queue.cjs` measures that scope filtering with
0/10/1000 queued changes and deletions, excluding debounce and daemon RPC time.
`node scripts/benchmark-surface-delivery.cjs` measures acknowledged LSP updates
at 1K/5K/10K synthetic models, including serialization, transport and server
application. It excludes Python reindexing, real files and editor debounce.
Python provider priority changes wait for active completion, hover, definition,
and signature responses, so re-registration does not cancel their results.
The guard spans registrations and releases when each handler exits; diagnostic
scan deferral and its existing limit remain separate.
Nested property completion keeps the returned model when a ready-state or
reindex update clears receiver caches during resolution. Dynamic and static
top-level walks have separate visit sets, each retaining its recursion limit.
`bench_imported_constants` edits a per-model helper's imported literal while
keeping model declarations unchanged. It verifies bounded catalogue deltas,
lookup output and descriptor retention through complete ready-runtime RPCs.
`--mixed-containers` includes imported choice values inside local list/tuple
options while keeping model declarations unchanged during helper edits.
`--profile /tmp/helper-edits.prof` profiles the daemon for local cost attribution;
profiled latency includes instrumentation overhead and is separate from budget runs.
`DJLS_PROFILE_SURFACE_ADOPTION=1` records adoption and IPC phase timings.
`DJLS_PROFILE_REINDEX=1` records compute phases, foreground thread CPU time and
GC pauses without changing garbage collection policy.
Ready-runtime benchmarks also await a full notification whose lookup metadata
matches every completed model edit; that verification wait is outside edit timings.
`bench_model_coverage` profiles model creation/deletion compute at 1,000 models
and 10,000 files. These instrumented compute timings exclude commit and IPC;
use the lifecycle tiers for complete RPC budget evidence.
`bench_source_paths` separately checks that warmed path membership handles model
creation/deletion without resolving every file path again.
The catalog-delta benchmark measures metadata updates after every model has been
edited and verifies that another 100 edits do not retain old descriptors. It
uses a smaller field fixture and measures local updates, excluding daemon RPCs.
The LSP check covers initial synchronization, bursts of real saves, and fallback
delta completion invalidation. Stress fixtures preserve scalar types,
forward/reverse relations and deterministic sampling; partial traversal fails
validation. Results and measured limits are recorded in `docs/performance-audit.json`.

## License

MIT
