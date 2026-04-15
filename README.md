# Django ORM Intellisense

Framework-aware autocomplete, hover, go-to-definition, and diagnostics for Django ORM — right inside VS Code.

Stop guessing lookup paths like `author__profile__timezone__icontains` or relation strings like `"app_label.ModelName"`. This extension understands your Django project's models, relations, managers, and querysets at runtime, and gives you real-time feedback as you type.

## Features

### ORM Lookup Path Completion & Validation

Autocomplete for keyword arguments in `filter()`, `exclude()`, `get()`, `order_by()`, and other queryset methods. The extension resolves foreign key chains, reverse relations, and lookup operators (`__icontains`, `__gte`, etc.) based on your actual model graph.

```python
# Autocomplete suggests: author, author__profile, author__profile__timezone, ...
Product.objects.filter(author__profile__timezone__icontains="Asia")
```

Invalid lookup paths are flagged with diagnostics so you catch typos before they hit production.

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
3. Run **Django ORM: Select Python Interpreter** (`Cmd+Shift+P`) and choose the project's virtualenv.
4. The extension auto-detects `DJANGO_SETTINGS_MODULE` from `manage.py`. For multi-settings projects, run **Django ORM: Select Settings Module**.
5. Start typing in a `filter()`, `values()`, or relation field — completions appear automatically.

## Commands

| Command | Description |
|---------|-------------|
| **Django ORM: Show Status** | Display daemon health, workspace info, and model index stats |
| **Django ORM: Restart Daemon** | Restart the Python analysis daemon |
| **Django ORM: Select Python Interpreter** | Choose the Python executable or virtualenv for analysis |
| **Django ORM: Select Settings Module** | Choose which Django settings module to use |
| **Django ORM: Suppress Pylance False Positives** | Configure Pylance diagnostic overrides for dynamic ORM attributes |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoOrmIntellisense.pythonInterpreter` | `""` | Python interpreter or virtualenv path. Supports directory (`.venv`) or executable (`.venv/bin/python`) paths. |
| `djangoOrmIntellisense.settingsModule` | `""` | `DJANGO_SETTINGS_MODULE` value. Auto-detected from `manage.py` if empty. |
| `djangoOrmIntellisense.workspaceRoot` | `""` | Django project root for monorepo setups. |
| `djangoOrmIntellisense.autoStart` | `true` | Auto-start the analysis daemon when a Python file is opened. |
| `djangoOrmIntellisense.logLevel` | `"info"` | Daemon log verbosity (`off`, `info`, `debug`). |

## Architecture

The extension uses a split architecture:

- **TypeScript client** — VS Code integration, UI, provider registration
- **Python daemon** — Semantic analysis via hybrid static indexing + runtime Django inspection

The daemon bootstraps `django.setup()` inside your project's virtualenv to access the full model registry, then builds a semantic graph of models, fields, relations, managers, and querysets. Static indexing handles import resolution and re-export chains without Django being importable.

## Known Limitations

- The daemon must run inside the same Python environment where Django and project dependencies are installed.
- Very large projects (1000+ models) may experience brief delays on first indexing; subsequent operations use cached indexes.
- Anonymous or dynamic model classes (e.g., generated at runtime by meta-programming) may not be fully indexed.

## License

MIT
