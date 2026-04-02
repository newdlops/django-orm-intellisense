from __future__ import annotations

import argparse
from pathlib import Path

from .server.app import DaemonServer


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Django ORM Intellisense analysis daemon scaffold.'
    )
    parser.add_argument(
        '--stdio',
        action='store_true',
        help='Run the daemon over newline-delimited JSON on stdio.',
    )
    parser.add_argument(
        '--workspace',
        default='.',
        help='Workspace root to analyze.',
    )
    args = parser.parse_args()

    if not args.stdio:
        parser.error('Only --stdio mode is currently supported.')

    server = DaemonServer(Path(args.workspace).resolve())
    server.run_stdio()


if __name__ == '__main__':
    main()
