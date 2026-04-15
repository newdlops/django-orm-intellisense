# Contributing to Django ORM Intellisense

Thank you for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/newdlops/django-orm-intellisense.git
cd django-orm-intellisense
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host for manual testing.

## Running Tests

```bash
npm test
```

This runs 67 E2E tests against fixture Django projects using VS Code's test framework.

To run with a specific Python interpreter:

```bash
DJLS_E2E_BASE_PYTHON=/path/to/.venv/bin/python npm test
```

## Project Structure

```
src/client/          TypeScript VS Code client (providers, commands, UI)
python/              Python analysis daemon (indexing, resolution, IPC)
fixtures/            Django fixture projects for E2E testing
out/                 Compiled JavaScript output (git-ignored)
```

## Architecture

The extension uses a split architecture:

- **TypeScript client** handles VS Code integration: provider registration, command palette, status UI, and daemon lifecycle management.
- **Python daemon** runs inside the project's virtualenv and performs semantic analysis: static source indexing, runtime Django model inspection, and ORM query resolution.

Communication between client and daemon uses JSON over stdio IPC.

## Pull Requests

1. Fork the repository and create a feature branch.
2. Make your changes and ensure `npm test` passes.
3. Write a clear commit message describing what changed and why.
4. Open a pull request against `main`.

## Reporting Issues

Please open an issue at https://github.com/newdlops/django-orm-intellisense/issues with:

- VS Code version
- Python / Django version
- Extension log output (Output panel → Django ORM Intellisense)
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
