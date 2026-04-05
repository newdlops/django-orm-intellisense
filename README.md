# Django ORM Intellisense

VS Code extension scaffold for building framework-aware Django ORM developer tooling.

## Current Architecture Scaffold

The repository is now split around the architecture in
[`implementation_plan.md`](./implementation_plan.md):

- `src/client/`: VS Code client lifecycle, commands, status UI, and daemon wiring
- `python/django_orm_intellisense/`: Python analysis daemon scaffold
- `implementation_plan.md`: phased plan for semantic graph, ORM analysis, and string reference support

The current daemon already provides:

- workspace discovery
- static Python file indexing
- initial `__init__.py` re-export and `import *` surface discovery
- runtime environment probing for Django availability
- conditional `django.setup()` bootstrap and runtime model metadata collection when Django and settings are available
- a canonical health snapshot returned over stdio JSON

The current VS Code client also provides an initial Python-language feature slice:

- completion for Django relation-string targets inside `ForeignKey(...)`, `OneToOneField(...)`, and `ManyToManyField(...)`
- hover for resolved relation strings such as `"app_label.ModelName"`
- completion, hover, and go-to-definition for string lookup paths in ORM calls such as `values("author__profile__timezone")` and `select_related("author__profile")`
- completion, hover, and go-to-definition for keyword lookup paths in `filter(...)`, `exclude(...)`, and `get(...)` calls such as `filter(author__profile__timezone__icontains="Asia")`
- base model inference for simple local queryset variables such as `products = Product.objects.active(); products.filter(category__slug="chairs")`
- base model inference for same-file and imported queryset helpers such as `build_products().filter(...)`, `self.local_queryset().filter(...)`, `cls.available_products().filter(...)`, and `super().base_queryset().filter(...)`
- hover on `from package import Symbol` to show the origin module behind package `__init__.py` re-exports when it can be resolved statically
- go-to-definition for resolved Django relation strings and statically resolved package re-exports

## Fixture Workspaces

The repo now includes fixture Django projects under `fixtures/` for the next implementation steps:

- `fixtures/minimal_project`: baseline models, reverse relations, and string model references
- `fixtures/reexport_project`: package `__init__.py` re-exports and star export surfaces
- `fixtures/advanced_queries_project`: custom queryset and manager patterns with cross-app relations

## Development

```bash
npm install
npm run compile
npm test
```

Then press `F5` in VS Code to launch an Extension Development Host.

`npm test` runs VS Code extension tests that exercise the actual completion, hover, and definition providers against the fixture Django workspaces.

## Available Commands

- `Django ORM Intellisense: Show Status`
- `Django ORM Intellisense: Restart Daemon`
- `Django ORM Intellisense: Configure Pylance Diagnostics`
- `Django ORM Intellisense: Select Settings Module`
- `Django ORM Intellisense: Select Python Interpreter`

## Configuration

- `djangoOrmIntellisense.pythonInterpreter`
- `djangoOrmIntellisense.autoStart`
- `djangoOrmIntellisense.settingsModule`
- `djangoOrmIntellisense.workspaceRoot`
- `djangoOrmIntellisense.logLevel`

By default the extension resolves the daemon interpreter like this:

1. `djangoOrmIntellisense.pythonInterpreter`
2. `python3` (or `python` on Windows)

This matters because Django-aware analysis must run inside the same environment that has Django and your project dependencies installed. If the daemon falls back to the OS global interpreter, relation and ORM metadata bootstrap will usually degrade.

`djangoOrmIntellisense.pythonInterpreter` can point either to the executable itself, such as `.venv/bin/python`, or to the environment directory, such as `.venv`. The extension now normalizes common virtualenv layouts automatically.

Run `Django ORM Intellisense: Select Python Interpreter` to choose a Python executable or virtualenv directory for the current workspace. Older `djangoOrmIntellisense.pythonPath` values are migrated automatically into `djangoOrmIntellisense.pythonInterpreter` and then removed.

For multi-environment Django projects that have modules such as `project.settings.local` or `project.settings.dev`, run `Django ORM Intellisense: Select Settings Module`. The extension now discovers `settings.py`, `settings/__init__.py`, and `settings/*.py` candidates and lets you choose which one should be used for `django.setup()`.

If Pylance is still reporting error-level false positives for dynamic Django ORM members that cannot be inferred statically, run `Django ORM Intellisense: Configure Pylance Diagnostics`. The recommended profile downgrades the common dynamic-member rules for the current workspace without overwriting unrelated Pylance overrides.

## Manual UI Check

1. Open a Django workspace.
2. Run `Django ORM Intellisense: Select Python Interpreter` and choose the project interpreter.
3. Open `Django ORM Intellisense: Show Status` and confirm the `Python` line points at the project interpreter instead of the OS global Python.
4. Open a model or query file and verify relation-string, string lookup-path, keyword lookup-path, and queryset-helper receiver completion still respond.
