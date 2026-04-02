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
- a canonical health snapshot returned over stdio JSON

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Available Commands

- `Django ORM Intellisense: Show Status`
- `Django ORM Intellisense: Restart Daemon`

## Configuration

- `djangoOrmIntellisense.autoStart`
- `djangoOrmIntellisense.pythonPath`
- `djangoOrmIntellisense.settingsModule`
- `djangoOrmIntellisense.logLevel`
