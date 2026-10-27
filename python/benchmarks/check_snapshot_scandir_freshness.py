"""Prove whether DirEntry type checks can cache metadata before validation."""
import json
import os
import tempfile
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_scandir_candidate import snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded
from django_orm_intellisense.discovery import workspace


rows = []
for call in [snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded]:
    with tempfile.TemporaryDirectory(prefix='djls-scandir-stale-stat-') as temporary:
        root = Path(temporary).resolve()
        target = root / 'target.txt'
        target.write_text('kind="CharField"\n')
        link = root / 'models.py'
        link.symlink_to(target)
        previous = workspace.snapshot_python_sources(root, max_workers=1)
        original = os.scandir
        changed = [False]

        class Entry:
            def __init__(self, entry): self.entry = entry
            def __getattr__(self, name): return getattr(self.entry, name)
            def is_dir(self, *args, **kwargs):
                result = self.entry.is_dir(*args, **kwargs)
                if self.entry.path == str(link) and not changed[0]:
                    stamp = target.stat()
                    target.write_text('kind="DateField"\n')
                    os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                    changed[0] = True
                return result

        class Scan:
            def __init__(self, folder): self.inner = original(folder)
            def __iter__(self): return self
            def __next__(self): return Entry(next(self.inner))
            def __enter__(self): return self
            def __exit__(self, *args): self.inner.close()

        with mock.patch.object(os, 'scandir', Scan):
            actual = call(root, max_workers=1, previous_snapshot=previous)
        fresh = workspace.snapshot_python_sources(root, max_workers=1)
        rows.append({'candidate': call.__name__, 'editAfterSymlinkTypeLookup': changed[0],
            'reusedStaleOwner': actual is previous, 'matchesFreshCurrentSource': actual.to_cache_dict() == fresh.to_cache_dict()})
assert all(row['editAfterSymlinkTypeLookup'] for row in rows)
print(json.dumps({'candidateOnly': True, 'rows': rows,
    'scope': 'Real symlink-backed source is changed with restored size/mtime after actual DirEntry.is_dir. Detects reuse of cached stat before current source identity validation; no production changes.'}, indent=2))
