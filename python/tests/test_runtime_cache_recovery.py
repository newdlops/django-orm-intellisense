"""Regression tests for self-healing runtime inspection cache entries."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from django_orm_intellisense.cache import store as cache_store
from django_orm_intellisense.cache.store import (
    CACHE_SCHEMA_VERSION,
    load_cached_runtime_inspection,
    save_runtime_inspection,
)
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)


SOURCE_FINGERPRINT = 'runtime-source-fingerprint'
SETTINGS_MODULE = 'project.settings'


def _ready_runtime(*, truncated: bool = False) -> RuntimeInspection:
    fields = [
        RuntimeFieldSummary(
            name='id',
            field_kind='AutoField',
            is_relation=False,
            related_model_label=None,
            direction=None,
        ),
    ]
    field_names = ['id']
    if not truncated:
        fields.append(
            RuntimeFieldSummary(
                name='name',
                field_kind='CharField',
                is_relation=False,
                related_model_label=None,
                direction=None,
            )
        )
        field_names.append('name')

    model = RuntimeModelSummary(
        label='app.Company',
        module='app.models',
        field_names=field_names,
        relation_names=[],
        reverse_relation_names=[],
        fields=fields,
        relations=[],
        manager_names=['objects'],
    )
    return RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True,
        django_version='5.0',
        bootstrap_status='ready',
        settings_module=SETTINGS_MODULE,
        bootstrap_error=None,
        app_count=1,
        model_count=1,
        # A truncated legacy payload can still retain the original counter.
        field_count=2,
        relation_count=0,
        reverse_relation_count=0,
        manager_count=1,
        model_catalog=[model],
        model_preview=[model],
    )


def _setup_failed_runtime() -> RuntimeInspection:
    return RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True,
        django_version='5.0',
        bootstrap_status='setup_failed',
        settings_module=SETTINGS_MODULE,
        bootstrap_error='ImportError: dependency is temporarily unavailable',
        app_count=0,
        model_count=0,
        field_count=0,
        relation_count=0,
        reverse_relation_count=0,
        manager_count=0,
        model_catalog=[],
        model_preview=[],
    )


class RuntimeCacheRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp_dir_ctx = tempfile.TemporaryDirectory()
        self._tmp_dir = Path(self._tmp_dir_ctx.name)
        self._workspace_root = self._tmp_dir / 'workspace'
        self._workspace_root.mkdir()
        cache_store.os.environ['DJANGO_ORM_INTELLISENSE_CACHE_DIR'] = str(
            self._tmp_dir / 'cache'
        )

    def tearDown(self) -> None:
        cache_store.os.environ.pop('DJANGO_ORM_INTELLISENSE_CACHE_DIR', None)
        self._tmp_dir_ctx.cleanup()

    @property
    def _cache_path(self) -> Path:
        return (
            cache_store._workspace_cache_dir(self._workspace_root)
            / cache_store.RUNTIME_CACHE_NAME
        )

    def _write_legacy_payload(self, runtime: RuntimeInspection) -> None:
        cache_store._write_cache_payload(
            self._cache_path,
            {
                'metadata': {
                    'schemaVersion': CACHE_SCHEMA_VERSION,
                    'workspaceRoot': str(self._workspace_root),
                    'sourceFingerprint': SOURCE_FINGERPRINT,
                    'settingsModule': SETTINGS_MODULE,
                    'environmentFingerprint': (
                        cache_store._runtime_environment_fingerprint()
                    ),
                    'createdAt': '2026-01-01T00:00:00+00:00',
                },
                'payload': runtime.to_cache_dict(),
            },
        )

    def test_ready_runtime_round_trip_remains_cacheable(self) -> None:
        runtime = _ready_runtime()
        save_runtime_inspection(
            self._workspace_root,
            SOURCE_FINGERPRINT,
            SETTINGS_MODULE,
            runtime,
        )

        loaded = load_cached_runtime_inspection(
            self._workspace_root,
            SOURCE_FINGERPRINT,
            SETTINGS_MODULE,
        )

        self.assertIsNotNone(loaded)
        self.assertEqual(
            [field.name for field in loaded.model_catalog[0].fields],
            ['id', 'name'],
        )

    def test_setup_failure_is_not_persisted(self) -> None:
        save_runtime_inspection(
            self._workspace_root,
            SOURCE_FINGERPRINT,
            SETTINGS_MODULE,
            _setup_failed_runtime(),
        )

        self.assertFalse(
            self._cache_path.exists(),
            'transient django.setup() failure must be retried on next launch',
        )

    def test_legacy_setup_failure_is_rejected_and_deleted(self) -> None:
        self._write_legacy_payload(_setup_failed_runtime())
        self.assertTrue(self._cache_path.exists())

        loaded = load_cached_runtime_inspection(
            self._workspace_root,
            SOURCE_FINGERPRINT,
            SETTINGS_MODULE,
        )

        self.assertIsNone(loaded)
        self.assertFalse(self._cache_path.exists())

    def test_truncated_ready_catalog_is_rejected_and_deleted(self) -> None:
        self._write_legacy_payload(_ready_runtime(truncated=True))

        loaded = load_cached_runtime_inspection(
            self._workspace_root,
            SOURCE_FINGERPRINT,
            SETTINGS_MODULE,
        )

        self.assertIsNone(loaded)
        self.assertFalse(
            self._cache_path.exists(),
            'a decoded but incomplete catalog must rebuild instead of pinning id/pk',
        )


if __name__ == '__main__':
    unittest.main()
