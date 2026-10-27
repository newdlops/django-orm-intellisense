"""Diagnostic: reject graph cache hits to expose fresh-process rebuild costs."""
import json
import sys
import time

from benchmarks import profile_startup_phases_worker as phases
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app


app.load_cached_model_graph = lambda *args, **kwargs: None
original_registry = inspector._ensure_runtime_field_registry


def registry(settings_module):
    ready = (inspector._RUNTIME_FIELD_REGISTRY_READY
             and inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE == settings_module)
    started = time.perf_counter_ns()
    try:
        return original_registry(settings_module)
    finally:
        if not ready:
            print('[graph-rebuild:registry-cost] ' + json.dumps({
                'settingsModule': settings_module, 'wasReady': ready,
                'wallMs': (time.perf_counter_ns() - started) / 1e6,
                'readyAfter': inspector._RUNTIME_FIELD_REGISTRY_READY,
                'scope': 'Nested in graph build; not additive with graph phase cost.'}), file=sys.stderr, flush=True)


inspector._ensure_runtime_field_registry = registry

if __name__ == '__main__':
    phases.main()
