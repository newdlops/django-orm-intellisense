"""Bounded, source-bound JSON restart records for independent registries."""
from __future__ import annotations

from dataclasses import replace
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile

from . import store
from . import runtime_member_records as member_records
from ..features.orm_members import fingerprint_surface_index, runtime_member_snapshot_is_complete
from ..launch_environment import fingerprint_environment
from ..runtime.inspector import RuntimeInspection
from ..runtime.lookup_catalog import lookup_catalog_json_default
from ..runtime.project_inputs import input_identity, inputs_match
from ..runtime.projects import ProjectRuntime, copy_source_index, scope_source_index, project_source_projection
from ..static_index.indexer import build_static_index

VERSION = 1
MAX_PROFILES = 64
MAX_RECORD_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024


def analysis_code_fingerprint():
    root = Path(__file__).resolve().parents[1]
    digest = sha256()
    for path in sorted(root.rglob('*.py')):
        digest.update(path.relative_to(root).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


try:
    _CODE_AT_IMPORT = analysis_code_fingerprint()
except OSError:
    _CODE_AT_IMPORT = None


def _digest(value):
    digest = sha256()
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    class HashWriter:
        def write(self, chunk):
            digest.update(chunk.encode('ascii'))
    store._write_cache_json_value(HashWriter(), value, encoder, 0)
    return digest.hexdigest()


class ProjectRuntimeCache:
    def __init__(self, root, projects, snapshot, configuration):
        self.root, self.projects, self.snapshot = Path(root), tuple(projects), snapshot
        self.directory = store._workspace_cache_dir(self.root) / 'projects-v1'
        self.slots = {project.namespace: number for number, project in enumerate(projects[:MAX_PROFILES])}
        try:
            code = analysis_code_fingerprint()
        except OSError:
            code = None
        if code is None or code != _CODE_AT_IMPORT:
            # Running modules are not reloaded when their files change.
            # Such a process must not label an old parse with new code.
            self.slots.clear()
        self.code = code
        self.environment = fingerprint_environment({key: value for key, value in os.environ.items()
            if key != 'DJANGO_SETTINGS_MODULE'})
        self.python = [sys.executable, sys.version, sys.prefix, input_identity(sys.executable)]
        self.context = _digest({'version': VERSION, 'sources': snapshot.fingerprint,
            'projects': [project.to_dict() for project in projects], 'configuration': configuration,
            'environment': self.environment, 'code': code,
            'python': self.python,
            'sysPath': sys.path})

    def context_current(self):
        try:
            return (self.code == _CODE_AT_IMPORT == analysis_code_fingerprint()
                and [sys.executable, sys.version, sys.prefix, input_identity(sys.executable)] == self.python
                and fingerprint_environment({key: value for key, value in os.environ.items()
                    if key != 'DJANGO_SETTINGS_MODULE'}) == self.environment)
        except OSError:
            return False

    def _path(self, project, kind):
        number = self.slots.get(project.namespace)
        return None if number is None else self.directory / f'{kind}-{number:03}.json'

    def _read(self, path):
        try:
            if path is None or path.stat().st_size > MAX_RECORD_BYTES:
                return None
            with path.open(encoding='utf-8') as stream:
                payload = json.load(stream)
            if (type(payload) is not dict or payload.get('context') != self.context
                    or _digest(payload['record']) != payload['digest']):
                return None
            return payload['record']
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            return None

    def _write(self, path, record, current, validate=lambda: True):
        if path is None or not current():
            return
        try:
            payload = {'context': self.context, 'record': record, 'digest': _digest(record)}
            encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
            return self._commit(path, lambda stream: store._write_cache_json_value(stream, payload, encoder, 0),
                current, validate)
        except (ValueError, TypeError):
            return

    def _commit(self, path, write, current, validate=lambda: True):
        if path is None or not current():
            return
        temporary = None
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            entries = [*self.directory.glob('*.json'), *self.directory.glob('*.tmp')]
            total = sum(item.stat().st_size for item in entries if item != path)
            if total >= MAX_TOTAL_BYTES or sum(item.suffix == '.tmp' for item in entries) >= MAX_PROFILES * 2:
                return
            with tempfile.NamedTemporaryFile(mode='w', encoding='ascii', prefix='.record-', suffix='.tmp',
                    dir=self.directory, delete=False) as stream:
                temporary = Path(stream.name)
                class BoundedWriter:
                    size = 0
                    def write(self, chunk):
                        self.size += len(chunk)
                        if self.size > MAX_RECORD_BYTES or total + self.size > MAX_TOTAL_BYTES or not current():
                            raise OSError('Project cache write stopped or exceeded its budget.')
                        return stream.write(chunk)
                write(BoundedWriter())
            if current() and validate():
                temporary.replace(path)
                return True
        except (OSError, ValueError, TypeError):
            return
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def load_static(self, project, snapshot, roots):
        record = self._read(self._path(project, 'static'))
        if record is None:
            return None
        path = self._path(project, 'seed')
        try:
            if record != [str(path), input_identity(path)]:
                return None
            if path.stat().st_size > MAX_RECORD_BYTES:
                return None
            return store._try_load_full_static_index(Path(project.import_root), snapshot,
                import_roots=roots, cache_path=path)
        except (OSError, ValueError, TypeError):
            return None

    def save_static(self, project, snapshot, static, current):
        if self._path(project, 'static') is None or not current():
            return
        path = self._path(project, 'seed')
        saved = False
        def save(selected, payload):
            nonlocal saved
            if selected.name == store.STATIC_INDEX_FULL_CACHE_NAME:
                encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
                saved = self._commit(path, lambda stream: store._write_cache_json_value(stream, payload, encoder, 0), current)
        try:
            with tempfile.TemporaryFile(mode='w+b') as spool:
                store._save_static_index_spooled(Path(project.import_root), snapshot, static, spool, write_payload=save)
        except OSError:
            return
        if saved:
            self._write(self._path(project, 'static'), [str(path), input_identity(path)], current)

    def load(self, project, static, roots):
        record = self._read(self._path(project, 'profile'))
        if record is None:
            return None
        try:
            if record['project'] != project.to_dict() or not inputs_match(record['inputs']):
                return None
            files = tuple(Path(path) for path in record['staticFiles'])
            if not set(files).issubset(self.snapshot.files):
                return None
            covered = {Path(module.file_path) for module in static.modules.values()}
            covered.update(Path(project.import_root) / path for path in (*static.unparseable_files, *static.shadowed_files))
            owned = (copy_source_index(static) if set(files).issubset(covered) else
                build_static_index(Path(project.import_root), python_files=files, import_roots=roots))
            runtime = replace(RuntimeInspection.from_cache_dict(record['runtime']), detached=True)
            if (runtime.bootstrap_status != 'ready' or runtime.settings_module != project.settings_module
                    or runtime.python_executable != sys.executable or not store._runtime_inspection_is_cacheable(runtime)):
                return None
            owned = scope_source_index(owned, runtime)
            graph = store._model_graph_from_cache_dict(record['graph'], static_index=owned,
                runtime_inspection=runtime, _field_rows=True)
            members = member_records.restore_snapshot(record['members'], record['memberIdentity'],
                expected_identity=(runtime.python_executable, runtime.settings_module, runtime.django_version),
                expected_fingerprint=record['memberFingerprint'])
            if not runtime_member_snapshot_is_complete(owned, runtime, graph, members):
                return None
            owned._runtime_member_snapshot = members
            surface, fingerprints = record['surface'], record['fingerprints']
            if (fingerprint_surface_index(surface) != fingerprints
                    or store._surface_index_cache_problem(surface, static_index=owned, model_graph=graph)):
                return None
            dependencies = tuple(record['dependencies'])
            if not set(dependencies).issubset(project.namespace for project in self.projects):
                return None
            from ..runtime.projects import project_owner
            proof_files = tuple(path for path in self.snapshot.files
                if (owner := project_owner(self.projects, path)) is None or owner.namespace in dependencies)
            proof = project_source_projection(Path(project.import_root), self.snapshot, proof_files)
            return ProjectRuntime(project, owned, runtime, graph, members, surface, fingerprints, proof,
                dependencies=dependencies, app_names=tuple(record['appNames']), cache_inputs=record['inputs'])
        except (OSError, ValueError, TypeError, KeyError, AttributeError, IndexError):
            return None

    def save(self, value, current):
        try:
            self._save(value, current)
        except (OSError, ValueError, TypeError, KeyError):
            return

    def _save(self, value, current):
        if (not isinstance(value, ProjectRuntime) or value.inspection.bootstrap_status != 'ready'
                or value.members is None or value.cache_inputs is None or not inputs_match(value.cache_inputs)
                or value.cache_code != self.code or value.cache_python != self.python
                or value.cache_environment != self.environment
                or not store._runtime_inspection_is_cacheable(value.inspection)
                or value.model_graph.static_field_overrides):
            return
        labels, row = member_records.snapshot_rows(value.members)
        members = {label: row(label) for label in labels}
        files = {module.file_path for module in value.static_index.modules.values()}
        files.update(str(Path(value.project.import_root) / path)
            for path in (*value.static_index.unparseable_files, *value.static_index.shadowed_files))
        record = {'project': value.project.to_dict(), 'inputs': value.cache_inputs,
            'staticFiles': sorted(files), 'runtime': value.inspection.to_cache_dict(),
            'graph': store._model_graph_to_cache_dict(value.model_graph, _field_rows=True),
            'members': members, 'memberIdentity': value.members.runtime_identity,
            'memberFingerprint': member_records.fingerprint_digests({label: member_records.row_digest(item)
                for label, item in members.items()}), 'surface': value.surface, 'fingerprints': value.fingerprints,
            'dependencies': value.dependencies, 'appNames': value.app_names}
        self._write(self._path(value.project, 'profile'), record, current,
            lambda: inputs_match(value.cache_inputs) and self.context_current())
