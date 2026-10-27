"""Candidate-only source-cache warming before concurrent parent Django setup."""
import functools
import os
import sys
import traceback

from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main


original_start = app.DaemonServer._start_runtime_field_registry_prewarm


@functools.wraps(original_start)
def start(self, runtime, health_snapshot=None, **kwargs):
    if (os.environ.get('DJLS_BENCH_SOURCE_FIRST_PREVIOUS') == '1'
            or os.environ.get('DJLS_SURFACE_PREBUILD_ON_MISS') == '0'):
        return original_start(self, runtime, health_snapshot, **kwargs)
    # The original method imports this callable before starting its thread.
    # Bind the immutable owner's inputs there, then immediately restore the
    # module entry. Candidate control only; production must bind directly.
    static_index = self.static_index
    original_ensure = inspector._ensure_runtime_field_registry
    def ensure(settings):
        if static_index is not None:
            try:
                app.prebuild_runtime_workspace_paths(static_index, runtime)
            except Exception:
                print('[benchmark] source-first warm failed ' + traceback.format_exc(limit=3),
                    file=sys.stderr, flush=True)
        return original_ensure(settings)
    inspector._ensure_runtime_field_registry = ensure
    try:
        return original_start(self, runtime, health_snapshot, **kwargs)
    finally:
        inspector._ensure_runtime_field_registry = original_ensure


app.DaemonServer._start_runtime_field_registry_prewarm = start
if __name__ == '__main__':
    main()
