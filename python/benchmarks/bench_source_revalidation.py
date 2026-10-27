"""Pair full source snapshots and allocation reuse after full current stat."""
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace


def run(file_count, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-revalidation-cost-') as temporary:
        root = Path(temporary).resolve()
        for number in range(file_count):
            directory = root / f'app{number // 500}'
            directory.mkdir(exist_ok=True)
            (directory / f'helper_{number}.py').write_text(f'value={number}\n')
        previous = workspace.snapshot_python_sources(root)
        expected = previous.to_cache_dict()
        readers = {'full-rebuild': None, 'verified-identity-reuse': previous}
        samples = {mode: [] for mode in readers}
        for revision in range(repetitions):
            order = list(readers) if revision % 2 == 0 else list(reversed(readers))
            for mode in order:
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                result = workspace.snapshot_python_sources(root, previous_snapshot=readers[mode])
                sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert result.to_cache_dict() == expected and result.files == previous.files
                assert (result is previous) == (mode == 'verified-identity-reuse')
                sample['completeSnapshotEqual'] = True
                samples[mode].append(sample)
                del result
        counts = {}
        for mode in readers:
            original_stat = Path.stat
            stats = [0]

            def stat(path, *args, **kwargs):
                stats[0] += 1
                return original_stat(path, *args, **kwargs)

            with mock.patch.object(Path, 'stat', stat), \
                    mock.patch.object(workspace.os, 'walk', wraps=workspace.os.walk) as scan, \
                    mock.patch.object(workspace, '_file_fingerprint', wraps=workspace._file_fingerprint) as file_hash, \
                    mock.patch.object(workspace, '_build_directory_fingerprints', wraps=workspace._build_directory_fingerprints) as tree_hash:
                result = workspace.snapshot_python_sources(root, previous_snapshot=readers[mode])
            assert result.to_cache_dict() == expected
            counts[mode] = {'fileStats': stats[0], 'inventoryScans': scan.call_count,
                            'fileHashes': file_hash.call_count, 'directoryHashPasses': tree_hash.call_count}
            assert stats[0] == file_count and scan.call_count == 1
            assert file_hash.call_count == (file_count if mode == 'full-rebuild' else 0)
            assert tree_hash.call_count == (1 if mode == 'full-rebuild' else 0)
            del result
        allocation = {}
        for mode in readers:
            gc.collect()
            tracemalloc.start(1)
            result = workspace.snapshot_python_sources(root, previous_snapshot=readers[mode])
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert result.to_cache_dict() == expected
            allocation[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
            del result
        gc.collect()
        tracemalloc.start(1)
        fresh = workspace.snapshot_python_sources(root)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert fresh.to_cache_dict() == expected
        return {'pythonFiles': file_count, 'repetitions': repetitions, 'samples': samples,
            'operationCounts': counts, 'freshSnapshotIncludingIdentityEvidence': {'retainedBytes': retained, 'peakBytes': peak},
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                              **allocation[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Alternating9 complete current inventory and stat revalidations per tier; everyfile/order/entry/directory/rootfingerprint equal. Same8workers/64batches/full identity/stat and inventory counts; only repeated path/hash/entry/tree allocation avoided. Inprocess packed exact five-value identity records retained, not serialized or trusted from disk. Allocation samples separate, snapshot-only above existing baseline; freshsnapshot including identities shown separately. Excludes parse/runtime/RPC/Node/wholeheap/platform/slowFS/stablepercentage; host uncontrolled.'}, indent=2))
