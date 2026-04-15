# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | Yes                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately by emailing the maintainer rather than opening a public issue.

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The extension runs a Python analysis daemon inside the user's configured virtualenv. The daemon:

- Reads Python source files in the workspace
- Executes `django.setup()` to load model metadata
- Communicates with the VS Code client over stdio JSON IPC

The daemon does **not** make network requests, write files outside of its cache directory, or execute arbitrary user code beyond Django's standard setup process.
