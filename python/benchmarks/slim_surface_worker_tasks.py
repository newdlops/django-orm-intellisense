"""Tiny task module, so spawn does not import the benchmark driver."""
import sys
import time
import resource

_initialization = None


def initialize_profiled(mode, path):
    global _initialization
    wall, cpu = time.perf_counter_ns(), time.process_time_ns()
    if mode == 'previous':
        from django_orm_intellisense.server.app import _init_bg_worker_from_file
        _init_bg_worker_from_file(path)
    else:
        from benchmarks.slim_surface_worker_candidate import initialize
        initialize(path)
    _initialization = {'childInitializeWallMs': (time.perf_counter_ns() - wall) / 1e6,
                       'childInitializeCpuMs': (time.process_time_ns() - cpu) / 1e6}


def task(mode):
    wall, cpu = time.perf_counter_ns(), time.process_time_ns()
    if mode == 'previous':
        from django_orm_intellisense.server.app import _bg_prebuild_surface_index
        surface = _bg_prebuild_surface_index()
    else:
        from benchmarks.slim_surface_worker_candidate import prebuild
        surface = prebuild()
    return {'surface': surface, 'childCpuAtCompletionMs': time.process_time() * 1000,
            'childPrebuildWallMs': (time.perf_counter_ns() - wall) / 1e6,
            'childPrebuildCpuMs': (time.process_time_ns() - cpu) / 1e6,
            'childImportedRpcDaemon': 'django_orm_intellisense.server.app' in sys.modules,
            'childModuleCount': len(sys.modules)}


def after_surface_return():
    return {**_initialization,
            'childCpuAfterSurfaceReturnMs': time.process_time() * 1000,
            'childPeakRssThroughSurfaceReturnBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            * (1 if sys.platform == 'darwin' else 1024)}
