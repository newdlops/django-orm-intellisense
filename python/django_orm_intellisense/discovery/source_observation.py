"""Observation names are hints for invalidation, never additional source roots."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path

from .workspace import VenvInfo, find_editable_installs


def source_observation_context(workspace_root: Path, venv: VenvInfo | None) -> tuple[dict, str]:
    configuration: set[str] = set()
    records: dict[str, object] = {}
    memberships: dict[str, object] = {}

    def physical_name(path: Path) -> str:
        try:
            if path.is_symlink():
                value = os.readlink(path)
                return os.path.realpath(value if os.path.isabs(value) else str(path.parent) + os.sep + value)
        except OSError:
            pass
        return os.path.realpath(path)

    def observe(path: Path, *, content: bool = False) -> None:
        value_path = str(path)
        raw = value_path if os.path.isabs(value_path) else os.getcwd() + os.sep + value_path
        configuration.add(raw)
        physical = physical_name(Path(raw))
        configuration.add(physical)
        value = None
        try:
            entry = os.lstat(raw)
            identity = [stat.S_IFMT(entry.st_mode), entry.st_dev, entry.st_ino]
            if stat.S_ISDIR(entry.st_mode):
                identity.append(getattr(entry, 'st_birthtime_ns', getattr(entry, 'st_birthtime', None)))
            else:
                identity.extend([entry.st_size, entry.st_mtime_ns, entry.st_ctime_ns])
            value = {'identity': identity, 'physical': physical}
            if stat.S_ISLNK(entry.st_mode):
                value['link'] = os.readlink(raw)
                try:
                    target = os.stat(raw)
                    value['targetIdentity'] = [stat.S_IFMT(target.st_mode), target.st_dev, target.st_ino,
                        getattr(target, 'st_birthtime_ns', getattr(target, 'st_birthtime', None))]
                except OSError as error:
                    value['targetError'] = error.errno
            if content:
                descriptor = os.open(raw, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
                try:
                    opened = os.fstat(descriptor)
                    value['openedIdentity'] = [stat.S_IFMT(opened.st_mode), opened.st_dev, opened.st_ino,
                        opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns]
                    if stat.S_ISREG(opened.st_mode):
                        digest = hashlib.sha256()
                        while chunk := os.read(descriptor, 262144):
                            digest.update(chunk)
                        value['sha256'] = digest.hexdigest()
                    else:
                        value['nonRegularContent'] = stat.S_IFMT(opened.st_mode)
                finally:
                    os.close(descriptor)
            records[raw] = value
        except OSError as error:
            records[raw] = {**(value or {}), 'error': error.errno, 'physical': physical}
        # A raw parent link can move while every selected leaf name is unchanged.
        ancestor = Path(raw).parent
        while ancestor != ancestor.parent:
            if ancestor.parent == Path(ancestor.anchor):
                break
            try:
                entry = ancestor.lstat()
                if stat.S_ISLNK(entry.st_mode):
                    configuration.add(str(ancestor))
                    records[str(ancestor)] = {'link': os.readlink(ancestor),
                        'identity': [entry.st_dev, entry.st_ino, entry.st_size,
                                     entry.st_mtime_ns, entry.st_ctime_ns],
                        'physical': physical_name(ancestor)}
            except OSError:
                pass
            ancestor = ancestor.parent

    for name in ('.venv', 'venv', '.env', 'env'):
        observe(workspace_root / name / 'pyvenv.cfg', content=True)
    roots = [{'raw': str(workspace_root), 'canonical': os.path.realpath(workspace_root)}]
    sites: list[str] = []
    if venv is not None:
        observe(Path(venv.root) / 'pyvenv.cfg', content=True)
        if venv.site_packages:
            packages = Path(venv.site_packages)
            observe(packages)
            sites.append(os.path.realpath(packages))
            try:
                with os.scandir(packages) as entries:
                    names = sorted(entry.name for entry in entries)
                memberships[str(packages)] = names
                for name in names:
                    if name.endswith('.dist-info'):
                        observe(packages / name)
                        observe(packages / name / 'direct_url.json', content=True)
                    elif name.endswith(('.egg-link', '.pth')):
                        observe(packages / name, content=True)
            except OSError as error:
                memberships[str(packages)] = {'error': error.errno}
            # Missing declarations remain observation names so their later
            # restoration can trigger discovery without granting source access.
            for editable in find_editable_installs(str(packages), include_missing_targets=True):
                observe(Path(editable.path))
        for editable in venv.editable_installs:
            raw = editable.path
            observe(Path(raw))
            roots.append({'raw': raw, 'canonical': os.path.realpath(raw)})
    context = {'version': 1, 'configurationFiles': sorted(configuration),
               'sitePackages': sorted(set(sites)), 'roots': roots}
    fingerprint = hashlib.sha256(json.dumps({'context': context, 'records': records, 'memberships': memberships},
        sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    return context, fingerprint
