"""Read workspace source for runtime inspection even when timestamp pycs match."""
import contextlib
import importlib.machinery
import os
import sys
import threading
import unicodedata
from collections import Counter
from pathlib import Path

from .dependency_code import cache_dependency_code


def _within_root(path, root):
    return path == root or path.startswith(root if root.endswith(os.sep) else root + os.sep)


def _path_has_parent(path):
    if os.altsep:
        path = path.replace(os.altsep, os.sep)
    return (path == os.pardir or path.startswith(os.pardir + os.sep)
        or path.endswith(os.sep + os.pardir) or os.sep + os.pardir + os.sep in path)


def _absolute_import_path(path):
    path = os.fspath(path)
    if os.name == 'posix' and _path_has_parent(path):
        # abspath would collapse link/.. before the filesystem follows link.
        return path if os.path.isabs(path) else os.path.join(os.getcwd(), path)
    return os.path.abspath(path)


def _resolved_root_match(origin, root, actual_root):
    if _within_root(origin, actual_root):
        return True
    # POSIX realpath can retain alternate case/Unicode spellings. Confirm
    # candidate spellings with the filesystem before expanding the scope.
    folded_origin = unicodedata.normalize('NFC', origin).casefold()
    folded_root = unicodedata.normalize('NFC', actual_root).casefold()
    if _within_root(folded_origin, folded_root):
        origin_parts, root_parts = Path(origin).parts, Path(actual_root).parts
        if len(origin_parts) >= len(root_parts):
            ancestor = Path(*origin_parts[:len(root_parts)])
            try:
                return os.path.samefile(ancestor, root)
            except OSError:
                pass
    return False


def _workspace_source(origin, roots):
    if not roots:
        return False
    if not _path_has_parent(origin) and any(
            not _path_has_parent(root) and _within_root(origin, root) for root in roots):
        return True
    # Resolve the directory first: an in-workspace file symlink still belongs
    # to that logical namespace even when its file target is external.
    namespace = os.path.join(os.path.realpath(os.path.dirname(origin)), os.path.basename(origin))
    resolved = []
    for root in roots:
        actual_root = os.path.realpath(root)
        resolved.append((root, actual_root))
        if _resolved_root_match(namespace, root, actual_root):
            return True
    # On POSIX a non-link final component cannot change this resolved parent.
    # Windows may have other reparse tags, so retain its full realpath check.
    if os.name == 'posix' and not os.path.islink(namespace):
        return False
    actual_origin = os.path.realpath(origin)
    if any(_resolved_root_match(actual_origin, root, actual_root) for root, actual_root in resolved):
        return True
    return False


class _CurrentSourceLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):
        source_path = self.get_filename(fullname)
        return self.source_to_code(self.get_data(source_path), source_path)


class _CurrentSourceFinder:
    def __init__(self):
        self.lock = threading.RLock()
        self.roots = Counter()

    def find_spec(self, fullname, path=None, target=None):
        if not any(item is importlib.machinery.PathFinder for item in sys.meta_path):
            return None
        with self.lock:
            roots = tuple(self.roots)
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if (spec is None or type(spec.loader) is not importlib.machinery.SourceFileLoader
                or not spec.origin):
            return spec
        origin = _absolute_import_path(spec.origin)
        if _workspace_source(origin, roots):
            spec.loader = _CurrentSourceLoader(fullname, spec.origin)
        else:
            cache_dependency_code(spec.loader, fullname)
        # This finder occupies PathFinder's original position, so return its
        # spec unchanged for dependency modules and preserve finder order.
        return spec


_finder = _CurrentSourceFinder()


def _remove_owned_finder():
    for position in range(len(sys.meta_path) - 1, -1, -1):
        if sys.meta_path[position] is _finder:
            del sys.meta_path[position]


@contextlib.contextmanager
def current_workspace_source_imports(roots):
    normalized = tuple(dict.fromkeys(_absolute_import_path(str(root)) for root in roots))
    if not normalized:
        yield
        return
    with _finder.lock:
        # Prepare the whole new count before publishing a finder or roots.
        # A partial Counter update must not leak an owner on MemoryError.
        updated = _finder.roots.copy()
        updated.update(normalized)
        if not any(item is _finder for item in sys.meta_path):
            position = next((index for index, item in enumerate(sys.meta_path)
                if item is importlib.machinery.PathFinder), len(sys.meta_path))
            try:
                sys.meta_path.insert(position, _finder)
            except BaseException:
                _remove_owned_finder()
                raise
        _finder.roots = updated
    # The generator must not retain an obsolete count snapshot while another
    # owner publishes its generation. Only the current global count is owned.
    del updated
    try:
        yield
    finally:
        with _finder.lock:
            for root in normalized:
                _finder.roots[root] -= 1
                if not _finder.roots[root]:
                    del _finder.roots[root]
            if not _finder.roots:
                _remove_owned_finder()
