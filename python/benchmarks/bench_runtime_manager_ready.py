"""Actual configured ready/source-edit lifecycles with paired manager lookups."""
import argparse
import inspect
import json
from pathlib import Path

from benchmarks import bench_builtin_surface_ready as paired


def run(models, file_count, output_dir, repetitions):
    source = inspect.getsource(paired.run)
    for old, new in [
        ('DJLS_BENCH_BUILTIN_LEGACY_CONSTRUCT', 'DJLS_BENCH_RUNTIME_MANAGER_LEGACY_MAP'),
        ('benchmarks.builtin_surface_construct_worker', 'benchmarks.runtime_manager_map_worker'),
        ("'prebuild_member_surface_cache: 2500 surfaces'", "f'prebuild_member_surface_cache: {models * 5} surfaces'"),
    ]:
        assert source.count(old) == 1
        source = source.replace(old, new)
    namespace = dict(paired.__dict__)
    exec(compile(source, str(Path(paired.__file__)) + ':runtime_manager_ready', 'exec'), namespace)
    result = namespace['run'](models, file_count, output_dir, repetitions)
    result['scope'] = ('Sequential actual configured Django daemons with symmetric source-compiled '
        'manager lookup/decorator controls and rotating cached pairs. Previous performs a linear '
        'catalogue search per model, current uses a lazy catalogue map for one surface build. '
        'Cached pairs force only the owned generated surface cache to miss, retaining all other '
        'actual caches. Complete response equality except health.startedAt; every model/scalar/FK '
        'and custom parameterized transform checked, with current cold and same-size source edit '
        'first responses. All source/stat/AST/owner/generation guards and whole IPC preserved. '
        'Bootstrap is included; uncontrolled host and3pairs are not stable startup/RPC/editor SLOs '
        'or true aggregate process-tree memory evidence.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.repetitions), indent=2))
