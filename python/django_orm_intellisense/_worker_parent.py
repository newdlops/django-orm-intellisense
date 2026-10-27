"""Shared, stdlib-only parent watcher, available before server package imports."""
from __future__ import annotations

import os
import threading

_watch_lock = threading.Lock()
_watch_thread: threading.Thread | None = None
_pipe_lock = threading.Lock()
_pipe_fds: set[int] = set()


def _close_fd(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        pass


def _reset_after_fork() -> None:
    global _watch_lock, _watch_thread, _pipe_lock
    # A forked sibling must not keep another worker's parent pipe alive.
    for fd in _pipe_fds:
        _close_fd(fd)
    # Keep the registry shared with the server lifetime module after a fork.
    _pipe_fds.clear()
    _pipe_lock = threading.Lock()
    _watch_lock = threading.Lock()
    _watch_thread = None


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(before=lambda: _pipe_lock.acquire(),
        after_in_parent=lambda: _pipe_lock.release(), after_in_child=_reset_after_fork)


def _start_watch(target, args) -> bool:
    global _watch_thread
    with _watch_lock:
        if _watch_thread is not None:
            return False
        thread = threading.Thread(target=target, args=args,
            name='djls-parent-lifetime', daemon=True)
        _watch_thread = thread
        try:
            thread.start()
        except BaseException:
            _watch_thread = None
            raise
        return True


def _exit_after_pipe(fd: int) -> None:
    try:
        while os.read(fd, 1):
            pass
    except BaseException:
        return os._exit(1)
    # Exit never acquires a parent/worker lock, even if an import/task is stuck.
    os._exit(0)


def watch_inherited_parent_pipe(flag: str, value: str) -> None:
    if flag == '--parent-exit-handle':
        import msvcrt
        fd = msvcrt.open_osfhandle(int(value), os.O_RDONLY)
    elif flag == '--parent-exit-fd':
        fd = int(value)
    else:
        raise ValueError('Unknown worker parent handle kind')
    if fd < 3:
        raise ValueError('Worker parent pipe cannot be a standard stream')
    os.set_inheritable(fd, False)
    with _pipe_lock:
        _pipe_fds.add(fd)
    try:
        if not _start_watch(_exit_after_pipe, (fd,)):
            raise RuntimeError('Worker parent lifetime already configured')
    except BaseException:
        with _pipe_lock:
            _pipe_fds.discard(fd)
            _close_fd(fd)
        raise
