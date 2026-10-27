"""Candidate-only inline thread path for measuring surface prebuild tradeoffs."""
from __future__ import annotations

import contextlib
from concurrent.futures import ThreadPoolExecutor
import sys

from benchmarks import profile_surface_load_worker as base

app = base.app
_candidate_state = None
_candidate_members = None


@contextlib.contextmanager
def _surface_state_file(static_index, runtime, model_graph):
    global _candidate_state
    previous = _candidate_state
    _candidate_state = (static_index, runtime, model_graph)
    try:
        yield '<inline-thread-candidate-state>'
    finally:
        _candidate_state = previous


@contextlib.contextmanager
def _runtime_member_state_file(members):
    global _candidate_members
    previous = _candidate_members
    _candidate_members = members
    try:
        yield '<inline-thread-candidate-members>'
    finally:
        _candidate_members = previous


def _prebuild_surface_index(_members_path=None):
    if _candidate_state is None:
        raise RuntimeError('Candidate worker state is not owned by this prebuild')
    static_index, runtime, model_graph = _candidate_state
    print('[surface-worker:phase-start] build_surface_index_cache',
        file=sys.stderr, flush=True)
    return app.prebuild_member_surface_cache(
        static_index, runtime, model_graph, runtime_members=_candidate_members)


class _ThreadCandidatePool:
    def __init__(self, *args, **kwargs):
        self._pool = ThreadPoolExecutor(max_workers=kwargs.get('max_workers', 1))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self._pool.shutdown(wait=True)
        return False

    def submit(self, function, *args, **kwargs):
        return self._pool.submit(function, *args, **kwargs)


# This alters only the benchmark daemon: keep publication, source generation
# checks, and response semantics on the real DaemonServer implementation.
app.surface_worker_state_file = _surface_state_file
app.runtime_member_state_file = _runtime_member_state_file
app._bg_prebuild_surface_index = _prebuild_surface_index
app.ProcessPoolExecutor = _ThreadCandidatePool


if __name__ == '__main__':
    base.profile_startup_phases_worker.main()
