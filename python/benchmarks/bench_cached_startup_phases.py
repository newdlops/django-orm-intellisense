"""Complete startup fidelity with ordinary and instrumented phase controls."""
from __future__ import annotations

import argparse
import json
import os
import pstats
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture
from benchmarks.bench_initial_lookup_catalog import sha, tree


def run(models, files, output, modes, python_path=None, idle_ms=2000, cprofile=True):
    output.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[2]
    python_path = python_path or repo / 'python'
    reproduction = Path(tempfile.mkdtemp(prefix='djls-cached-startup-phases-', dir='/private/tmp'))
    root = reproduction / 'fixture'
    root.mkdir()
    create_fixture(root, models, files)
    uuid = root / 'app0/model_1.py'
    uuid.write_text(uuid.read_text().replace('class Model1(models.Model):',
        'class Model1(models.Model):\n    key = models.UUIDField(primary_key=True)'))
    tree_sha, paths = tree(root)
    assert len(paths) == files
    archive_path = output / 'fixture-source.tar.gz'
    with tarfile.open(archive_path, 'w:gz') as archive:
        for path in paths:
            archive.add(path, arcname=path.relative_to(root), recursive=False)
    probe = repo / 'scripts/probe-cached-startup-phases.cjs'
    profile_worker = repo / 'python/benchmarks/profile_cached_startup_worker.py'
    package = python_path / 'django_orm_intellisense'
    package_hashes = {path.relative_to(package).as_posix(): sha(path) for path in sorted(package.rglob('*.py'))}
    rows = []
    for index, mode in enumerate(modes):
        assert mode in ['ordinary', 'profile']
        folder = output / f'{index}-{mode}'
        folder.mkdir()
        profile_dir = folder / 'profiles'
        manifest = {
            'root': str(root), 'cache': str(reproduction / f'{index}-{mode}-cache'),
            'python': sys.executable, 'pythonPath': os.pathsep.join(dict.fromkeys([str(python_path), str(repo / 'python')])),
            'workerModule': 'benchmarks.profile_cached_startup_worker' if mode == 'profile' else 'django_orm_intellisense',
            'variant': 'current', 'mode': mode, 'models': models, 'pythonFiles': files,
            'idleMs': idle_ms, 'transportVersion': 1, 'sourceTreeSha256': tree_sha,
            'driverSha256': sha(Path(__file__)), 'probeSha256': sha(probe),
            'profileWorkerSha256': sha(profile_worker), 'workerPackageSha256': package_hashes,
            'diagnosticCProfile': mode == 'profile' and cprofile,
            'diagnosticIpcProfile': mode == 'profile',
        }
        manifest_path = folder / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        env = dict(os.environ)
        env.pop('DJLS_CACHED_STARTUP_PROFILE_DIR', None)
        env.pop('DJLS_PROFILE_SURFACE_ADOPTION', None)
        if mode == 'profile':
            env['DJLS_PROFILE_SURFACE_ADOPTION'] = '1'
            if cprofile:
                env['DJLS_CACHED_STARTUP_PROFILE_DIR'] = str(profile_dir)
        completed = subprocess.run(['node', str(probe), str(manifest_path), str(folder)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        (folder / 'node-stderr.log').write_text(completed.stderr)
        (folder / 'node-stdout.log').write_text(completed.stdout)
        assert completed.returncode == 0, f'Node probe failed: {folder}: {completed.stderr}'
        result = json.loads(completed.stdout)
        (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        profiles = {}
        for path in sorted(profile_dir.glob('*.pstats')):
            stats = pstats.Stats(str(path))
            entries = []
            for (filename, line, function), (primitive, total, self_s, cumulative_s, _callers) in stats.stats.items():
                entries.append({'file': filename, 'line': line, 'function': function,
                    'primitiveCalls': primitive, 'totalCalls': total,
                    'selfMs': self_s * 1000, 'cumulativeMs': cumulative_s * 1000})
            entries.sort(key=lambda row: row['cumulativeMs'], reverse=True)
            profiles[str(path)] = {'sha256': sha(path), 'totalCalls': stats.total_calls,
                'primitiveCalls': stats.prim_calls, 'totalMs': stats.total_tt * 1000,
                'topCumulative': entries[:40], 'topSelf': sorted(entries, key=lambda row: row['selfMs'], reverse=True)[:40]}
        (folder / 'profile-summary.json').write_text(json.dumps(profiles, indent=2) + '\n')
        rows.append({'index': index, 'mode': mode, 'artifact': str(folder / 'result.json'),
            'profileSummary': str(folder / 'profile-summary.json'), 'result': result,
            'profileSha256': {name: value['sha256'] for name, value in profiles.items()}})
        assert tree(root)[0] == tree_sha
        assert all(sha(package / name) == digest for name, digest in package_hashes.items())
        print(f'[cached-startup-phases] {index} {mode} cold+cached terminalExit0 profiles={len(profiles)}',
            file=sys.stderr, flush=True)
    return {'models': models, 'pythonFiles': files, 'sourceTreeSha256': tree_sha,
        'fixtureArchive': str(archive_path), 'fixtureArchiveSha256': sha(archive_path),
        'reproductionRoot': str(reproduction), 'python': sys.version, 'rows': rows,
        'driverSha256': sha(Path(__file__)), 'probeSha256': sha(probe),
        'profileWorkerSha256': sha(profile_worker), 'sourceTreeUnchangedAfterAllDaemons': True,
        'scope': 'Same complete UUID/custom fixture in fresh cold/cached CLI daemons. Instrumented rows '
            'are diagnostic only: nested phase times must not be summed; process CPU excludes children '
            'and includes concurrent threads; cProfile changes overhead. Ordinary mode is a separate '
            'control. Exact positive/negative/custom/UUID results and all initial/full fields/FKs are checked. '
            'Unix clocks align Python phases with Node receipt approximately; monotonic clocks determine '
            'RPC durations. No editor, physical paint, stable startup or aggregate-memory claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--modes', nargs='+', choices=['ordinary', 'profile'], default=['profile', 'ordinary'])
    parser.add_argument('--python-path', type=Path)
    parser.add_argument('--idle-ms', type=int, default=2000)
    parser.add_argument('--no-cprofile', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir.resolve(), args.modes,
        args.python_path.resolve() if args.python_path else None, args.idle_ms, not args.no_cprofile), indent=2))
