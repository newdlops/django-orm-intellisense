"""Ordinary ABBA workers: repeated identical saves and complete runtime recovery."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture
from benchmarks.bench_initial_lookup_catalog import sha, tree


def run(output, variants):
    repo = Path(__file__).resolve().parents[2]
    baseline_path = repo / 'bench/duplicate-reindex-baseline.json'
    baseline = json.loads(baseline_path.read_text())
    output.mkdir(parents=True, exist_ok=False)
    reproduction = Path(tempfile.mkdtemp(prefix='djls-duplicate-reindex-', dir='/private/tmp'))
    names = set(baseline['verifiedPreviousHashes']) | {'python/tests/test_duplicate_reindex.py',
        'python/benchmarks/bench_duplicate_reindex.py', 'scripts/probe-duplicate-reindex.cjs'}
    hashes = {name: sha(repo / name) for name in sorted(names)}
    rows = []
    for index, variant in enumerate(variants):
        folder = output / f'{index}-{variant}'
        folder.mkdir()
        root = reproduction / f'{index}-fixture'
        root.mkdir()
        create_fixture(root, 500, 5000)
        uuid = root / 'app0/model_1.py'
        uuid.write_text(uuid.read_text().replace('class Model1(models.Model):',
            'class Model1(models.Model):\n    key = models.UUIDField(primary_key=True)'))
        source_tree, paths = tree(root)
        before = {path.relative_to(root).as_posix(): sha(path) for path in paths}
        assert len(before) == 5000
        archive = folder / 'fixture-source.tar.gz'
        with tarfile.open(archive, 'w:gz') as target:
            for path in paths:
                target.add(path, arcname=path.relative_to(root), recursive=False)
        python_path = Path(baseline['pythonBaseline']['pythonPath']) if variant == 'baseline' else repo / 'python'
        package = python_path / 'django_orm_intellisense'
        worker = {path.relative_to(package).as_posix(): sha(path) for path in sorted(package.rglob('*.py'))}
        manifest = {'root': str(root), 'cache': str(reproduction / f'{index}-cache'), 'python': sys.executable,
            'pythonPath': str(python_path), 'workerModule': 'django_orm_intellisense', 'variant': variant,
            'models': 500, 'pythonFiles': 5000, 'idleMs': 'default', 'transportVersion': 1,
            'sourceTreeSha256': source_tree, 'sourceBeforeFiles': before, 'workerPackageSha256': worker,
            'fixtureArchive': str(archive), 'fixtureArchiveSha256': sha(archive),
            'probeSha256': sha(repo / 'scripts/probe-duplicate-reindex.cjs'),
            'inheritedProbeSha256': sha(repo / 'scripts/probe-cached-initialize-surface.cjs'),
            'driverSha256': sha(Path(__file__)), 'sourceBeforeAndAfterHashes': hashes}
        (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        completed = subprocess.run(['node', str(repo / 'scripts/probe-duplicate-reindex.cjs'),
            str(folder / 'manifest.json'), str(folder)], cwd=repo, capture_output=True, text=True)
        (folder / 'node-stdout.log').write_text(completed.stdout)
        (folder / 'node-stderr.log').write_text(completed.stderr)
        assert completed.returncode == 0, (folder, completed.stderr)
        result = json.loads(completed.stdout)
        assert result['daemonExit'] == {'code': 0, 'signal': None} and not result.get('failure')
        assert tree(root)[0] == source_tree
        assert all(sha(repo / name) == digest for name, digest in hashes.items())
        assert all(sha(package / name) == digest for name, digest in worker.items())
        row = {'index': index, 'variant': variant, 'manifest': str(folder / 'manifest.json'),
            'result': str(folder / 'probe-result.json'), 'sourceTreeUnchangedAfterDaemon': True,
            'sourceAndWorkerHashesUnchangedDuringDaemon': True,
            'saves': [{'phase': saved['phase'], 'firstReindexMs': saved['requests'][0]['rpcMs'],
                'duplicateReindexMs': [reply['rpcMs'] for reply in saved['requests'][1:]],
                'duplicateUnchanged': [reply['result'].get('unchanged', False) for reply in saved['requests'][1:]],
                'fullReadyFromRequestMs': saved['fullReadyFromRequestMs'],
                'discardedBeforeCapture': saved['refreshLog'].count('discarded reason=superseded_before_capture')}
                for saved in result['sourceEdits']]}
        rows.append(row)
        (output / 'partial-results.json').write_text(json.dumps(rows, indent=2) + '\n')
        print(f'[duplicate-reindex] {index} {variant} terminalExit0', file=sys.stderr, flush=True)
    return {'rows': rows, 'variants': variants, 'baseline': str(baseline_path),
        'baselineSha256': sha(baseline_path), 'reproductionRoot': str(reproduction),
        'sourceBeforeAndAfterHashes': hashes,
        'scope': 'Configured ordinary cold workers,500models/5000files. Two preserved-mtime constructor saves '
            'each receive three identical repeat requests, immediately and during capture. Complete fields, '
            'UUID/negativeid, relations, seven members/named manager and custom lookup restoration are checked. '
            'Before/after worker and code hashes prove source freeze. ABBA is bounded host-uncontrolled evidence; '
            'no stable SLO, visual/physical paint or aggregate-memory claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--variants', nargs='+', choices=['baseline', 'current'],
        default=['baseline', 'current', 'current', 'baseline'])
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir.resolve(), args.variants), indent=2))
