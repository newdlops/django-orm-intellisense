"""Optional pre-Python parent guard for supported, packaged POSIX workers."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def native_parent_spawn_options():
    # A source-only checkout and other platforms retain their existing watcher.
    # A present but incomplete native bundle is a launch error, never a silent
    # downgrade from the guard that the package advertises.
    if os.name != 'posix' or sys.platform != 'darwin':
        return {}
    directory = Path(__file__).resolve().parents[2] / 'native' / 'worker-parent' / 'darwin-universal'
    if not directory.exists():
        return {}
    launcher = directory / 'worker-parent-launch'
    library = directory / 'worker-parent-guard.dylib'
    if not launcher.is_file() or not library.is_file():
        raise OSError('Worker parent native bundle is incomplete')
    if not os.access(launcher, os.X_OK):
        raise PermissionError('Worker parent native launcher is not executable')
    return {'executable': str(launcher)}
