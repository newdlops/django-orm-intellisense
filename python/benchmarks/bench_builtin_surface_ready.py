"""Configured full ready/source edit with paired builtin construction control."""
import argparse
import inspect
import json
from pathlib import Path

from benchmarks import bench_static_stream_ready as paired


def ready_source():
    source = inspect.getsource(paired.ready.run)
    marker = '            client = Client('
    assert source.count(marker) == 1
    return source.replace(marker, '''            if lifecycle.startswith('cached-'):
                # Only this freshly generated benchmark cache is owned here.
                surfaces = list(cache.rglob('surface-index.json'))
                assert len(surfaces) == 1
                for path in surfaces:
                    assert path.resolve().is_relative_to(cache.resolve())
                    path.unlink()
''' + marker)


def run(models, file_count, output_dir, repetitions):
    source = inspect.getsource(paired.run)
    for old, new in [
        ('DJLS_BENCH_STATIC_LEGACY_RESTORE', 'DJLS_BENCH_BUILTIN_LEGACY_CONSTRUCT'),
        ('benchmarks.static_stream_restore_worker', 'benchmarks.builtin_surface_construct_worker'),
        ('source = inspect.getsource(ready.run)', 'source = ready_source()'),
    ]:
        assert source.count(old) == 1
        source = source.replace(old, new)
    namespace = {**paired.__dict__, 'ready_source': ready_source}
    exec(compile(source, str(Path(paired.__file__)) + ':builtin_construct_ready', 'exec'), namespace)
    result = namespace['run'](models, file_count, output_dir, repetitions)
    for row in result['rows']:
        if row['phase'].startswith('cached-'):
            log = Path(row['daemonLog']).read_text()
            assert 'prebuild_surface_index(background) start reason=cache_miss' in log
            assert 'prebuild_member_surface_cache: 2500 surfaces' in log
            row['forcedOwnedSurfaceCacheMissVerified'] = True
    result['scope'] = ('Sequential fresh configured daemons with symmetric source-compiled builtin '
        'helper controls and rotating cached pairs. Previous helper constructs bound records before '
        'packing; current cache builds feed shared templates directly. All source/static/runtime/cache/IPC '
        'work is actual production. Complete cached response equality except daemon startedAt, all '
        'model/scalar/FK/custom output checks, current cold and same-size edit first response. '
        'Helper source control bootstrap included; not stable ordinary SLO or aggregate process memory. '
        'Each paired cached run removes only the generated owned surface cache to force actual '
        'surface prebuild while retaining source/static/runtime/graph caches; all cache-miss logs verified.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.repetitions), indent=2))
