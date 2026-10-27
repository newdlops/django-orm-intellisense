"""Candidate-only ordinary source oracle for complete membership/path cases."""
import json
import os
import tempfile
from pathlib import Path

from benchmarks.snapshot_scandir_candidate import snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded
from django_orm_intellisense.discovery import workspace


checks = []
for call in [snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded]:
    with tempfile.TemporaryDirectory(prefix='djls-scandir-contracts-') as temporary:
        base = Path(temporary).resolve()
        root, external = base / 'workspace', base / 'library'
        root.mkdir()
        external.mkdir()
        (root / 'a').mkdir()
        (root / 'a.py').write_text('a=1\n')
        (root / 'a' / '한글.py').write_text('b=2\n')
        (external / 'model.py').write_text('c=3\n')
        hidden = root / '.hidden'
        hidden.mkdir()
        (hidden / 'ignored.py').write_text('ignored=True\n')
        (root / 'dir-link').symlink_to(external, target_is_directory=True)
        (root / 'file-link.py').symlink_to(external / 'model.py')
        previous = workspace.snapshot_python_sources(root, [external])

        def verify(label, roots=None, old=None):
            roots = [external] if roots is None else roots
            result = call(root, roots, max_workers=2, previous_snapshot=old or previous)
            expected = workspace.snapshot_python_sources(root, roots, max_workers=2)
            assert result.to_cache_dict() == expected.to_cache_dict() and result.files == expected.files, label
            checks.append({'candidate': call.__name__, 'case': label, 'fullSourceOracleEqual': True})
            return result

        assert verify('unchanged') is previous
        source = root / 'a.py'
        stamp = source.stat()
        source.write_text('a=2\n')
        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        previous = verify('equal-size-restored-mtime')
        (root / 'new.py').write_text('new=True\n')
        previous = verify('creation')
        (root / 'new.py').rename(root / 'renamed.py')
        previous = verify('rename')
        (root / 'renamed.py').unlink()
        previous = verify('deletion')
        (external / 'model.py').write_text('c=4\n')
        previous = verify('editable-change')
        previous = verify('editable-revoked', [])
        restored = workspace.PythonSourceSnapshot.from_cache_dict(previous.to_cache_dict())
        verify('deserialized-owner-full-scan', [], restored)
        verify('overlapping-roots', [root, root / 'a', source, root])
        for lexical in [Path(os.path.relpath(root)), root / '..' / 'workspace']:
            old = workspace.snapshot_python_sources(lexical)
            result = call(lexical, previous_snapshot=old)
            expected = workspace.snapshot_python_sources(lexical)
            assert result.to_cache_dict() == expected.to_cache_dict() and result.files == expected.files
            checks.append({'candidate': call.__name__, 'case': 'lexical-fallback', 'fullSourceOracleEqual': True})
print(json.dumps({'candidateOnly': True, 'cases': len(checks), 'checks': checks,
    'scope': 'Candidate source membership/identity/path oracle against ordinary full current scan: edits/create/delete/rename/editable/revoked/overlap/symlink/lexical/deserialized cases. No production integration or concurrent late-file/runtime races claim.'}, indent=2))
