"""Candidate-only fresh scandir membership/stat collection for revalidation."""
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from collections import deque

from django_orm_intellisense.discovery import workspace


def snapshot_scandir(root, extra_roots=None, *, max_workers=8, previous_snapshot=None):
    if (os.name != 'posix' or previous_snapshot is None or previous_snapshot.root != str(root)
            or previous_snapshot._file_identities is None
            or any(os.path.normpath(str(folder)) != str(folder) for folder in (root, *(extra_roots or ())))):
        return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
            previous_snapshot=previous_snapshot)
    expected = {str(path): identity for path, identity in zip(
        previous_snapshot.files, previous_snapshot._file_identities)}
    observed = set()
    unchanged = True

    def walk(folder):
        nonlocal unchanged
        try:
            with os.scandir(folder) as items:
                for item in items:
                    try:
                        directory = item.is_dir()
                    except OSError:
                        directory = False
                    if directory:
                        if item.name not in workspace.SKIP_DIRS and not item.name.startswith('.') and not item.is_symlink():
                            walk(item.path)
                        continue
                    if not item.name.endswith('.py'):
                        continue
                    try:
                        identity = workspace._source_stat_identity(os.stat(item.path))
                        if expected.get(item.path) != identity:
                            unchanged = False
                        observed.add(item.path)
                    except OSError:
                        continue
        except OSError:
            return

    try:
        for folder in dict.fromkeys((root, *(extra_roots or ()))):
            walk(folder)
        same = unchanged and observed == expected.keys()
    finally:
        # Recursive closure must not retain source membership until cyclic GC.
        walk = None
        expected.clear()
        observed.clear()
    if same:
        return previous_snapshot
    # Changed membership/metadata always delegates to complete ordinary scan
    # and fingerprint logic; the candidate makes no stale inventory shortcut.
    return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
        previous_snapshot=previous_snapshot)


def snapshot_scandir_parallel(root, extra_roots=None, *, max_workers=8, previous_snapshot=None):
    if (os.name != 'posix' or previous_snapshot is None or previous_snapshot.root != str(root)
            or previous_snapshot._file_identities is None
            or any(os.path.normpath(str(folder)) != str(folder) for folder in (root, *(extra_roots or ())))):
        return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
            previous_snapshot=previous_snapshot)
    expected = {str(path): identity for path, identity in zip(
        previous_snapshot.files, previous_snapshot._file_identities)}
    sources = set()
    pending = list(dict.fromkeys((root, *(extra_roots or ()))))
    while pending:
        folder = pending.pop()
        try:
            with os.scandir(folder) as items:
                for item in items:
                    try:
                        directory = item.is_dir()
                    except OSError:
                        directory = False
                    if directory:
                        if item.name not in workspace.SKIP_DIRS and not item.name.startswith('.') and not item.is_symlink():
                            pending.append(item.path)
                    elif item.name.endswith('.py'):
                        sources.add(item.path)
        except OSError:
            continue
    observed = set()
    values = list(sources)

    def check_batch(offset):
        result = []
        for source in values[offset:offset+64]:
            try:
                identity = workspace._source_stat_identity(os.stat(source))
            except OSError:
                continue
            result.append((source, identity == expected.get(source)))
        return result

    unchanged = True
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for batch in executor.map(check_batch, range(0, len(values), 64)):
            for source, same in batch:
                unchanged = unchanged and same
                observed.add(source)
    same = unchanged and observed == expected.keys()
    sources.clear()
    expected.clear()
    observed.clear()
    values.clear()
    if same:
        return previous_snapshot
    return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
        previous_snapshot=previous_snapshot)


def snapshot_scandir_bounded(root, extra_roots=None, *, max_workers=8, previous_snapshot=None):
    if (os.name != 'posix' or previous_snapshot is None or previous_snapshot.root != str(root)
            or previous_snapshot._file_identities is None
            or any(os.path.normpath(str(folder)) != str(folder) for folder in (root, *(extra_roots or ())))):
        return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
            previous_snapshot=previous_snapshot)
    expected = {str(path): number for number, path in enumerate(previous_snapshot.files)}
    observed = bytearray(len(expected))
    identities = previous_snapshot._file_identities

    def batches():
        folders = list(dict.fromkeys((root, *(extra_roots or ()))))
        batch = []
        while folders:
            folder = folders.pop()
            try:
                with os.scandir(folder) as items:
                    for item in items:
                        try:
                            directory = item.is_dir()
                        except OSError:
                            directory = False
                        if directory:
                            if item.name not in workspace.SKIP_DIRS and not item.name.startswith('.') and not item.is_symlink():
                                folders.append(item.path)
                        elif item.name.endswith('.py'):
                            batch.append(item.path)
                            if len(batch) == 64:
                                yield batch
                                batch = []
            except OSError:
                continue
        if batch:
            yield batch

    def check(batch):
        result = []
        for source in batch:
            try:
                identity = workspace._source_stat_identity(os.stat(source))
            except OSError:
                result.append((None, False))
                continue
            number = expected.get(source)
            result.append((number, number is not None and identity == identities[number]))
        return result

    unchanged = True
    iterator = batches()
    waiting = deque()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            exhausted = False
            while waiting or not exhausted:
                while not exhausted and len(waiting) < max(1, max_workers*2):
                    try:
                        batch = next(iterator)
                    except StopIteration:
                        exhausted = True
                        break
                    waiting.append(executor.submit(check, batch))
                if waiting:
                    for number, same in waiting.popleft().result():
                        unchanged = unchanged and same
                        if number is not None:
                            observed[number] = 1
        same = unchanged and all(observed)
    finally:
        iterator.close()
        expected.clear()
        observed.clear()
    if same:
        return previous_snapshot
    return workspace.snapshot_python_sources(root, extra_roots, max_workers=max_workers,
        previous_snapshot=previous_snapshot)
