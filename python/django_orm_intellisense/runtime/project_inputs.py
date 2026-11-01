"""Read-only input observations made inside one short-lived registry worker."""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading


def input_identity(path, value=None):
    try:
        value = os.stat(path) if value is None else value
        return [str(Path(path).resolve()), stat.S_IFMT(value.st_mode), value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_dev, value.st_ino]
    except FileNotFoundError:
        return None


def inputs_match(rows):
    if type(rows) not in (list, tuple) or not rows or len(rows) > 50000:
        return False
    try:
        return all(type(row) in (list, tuple) and len(row) == 2 and type(row[0]) is str
            and Path(row[0]).is_absolute() and input_identity(row[0]) == row[1] for row in rows)
    except (OSError, ValueError, TypeError):
        return False


class ProjectInputs:
    """Observe files read, existence checks, and import search directories.

    No values are retained. The stat wrapper is confined to this owned child
    and restored before handoff; its audit hook becomes inert on exit.
    """
    def __init__(self, source_files):
        self.sources = set(map(str, source_files))
        self.package = str(Path(__file__).resolve().parents[1]) + os.sep
        cache_root = os.environ.get('DJANGO_ORM_INTELLISENSE_CACHE_DIR') or str(Path(tempfile.gettempdir()) / 'django-orm-intellisense')
        self.code_cache = str(Path(cache_root).expanduser().absolute() / 'dependency-code-v1')
        self.rows = {}
        self.valid = True
        self.changed = False
        self.active = False
        self.local = threading.local()

    def remember(self, path, value=None):
        if not self.active or getattr(self.local, 'busy', False) or not isinstance(path, (str, bytes, os.PathLike)):
            return
        self.local.busy = True
        try:
            path = os.path.abspath(os.fsdecode(path))
            if (path in self.sources or path.startswith(self.package)
                    or path == self.code_cache or path.startswith(self.code_cache + os.sep)):
                return
            if len(self.rows) >= 50000 and path not in self.rows:
                self.valid = False
                return
            old = self.rows.get(path)
            # Repeated stat observations already carry the fresh identity.
            # Resolve aliases on first observation and final validation;
            # avoid walking every ancestor again for the same imported file.
            identity = ([old[0], stat.S_IFMT(value.st_mode), value.st_size,
                value.st_mtime_ns, value.st_ctime_ns, value.st_dev, value.st_ino]
                if old is not None and value is not None else input_identity(path, value))
            previous = self.rows.setdefault(path, identity)
            if previous != identity:
                self.valid = False
                self.changed = True
        except (OSError, ValueError, TypeError):
            self.valid = False
        finally:
            self.local.busy = False

    def audit(self, event, arguments):
        if not self.active or getattr(self.local, 'busy', False):
            return
        if event == 'open':
            path, mode, flags = arguments
            if not (flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)):
                self.remember(path)
        elif event in ('os.listdir', 'os.scandir'):
            self.remember(arguments[0] or os.getcwd())
        elif event == 'import' and len(arguments) > 2:
            for path in arguments[2] or ():
                if path:
                    self.remember(path)

    @contextmanager
    def observe(self):
        original = os.stat
        def observed(path, *args, **kwargs):
            try:
                value = original(path, *args, **kwargs)
            except FileNotFoundError:
                self.remember(path)
                raise
            if kwargs.get('dir_fd') is not None or kwargs.get('follow_symlinks') is False:
                self.valid = False
            else:
                self.remember(path, value)
            return value
        sys.addaudithook(self.audit)
        os.stat = observed
        self.active = True
        try:
            yield self
            # Already imported extension/stdlib modules are inputs too.
            for module in tuple(sys.modules.values()):
                path = getattr(module, '__dict__', {}).get('__file__')
                if isinstance(path, str):
                    self.remember(path)
                    self.remember(os.path.dirname(path))
        finally:
            self.active = False
            os.stat = original

    def snapshot(self):
        rows = [[path, value] for path, value in sorted(self.rows.items())]
        for path, expected in rows:
            try:
                if input_identity(path) != expected:
                    self.changed = True
            except (OSError, ValueError, TypeError):
                self.valid = False
        return rows if self.valid and not self.changed else None
