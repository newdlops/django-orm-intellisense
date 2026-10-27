"""Owned private-file input for background worker processes."""
from __future__ import annotations

import contextlib
import pickle
import tempfile
from pathlib import Path
from .._native_state import state_temporary_directory


class _PersistentWorkerStateFile:
    def __init__(self, state):
        self._state = state
        self._directory = None

    def __enter__(self):
        if self._state is None:
            raise RuntimeError('Worker state file context cannot be reused')
        directory = None
        try:
            directory = state_temporary_directory('djls-persistent-worker-state-', tempfile.TemporaryDirectory)
            path = Path(directory.name) / 'state.pickle'
            with path.open('wb') as stream:
                pickle.dump(self._state, stream, protocol=pickle.HIGHEST_PROTOCOL)
            self._directory = directory
            return str(path)
        except BaseException:
            if directory is not None:
                directory.cleanup()
            raise
        finally:
            # A persistent pool may outlive this generation of parent metadata.
            # Only the private file, not the original graph, stays with it.
            self._state = None

    def __exit__(self, *_):
        directory, self._directory = self._directory, None
        if directory is not None:
            directory.cleanup()


def persistent_worker_state_file(static_index, runtime, model_graph):
    # A plain context owner avoids generator frames retaining these arguments
    # throughout a pool's lifetime. Pickle the full tuple to preserve aliases.
    return _PersistentWorkerStateFile((static_index, runtime, model_graph))


@contextlib.contextmanager
def surface_worker_state_file(static_index, runtime, model_graph):
    with _private_state_file((static_index, runtime, model_graph), 'djls-surface-worker-state-') as path:
        yield path


@contextlib.contextmanager
def runtime_member_refresh_state_file(static_index, runtime, model_graph, surface_keys):
    with _private_state_file((static_index, runtime, model_graph, surface_keys),
            'djls-runtime-member-state-') as path:
        yield path


@contextlib.contextmanager
def runtime_member_state_file(members):
    if members is None:
        yield None
        return
    with _private_state_file(members, 'djls-surface-worker-runtime-') as path:
        yield path


@contextlib.contextmanager
def _private_state_file(state, prefix):
    # Close the writer before a child opens it (including on Windows). The
    # parent keeps this private directory until its pool has fully shut down.
    with state_temporary_directory(prefix, tempfile.TemporaryDirectory) as directory:
        path = Path(directory) / 'state.pickle'
        with path.open('wb') as stream:
            pickle.dump(state, stream, protocol=pickle.HIGHEST_PROTOCOL)
        yield str(path)


def load_surface_worker_state(path):
    return _load_private_state_file(path)


def load_runtime_member_state(path):
    return _load_private_state_file(path)


def _load_private_state_file(path):
    # Only read the snapshot created by the parent's private context above.
    with Path(path).open('rb') as stream:
        return pickle.load(stream)
