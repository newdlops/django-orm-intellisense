"""Benchmark-only static serialization with one module conversion and a spool."""
import json
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default


@dataclass
class JsonRecordMap:
    keys: object
    record: object


def previous_save_static_index(workspace_root, source_snapshot, static_index):
    entries = source_snapshot.entries_by_path
    serialized = static_index.to_cache_dict()
    modules = {}
    for name, module in static_index.modules.items():
        try:
            relative = Path(module.file_path).relative_to(workspace_root).as_posix()
        except ValueError:
            relative = module.file_path
        entry = entries.get(relative)
        if entry is not None:
            modules[relative] = {'fileFingerprint': entry.fingerprint, 'moduleIndex': serialized['modules'][name]}
    unparseable = {relative: {'fileFingerprint': entries[relative].fingerprint, 'errorKind': error}
                  for relative, error in static_index.unparseable_files.items() if relative in entries}
    store._write_cache_payload(store._workspace_cache_dir(workspace_root) / store.STATIC_INDEX_CACHE_NAME, {
        'metadata': {'schemaVersion': store.CACHE_SCHEMA_VERSION, 'workspaceRoot': str(workspace_root),
                     'rootTreeFingerprint': source_snapshot.fingerprint, 'createdAt': datetime.now(timezone.utc).isoformat()},
        'payload': {'directoryFingerprints': source_snapshot.directory_fingerprints,
                    'moduleEntries': modules, 'unparseableEntries': unparseable}})
    store._write_cache_payload(store._workspace_cache_dir(workspace_root) / store.STATIC_INDEX_FULL_CACHE_NAME, {
        'metadata': {'schemaVersion': store.CACHE_SCHEMA_VERSION, 'workspaceRoot': str(workspace_root),
                     'rootTreeFingerprint': source_snapshot.fingerprint, 'createdAt': datetime.now(timezone.utc).isoformat()},
        'payload': serialized})


def record_writer(original):
    def write(stream, value, encoder, depth):
        if type(value) is JsonRecordMap:
            keys = sorted(value.keys)
            stream.write('{')
            for offset in range(0, len(keys), 64):
                if offset:
                    stream.write(', ')
                stream.write(', '.join(encoder.encode(key) + ': ' + value.record(key)
                                      for key in keys[offset:offset + 64]))
            stream.write('}')
        else:
            original(stream, value, encoder, depth)
    return write


def save_static_spooled(workspace_root, source_snapshot, static_index):
    entries = source_snapshot.entries_by_path
    module_entries = {}
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    with tempfile.TemporaryFile(mode='w+b') as spool:
        offsets = {}
        for name, module in static_index.modules.items():
            encoded = encoder.encode(module.to_dict()).encode('utf-8')
            offset = spool.tell()
            spool.write(encoded)
            offsets[name] = (offset, len(encoded))
            try:
                relative = Path(module.file_path).relative_to(workspace_root).as_posix()
            except ValueError:
                relative = module.file_path
            entry = entries.get(relative)
            if entry is not None:
                module_entries[relative] = (name, entry.fingerprint)
        spool.flush()

        def module_json(name):
            offset, size = offsets[name]
            spool.seek(offset)
            raw = spool.read(size)
            if len(raw) != size:
                raise OSError('Incomplete serialized static module spool')
            return raw.decode('utf-8')

        def module_entry_json(relative):
            name, fingerprint = module_entries[relative]
            return '{"fileFingerprint": ' + encoder.encode(fingerprint) + ', "moduleIndex": ' + module_json(name) + '}'

        unparseable = {relative: {'fileFingerprint': entries[relative].fingerprint, 'errorKind': error}
                      for relative, error in static_index.unparseable_files.items() if relative in entries}
        store._write_cache_payload(store._workspace_cache_dir(workspace_root) / store.STATIC_INDEX_CACHE_NAME, {
            'metadata': {'schemaVersion': store.CACHE_SCHEMA_VERSION, 'workspaceRoot': str(workspace_root),
                         'rootTreeFingerprint': source_snapshot.fingerprint,
                         'createdAt': datetime.now(timezone.utc).isoformat()},
            'payload': {'directoryFingerprints': source_snapshot.directory_fingerprints,
                        'moduleEntries': JsonRecordMap(module_entries, module_entry_json),
                        'unparseableEntries': unparseable}})
        full = {'pythonFileCount': static_index.python_file_count, 'packageInitCount': static_index.package_init_count,
            'reexportModuleCount': static_index.reexport_module_count, 'starImportCount': static_index.star_import_count,
            'explicitAllCount': static_index.explicit_all_count,
            'modules': JsonRecordMap(static_index.modules, module_json),
            'modelCandidates': [candidate.to_dict() for candidate in static_index.model_candidates],
            'unparseableFiles': dict(static_index.unparseable_files), 'shadowedFiles': dict(static_index.shadowed_files)}
        store._write_cache_payload(store._workspace_cache_dir(workspace_root) / store.STATIC_INDEX_FULL_CACHE_NAME, {
            'metadata': {'schemaVersion': store.CACHE_SCHEMA_VERSION, 'workspaceRoot': str(workspace_root),
                         'rootTreeFingerprint': source_snapshot.fingerprint,
                         'createdAt': datetime.now(timezone.utc).isoformat()}, 'payload': full})
