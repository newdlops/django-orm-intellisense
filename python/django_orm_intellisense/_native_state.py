"""Locate the current native daemon's private snapshot root, when present."""
from __future__ import annotations

import os
import sys

_cached: tuple[int, str | None] | None = None


def native_state_directory() -> str | None:
    global _cached
    if os.name != 'posix' or sys.platform != 'darwin':
        return None
    pid = os.getpid()
    if _cached is not None and _cached[0] == pid:
        return _cached[1]
    import ctypes
    try:
        getter = ctypes.CDLL(None).djls_native_state_directory
    except AttributeError:
        root = None
    else:
        getter.argtypes = []
        getter.restype = ctypes.c_char_p
        encoded = getter()
        root = os.fsdecode(encoded) if encoded else None
    _cached = (pid, root)
    return root


def _finalize_in_owner(pid, callback, args, kwargs):
    if os.getpid() == pid:
        callback(*args, **kwargs)


class _OwnedTemporaryDirectory:
    def __init__(self, directory):
        import weakref
        self._owner_pid = os.getpid()
        self._directory = directory
        self.name = directory.name
        # A normal fork child must not run the parent's inherited weakref
        # finalizer, even when it exits through ordinary Python shutdown.
        try:
            detached = directory._finalizer.detach()
            if detached is None:
                raise RuntimeError('Temporary state directory finalizer is unavailable')
            _, callback, args, kwargs = detached
            directory._finalizer = weakref.finalize(directory, _finalize_in_owner,
                self._owner_pid, callback, args, kwargs)
        except BaseException:
            directory.cleanup()
            raise

    def __enter__(self):
        return self.name

    def cleanup(self):
        if os.getpid() == self._owner_pid:
            self._directory.cleanup()
        else:
            self._directory._finalizer.detach()

    def __exit__(self, *_):
        self.cleanup()


def state_temporary_directory(prefix, factory):
    root = native_state_directory()
    if root is None:
        return factory(prefix=prefix)
    return _OwnedTemporaryDirectory(factory(prefix=prefix, dir=root))
