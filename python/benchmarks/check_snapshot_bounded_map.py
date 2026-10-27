"""Candidate source oracle, bounded slow-first ordering and executor cleanup."""
import json
import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from benchmarks.snapshot_bounded_map_candidate import candidate_module, bounded_batches
from django_orm_intellisense.discovery import workspace


candidate = candidate_module()
checks = []
with tempfile.TemporaryDirectory(prefix='djls-bounded-map-contracts-') as temporary:
    base = Path(temporary).resolve()
    root, external = base / 'workspace', base / 'library'
    root.mkdir()
    external.mkdir()
    (root / 'a').mkdir()
    source = root / 'a.py'
    source.write_text('a=1\n')
    (root / 'a' / '한글.py').write_text('b=2\n')
    (external / 'model.py').write_text('c=3\n')
    (root / 'file-link.py').symlink_to(external / 'model.py')
    (root / 'dir-link').symlink_to(external, target_is_directory=True)
    previous = workspace.snapshot_python_sources(root, [external])

    def verify(label, roots=None, owner=None):
        roots = [external] if roots is None else roots
        current = candidate.snapshot_python_sources(root, roots, previous_snapshot=owner or previous)
        full = workspace.snapshot_python_sources(root, roots)
        assert current.to_cache_dict() == full.to_cache_dict() and current.files == full.files
        checks.append(label)
        return current

    assert verify('unchanged') is previous
    stamp = source.stat()
    source.write_text('a=2\n')
    os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    previous = verify('equal-size-restored-mtime')
    (root / 'new.py').write_text('value=1\n')
    previous = verify('create')
    (root / 'new.py').rename(root / 'renamed.py')
    previous = verify('rename')
    (root / 'renamed.py').unlink()
    previous = verify('delete')
    (external / 'model.py').write_text('c=4\n')
    previous = verify('editable-change')
    previous = verify('editable-revocation', [])
    restored = workspace.PythonSourceSnapshot.from_cache_dict(previous.to_cache_dict())
    verify('deserialized-full-stat', [], restored)
    verify('overlapping-roots', [root, root / 'a', source, root])
    for lexical in [Path(os.path.relpath(root)), root / '..' / 'workspace']:
        old = workspace.snapshot_python_sources(lexical)
        result = candidate.snapshot_python_sources(lexical, previous_snapshot=old)
        assert result.to_cache_dict() == workspace.snapshot_python_sources(lexical).to_cache_dict()
        checks.append('lexical-root')

submitted = []
entered = threading.Event()
release = threading.Event()
done = threading.Event()
result = []
errors = []


class Executor:
    def __init__(self, real): self.real = real
    def submit(self, function, offset):
        submitted.append(offset)
        if len(submitted) == 16: entered.set()
        return self.real.submit(function, offset)


def work(offset):
    if offset == 0:
        assert release.wait(timeout=5)
    return offset


with ThreadPoolExecutor(max_workers=8) as real:
    def consume():
        try: result.extend(bounded_batches(Executor(real), work, range(100), 16))
        except BaseException as error: errors.append(error)
        finally: done.set()
    thread = threading.Thread(target=consume)
    thread.start()
    try:
        assert entered.wait(timeout=5)
        assert submitted == list(range(16)), 'Slow first batch did not bound later queued results'
    finally:
        release.set()
    assert done.wait(timeout=5)
    thread.join()
assert not errors and result == list(range(100))
exception_propagated = False
with ThreadPoolExecutor(max_workers=2) as real:
    def fail(offset):
        if offset == 3: raise RuntimeError('expected batch failure')
        return offset
    try: list(bounded_batches(real, fail, range(10), 4))
    except RuntimeError as error:
        assert str(error) == 'expected batch failure'
        exception_propagated = True
assert exception_propagated
print(json.dumps({'candidateOnly': True, 'sourceOracleCases': len(checks), 'sourceChecks': checks,
    'slowFirstBatchSubmissionLimit': 16, 'orderedResults': 100, 'exceptionPropagatedAndExecutorExited': True,
    'passed': True, 'scope': 'Candidate completecurrent source/path/identity oracle plusactualslowfirst8threadbatch max16submission/ordered100results andexceptioncleanup. No production/Windows/allraces/realnetworkFS claim.'}))
