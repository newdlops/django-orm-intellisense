"""Drive a separate Node foreground client against actual configured daemons."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture


def verify(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    for path, digest in manifest['originalPycSha256'].items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
    return {'originalPycPreserved': True, 'filesChecked': len(manifest['originalPycSha256'])}


def edit(spec):
    manifest = json.loads(Path(spec['manifest']).read_text())
    checks = []
    for name in ('source', 'helper'):
        path = Path(manifest[name])
        stamp = path.stat()
        text = path.read_text().replace(spec['previous'] + '_', spec['prefix'] + '_')
        text = text.replace(spec['previousManager'] + ' = ProjectManager()', spec['manager'] + ' = ProjectManager()')
        text = text.replace('field_0 = models.CharField(max_length=' + spec['previousLength'] + ')',
            'field_0 = models.CharField(max_length=' + spec['length'] + ')')
        assert len(text.encode()) == stamp.st_size
        path.write_text(text)
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        assert path.stat().st_mtime_ns == stamp.st_mtime_ns
        checks.append({'path': str(path), 'sameSize': True, 'exactRestoredMtimeNs': True})
    return {'files': checks, **verify(spec['manifest'])}


def run(models, files, output_dir, repetitions, worker_module, transport_version=0):
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'probe-runtime-refresh-foreground.cjs'
    for repetition in range(repetitions):
        folder = output_dir / str(repetition)
        folder.mkdir()
        with tempfile.TemporaryDirectory(prefix='djls-foreground-refresh-') as temporary:
            root = Path(temporary).resolve() / 'project'
            root.mkdir()
            source, helper, bytecode = create_fixture(root, models, files)
            manifest = folder / 'fixture.json'
            manifest.write_text(json.dumps({'root': str(root), 'cache': str(root.parent / 'cache'),
                'source': str(source), 'helper': str(helper), 'models': models, 'pythonFiles': files,
                'python': sys.executable, 'pythonPath': str(Path(__file__).resolve().parents[1]),
                'workerModule': worker_module,
                'transportVersion': transport_version,
                'originalPycSha256': {str(path): hashlib.sha256(value).hexdigest() for path, value in bytecode.items()}}, indent=2)+'\n')
            completed = subprocess.run(['node', str(script), str(manifest), str(folder)], text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            (folder / 'node-stderr.log').write_text(completed.stderr)
            (folder / 'node-stdout.log').write_text(completed.stdout)
            assert completed.returncode == 0, f'Node probe exited {completed.returncode}: {completed.stderr}'
            result = json.loads(completed.stdout)
            (folder / 'result.json').write_text(json.dumps(result, indent=2)+'\n')
            results.append(result)
            print(f'[foreground-refresh] repetition={repetition} daemons=2 nodeExit0', file=sys.stderr, flush=True)
    return {'models': models, 'pythonFiles': files, 'workerModule': worker_module, 'repetitions': repetitions,
        'transportVersion': transport_version,
        'nodeRuns': results, 'scope': 'Actual cold and cached Python CLI daemons with separate Node client; '
            'serial real foreground RPCs every 10ms while two model/helper save pairs refresh runtime members. '
            'End-to-end request latency includes daemon scheduling, transport and Node synchronous gzip/JSON decode. '
            'Full packets retained and all model/scalar/FK/custom metadata checked. '
            'Node CLI timer gaps are measured; actual VS Code/editor interactions, stable SLO and aggregate peak are unproved.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--worker-module', default='django_orm_intellisense')
    parser.add_argument('--transport-version', type=int, choices=(0, 1), default=0)
    parser.add_argument('--edit-json')
    parser.add_argument('--verify-manifest', type=Path)
    args = parser.parse_args()
    if args.verify_manifest:
        result = verify(args.verify_manifest)
    elif args.edit_json:
        result = edit(json.loads(args.edit_json))
    else:
        assert args.output_dir is not None
        result = run(args.models, args.files, args.output_dir.resolve(), args.repetitions, args.worker_module, args.transport_version)
    print(json.dumps(result, indent=2))
