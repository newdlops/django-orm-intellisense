"""Kernel-handle ownership for pool and fresh runtime worker processes."""
from __future__ import annotations

import contextlib
import multiprocessing
import os
import threading

from .. import _worker_parent
from .._native_parent import native_parent_spawn_options
from .._worker_parent import _close_fd, _pipe_fds, _start_watch, watch_inherited_parent_pipe

_pipe_lock = threading.Lock()
_surface_connections: set = set()


def _reset_after_fork() -> None:
    global _pipe_lock, _surface_connections
    for connection in _surface_connections:
        connection.close()
    _surface_connections = set()
    _pipe_lock = threading.Lock()


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(before=lambda: _pipe_lock.acquire(),
        after_in_parent=lambda: _pipe_lock.release(), after_in_child=_reset_after_fork)


def _exit_after_parent(parent) -> None:
    try:
        parent.join()
    except BaseException:
        return os._exit(1)
    os._exit(0)


def watch_parent_lifetime() -> None:
    parent = multiprocessing.parent_process()
    if parent is not None:
        _start_watch(_exit_after_parent, (parent,))


class DrainingProcessPool:
    """Keep a pool's file and EOF channel until its accepted work has drained."""
    def __init__(self, executor, state_scope):
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._shutdown_requested = False
        self._shutdown_error = None
        self._executor = executor
        self._state_scope = state_scope

    def submit(self, *args, **kwargs):
        with self._lock:
            if self._shutdown_requested:
                raise RuntimeError('cannot schedule new futures after shutdown')
        # Do not hold our lock while spawn or executor submission can block.
        return self._executor.submit(*args, **kwargs)

    def _drain(self):
        try:
            try:
                self._executor.shutdown(wait=True)
            finally:
                self._state_scope.close()
        except BaseException as error:
            self._shutdown_error = error
        finally:
            self._closed.set()

    def shutdown(self, wait=True):
        start_error = None
        with self._lock:
            if not self._shutdown_requested:
                self._shutdown_requested = True
                try:
                    thread = threading.Thread(target=self._drain,
                        name='djls-pool-drain', daemon=True)
                    thread.start()
                except BaseException as error:
                    start_error = error
        if start_error is not None:
            # If no cleanup thread can start, preserve accepted work and close
            # its resources synchronously rather than abandoning the scope.
            self._drain()
            raise start_error
        if wait:
            self.wait_closed()

    def wait_closed(self, timeout=None):
        if not self._closed.wait(timeout):
            return False
        if self._shutdown_error is not None:
            raise self._shutdown_error
        return True


class ParentExitPipe:
    """One private EOF channel; stdio and the launch environment stay intact."""
    def __init__(self):
        self._owner_pid = os.getpid()
        with _worker_parent._pipe_lock:
            self.reader, self.writer = os.pipe()
            try:
                _pipe_fds.update((self.reader, self.writer))
            except BaseException:
                _pipe_fds.discard(self.reader)
                _pipe_fds.discard(self.writer)
                _close_fd(self.reader)
                _close_fd(self.writer)
                raise

    def __enter__(self):
        return self

    def _require_owner(self):
        if os.getpid() != self._owner_pid or self.reader is None or self.writer is None:
            raise RuntimeError('Worker parent pipe is not owned by this process')

    def spawn_parameters(self):
        self._require_owner()
        if os.name == 'nt':
            import msvcrt
            import subprocess
            handle = msvcrt.get_osfhandle(self.reader)
            os.set_handle_inheritable(handle, True)
            startup = subprocess.STARTUPINFO()
            startup.lpAttributeList = {'handle_list': [handle]}
            return ['--parent-exit-handle', str(handle)], {'startupinfo': startup, 'close_fds': True}
        return ['--parent-exit-fd', str(self.reader)], {'pass_fds': (self.reader,), **native_parent_spawn_options()}

    def child_spawned(self):
        self._require_owner()
        with _worker_parent._pipe_lock:
            _pipe_fds.discard(self.reader)
            _close_fd(self.reader)
            self.reader = None

    def __exit__(self, *_):
        if os.getpid() == self._owner_pid:
            with _worker_parent._pipe_lock:
                for fd in (self.reader, self.writer):
                    if fd is not None:
                        _pipe_fds.discard(fd)
                        _close_fd(fd)
        self.reader = self.writer = None


class _SurfaceWorkerStatePath(str):
    """The sole snapshot path plus one spawn-transferred, read-only EOF handle."""
    def __new__(cls, path, reader=None):
        value = super().__new__(cls, path)
        value._surface_parent_reader = reader
        return value


@contextlib.contextmanager
def surface_pool_state_path(path, stopping):
    # These pools use spawn: a child receives only its reader, never a copy of
    # the parent's writer. Closing that writer also cancels an in-flight task.
    with _pipe_lock:
        reader, writer = multiprocessing.Pipe(duplex=False)
        try:
            _surface_connections.update((reader, writer))
        except BaseException:
            _surface_connections.discard(reader)
            _surface_connections.discard(writer)
            try:
                reader.close()
            finally:
                writer.close()
            raise
    finished = threading.Event()

    def stop_worker():
        while not finished.wait(0.02):
            if stopping.is_set():
                with _pipe_lock:
                    writer.close()
                return

    monitor = threading.Thread(target=stop_worker, name='surface-prebuild-stop', daemon=True)
    try:
        monitor.start()
        yield _SurfaceWorkerStatePath(path, reader)
    finally:
        try:
            finished.set()
            if monitor.is_alive():
                monitor.join()
        finally:
            with _pipe_lock:
                _surface_connections.discard(reader)
                _surface_connections.discard(writer)
                try:
                    reader.close()
                finally:
                    writer.close()


def _exit_after_surface_pool_parent(reader):
    try:
        while True:
            reader.recv_bytes()
    except EOFError:
        os._exit(0)
    except BaseException:
        os._exit(1)


def watch_surface_pool_lifetime(path):
    reader = getattr(path, '_surface_parent_reader', None)
    if reader is None:
        # Ordinary string paths keep their multiprocessing parent sentinel.
        watch_parent_lifetime()
        return
    try:
        if not _start_watch(_exit_after_surface_pool_parent, (reader,)):
            raise RuntimeError('Surface worker parent lifetime already configured')
    except BaseException:
        reader.close()
        raise
