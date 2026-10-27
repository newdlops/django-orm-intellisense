"""Native-protected spawn workers and pre-allocation tracker startup."""
from __future__ import annotations

import contextlib
import io
import multiprocessing
import os
import select
import signal
import sys
import time
import warnings
from pathlib import Path
from multiprocessing.context import SpawnContext, SpawnProcess, set_spawning_popen

from ._native_parent import native_parent_spawn_options

_guarded_tracker_pid = None


def _close(fd):
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def _reap_unready(pid):
    # This is our unreaped direct child, so its PID cannot be reused here.
    deadline = time.monotonic() + 2.5
    while True:
        observed, _ = os.waitpid(pid, os.WNOHANG)
        if observed == pid:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            return
        time.sleep(min(0.01, remaining))




def _same_inherited_environment(environment):
    # os.environ is a Python cache: os.putenv/C startup hooks can change the
    # inherited native environment without changing that mapping. In that
    # case keep the original launcher and its native getenv/exec inheritance.
    import ctypes
    library = ctypes.PyDLL(None)
    current_environment = library._NSGetEnviron
    current_environment.argtypes = []
    current_environment.restype = ctypes.POINTER(ctypes.POINTER(ctypes.c_char_p))
    entries = current_environment()[0]
    actual = []
    index = 0
    while True:
        entry = entries[index]
        if entry is None:
            break
        actual.append(entry)
        index += 1
    expected = [os.fsencode(key) + b'=' + os.fsencode(value) for key, value in environment.items()]
    # Exact sequence comparison also keeps duplicate/opaque native entries
    # and any uncertainty on the original path, without rewriting them.
    return actual == expected


def _spawnv_guarded(path, args, passfds, launcher, library_name, readers, ready=None):
    # Keep the original launcher on interpreters whose fork_exec ABI has not
    # been qualified. This is an optimization of the child exec chain only.
    from multiprocessing import util
    environment = os.environ.copy()
    if (sys.implementation.name != 'cpython' or sys.version_info[:2] not in ((3, 11), (3, 12))
            or not _same_inherited_environment(environment)):
        if ready is None:
            command = [launcher, '--djls-worker-readers', readers, '--', *args]
        else:
            command = [launcher, '--djls-tracker-reader', readers,
                '--djls-tracker-ready', str(ready), '--', *args]
        return util.spawnv_passfds(launcher, command, passfds)
    import _posixsubprocess
    import subprocess
    # Mirror the existing C launcher in a per-child environment. Never mutate
    # os.environ: another spawn may be running on a different Python thread.
    original = environment.get('DYLD_INSERT_LIBRARIES')
    library = str(Path(os.fsdecode(launcher)).resolve().parent / library_name)
    environment['DJLS_NATIVE_PARENT_PRELOAD_PRESENT'] = '0' if original is None else '1'
    environment['DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL'] = original or ''
    environment['DYLD_INSERT_LIBRARIES'] = library + (':' + original if original else '')
    environment['DJLS_NATIVE_PARENT_FD'] = readers
    if ready is not None:
        environment['DJLS_NATIVE_PARENT_READY_FD'] = str(ready)
    encoded = [os.fsencode(key) + b'=' + os.fsencode(value) for key, value in environment.items()]
    passfds = tuple(sorted(map(int, passfds)))
    errpipe_read, errpipe_write = os.pipe()
    try:
        # The same CPython 3.11/3.12 primitive, FD layout, signal settings and
        # vfork flag as multiprocessing.util.spawnv_passfds, with child env.
        return _posixsubprocess.fork_exec(
            args, [path], True, passfds, None, encoded,
            -1, -1, -1, -1, -1, -1, errpipe_read, errpipe_write,
            False, False, -1, None, None, None, -1, None,
            subprocess._USE_VFORK)
    finally:
        os.close(errpipe_read)
        os.close(errpipe_write)


def _prime_tracker(directory, stopping):
    from multiprocessing import resource_tracker, spawn, util
    global _guarded_tracker_pid
    tracker = resource_tracker._resource_tracker
    with tracker._lock:
        if tracker._lock._recursion_count() > 1:
            tracker._reentrant_call_error()
        if tracker._fd is not None:
            if tracker._check_alive():
                # An inherited or previously started tracker keeps its standard
                # lifetime. It is not retrospectively certified by our guard.
                return
            _close(tracker._fd)
            try:
                if tracker._pid is not None:
                    os.waitpid(tracker._pid, 0)
            except ChildProcessError:
                pass
            tracker._fd = tracker._pid = None
            _guarded_tracker_pid = None
            warnings.warn('resource_tracker: process died unexpectedly, relaunching. Some resources might leak.')
        if stopping.is_set():
            raise RuntimeError('Worker startup cancelled')
        reader = writer = ready_reader = ready_writer = pid = None
        try:
            reader, writer = os.pipe()
            ready_reader, ready_writer = os.pipe()
            executable = spawn.get_executable()
            original = [executable, *util._args_from_interpreter_flags(), '-c',
                f'from multiprocessing.resource_tracker import main;main({reader})']
            launcher = os.fsencode(directory / 'resource-tracker-launch')
            pass_fds = [reader, ready_writer]
            try:
                pass_fds.append(sys.stderr.fileno())
            except Exception:
                pass
            mask = None
            try:
                if resource_tracker._HAVE_SIGMASK:
                    mask = signal.pthread_sigmask(signal.SIG_BLOCK, resource_tracker._IGNORED_SIGNALS)
                pid = _spawnv_guarded(executable, original, pass_fds, launcher,
                    'resource-tracker-startup-guard.dylib', str(reader), ready_writer)
            finally:
                if mask is not None:
                    signal.pthread_sigmask(signal.SIG_SETMASK, mask)
            _close(reader)
            reader = None
            _close(ready_writer)
            ready_writer = None
            deadline = time.monotonic() + 25
            while True:
                if stopping.is_set():
                    raise RuntimeError('Worker startup cancelled')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Worker resource tracker startup timed out')
                readable, _, _ = select.select([ready_reader], [], [], min(0.02, remaining))
                if readable:
                    if os.read(ready_reader, 1) != b'R':
                        raise RuntimeError('Worker resource tracker exited before readiness')
                    break
            # Every product caller enters this context before constructing its
            # executor/queues/semaphores. No resource registration precedes R.
            tracker._fd, tracker._pid = writer, pid
            _guarded_tracker_pid = pid
            writer = pid = None
        finally:
            for fd in (reader, writer, ready_reader, ready_writer):
                _close(fd)
            if pid is not None:
                _reap_unready(pid)


def _spawn_popen(process_obj):
    from multiprocessing import popen_spawn_posix, reduction, resource_tracker, spawn, util

    class NativePopen(popen_spawn_posix.Popen):
        def _launch(self, process_obj):
            tracker_fd = resource_tracker.getfd()
            self._fds.append(tracker_fd)
            prep_data = spawn.get_preparation_data(process_obj._name)
            fp = io.BytesIO()
            set_spawning_popen(self)
            try:
                reduction.dump(prep_data, fp)
                reduction.dump(process_obj, fp)
            finally:
                set_spawning_popen(None)
            parent_r = child_w = child_r = parent_w = None
            try:
                parent_r, child_w = os.pipe()
                child_r, parent_w = os.pipe()
                command = spawn.get_command_line(tracker_fd=tracker_fd, pipe_handle=child_r)
                self._fds.extend([child_r, child_w])
                readers = [child_r]
                explicit = process_obj._djls_parent_reader
                if explicit is not None:
                    readers.append(explicit)
                    if explicit not in self._fds:
                        self._fds.append(explicit)
                launcher = os.fsencode(process_obj._djls_native_launcher)
                self.pid = _spawnv_guarded(command[0], command, self._fds, launcher,
                    'worker-parent-guard.dylib', ','.join(map(str, readers)))
                self.sentinel = parent_r
                with open(parent_w, 'wb', closefd=False) as output:
                    output.write(fp.getbuffer())
            finally:
                fds_to_close = [fd for fd in (parent_r, parent_w) if fd is not None]
                self.finalizer = util.Finalize(self, util.close_fds, fds_to_close)
                for fd in (child_r, child_w):
                    if fd is not None:
                        os.close(fd)

    return NativePopen(process_obj)


class _NativeProcess(SpawnProcess):
    @staticmethod
    def _Popen(process_obj):
        return _spawn_popen(process_obj)


class _NativeContext(SpawnContext):
    def __init__(self, launcher, reader):
        self._djls_launcher = launcher
        self._djls_reader = reader

    def Process(self, *args, **kwargs):
        process = _NativeProcess(*args, **kwargs)
        process._djls_native_launcher = self._djls_launcher
        process._djls_parent_reader = self._djls_reader
        return process


@contextlib.contextmanager
def guarded_spawn_context(stopping, owned_path=None):
    options = native_parent_spawn_options()
    if not options:
        yield multiprocessing.get_context('spawn')
        return
    launcher = Path(options['executable'])
    for name in ['resource-tracker-launch', 'resource-tracker-startup-guard.dylib']:
        if not (launcher.parent / name).is_file():
            raise OSError('Worker resource tracker native bundle is incomplete')
    if not os.access(launcher.parent / 'resource-tracker-launch', os.X_OK):
        raise PermissionError('Worker resource tracker launcher is not executable')
    _prime_tracker(launcher.parent, stopping)
    reader = getattr(owned_path, '_surface_parent_reader', None)
    if reader is not None:
        yield _NativeContext(str(launcher), reader.fileno())
        return
    # Snapshot verification also needs an explicit channel when the daemon is
    # still alive but stdio/its owner has closed. Bound it to the executor scope.
    from .server.worker_lifetime import surface_pool_state_path
    with surface_pool_state_path('', stopping) as path:
        yield _NativeContext(str(launcher), path._surface_parent_reader.fileno())
