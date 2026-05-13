"""E1 reproducing E2E — runtime registry build mode env switch.

captain 첫 cycle django.setup() 8.3s 폭주 → GIL contention 부분 (queue_wait=404ms
관찰). DJLS_RUNTIME_REGISTRY_MODE 로 build 자체 우회 가능:
  - full (기본): 기존 동작 — django.setup + enumerate_fields
  - skip: build 즉시 skip, registry 비어 유지, fallback path
  - subprocess: 별도 OS process 에서 build, 결과 transfer 안 함, GIL 영향 0

트레이드오프: registry 비어 있으면 lookup_paths 의 transform chain 인식 안 됨.
captain 일반 lookup 은 단순 operator (`__lte`, `__gte` 등) 이라 fallback 으로 충분.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_runtime_registry_mode -v
"""
from __future__ import annotations

import io
import os
import time
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from django_orm_intellisense.runtime import inspector


class RuntimeRegistryModeTest(unittest.TestCase):
    def setUp(self) -> None:
        # 모든 테스트 격리: registry state reset
        inspector._RUNTIME_FIELD_REGISTRY = {}
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = None
        inspector._RUNTIME_FIELD_REGISTRY_READY = False

    def test_full_mode_calls_locked_build(self) -> None:
        """default 'full' 모드 — _ensure_runtime_field_registry_locked 호출."""
        called: list[str | None] = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )
        try:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop('DJLS_RUNTIME_REGISTRY_MODE', None)
                inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(
            called, ['myapp.settings'],
            'full 모드(기본)는 locked build 호출되어야 함',
        )

    def test_skip_mode_does_not_build_registry(self) -> None:
        """'skip' 모드 — locked build 호출 안 됨, registry 비어 유지, ready 마크."""
        called: list[str | None] = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )
        try:
            with patch.dict(os.environ, {'DJLS_RUNTIME_REGISTRY_MODE': 'skip'}):
                captured = io.StringIO()
                with redirect_stderr(captured):
                    inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(
            called, [],
            'skip 모드는 locked build 우회 — django.setup() 호출 안 함',
        )
        self.assertTrue(
            inspector._RUNTIME_FIELD_REGISTRY_READY,
            'skip 모드도 ready=True 마크 — 후속 호출에서 fast-path 진입',
        )
        self.assertEqual(
            inspector._RUNTIME_FIELD_REGISTRY, {},
            'registry 비어 유지 — get_runtime_field 호출 시 None 반환 → fallback',
        )
        # 로그 마커 확인
        self.assertIn(
            '[runtime:registry-skipped]',
            captured.getvalue(),
            '진단 로그 emit 되어야 captain 분석 시 mode 확인 가능',
        )
        self.assertIn(
            'mode=skip',
            captured.getvalue(),
        )

    def test_subprocess_mode_spawns_process(self) -> None:
        """'subprocess' 모드 — multiprocessing.Process 시작 + main 은 즉시 return."""
        spawn_called: list[str] = []
        original_spawn = inspector._spawn_registry_build_subprocess
        inspector._spawn_registry_build_subprocess = (
            lambda sm: spawn_called.append(sm)
        )

        called: list[str | None] = []
        original_locked = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )

        try:
            with patch.dict(
                os.environ, {'DJLS_RUNTIME_REGISTRY_MODE': 'subprocess'},
            ):
                start = time.perf_counter()
                inspector._ensure_runtime_field_registry('myapp.settings')
                elapsed_ms = (time.perf_counter() - start) * 1000
        finally:
            inspector._spawn_registry_build_subprocess = original_spawn
            inspector._ensure_runtime_field_registry_locked = original_locked

        self.assertEqual(spawn_called, ['myapp.settings'])
        self.assertEqual(
            called, [],
            'subprocess 모드도 main 측 locked build 호출 안 함',
        )
        self.assertLess(
            elapsed_ms, 100,
            f'subprocess 모드는 main 측에서 spawn 호출만 — 즉시 return. '
            f'실측 {elapsed_ms:.1f}ms',
        )

    def test_unknown_mode_falls_back_to_full(self) -> None:
        """알 수 없는 mode 값은 full 모드로 처리 — env 오타 대비."""
        called: list[str | None] = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )
        try:
            with patch.dict(
                os.environ, {'DJLS_RUNTIME_REGISTRY_MODE': 'invalid-value'},
            ):
                inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(
            called, ['myapp.settings'],
            '알 수 없는 mode 는 full 로 fallback (안전한 default)',
        )

    def test_skip_mode_fast_path_when_already_ready(self) -> None:
        """skip 모드도 fast-path 작동 — 두 번째 호출에서 spawn / mark 안 함."""
        inspector._RUNTIME_FIELD_REGISTRY_READY = True
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = 'myapp.settings'

        called: list[str | None] = []
        original = inspector._mark_registry_skipped
        inspector._mark_registry_skipped = (
            lambda sm, *, mode: called.append((sm, mode))  # type: ignore[func-returns-value]
        )
        try:
            with patch.dict(os.environ, {'DJLS_RUNTIME_REGISTRY_MODE': 'skip'}):
                inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._mark_registry_skipped = original

        self.assertEqual(
            called, [],
            'ready 상태에서 호출하면 _mark_registry_skipped 도 안 부름',
        )


if __name__ == '__main__':
    unittest.main()
