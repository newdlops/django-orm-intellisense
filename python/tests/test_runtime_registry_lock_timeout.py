"""E1+ reproducing E2E — runtime registry lock 자동 timeout fallback.

captain log.txt L191-193:
    [runtime:registry-build] settings=zuzu.app.settings ... total=14138ms
    [lookup-path:slow] db.CompanyNameChange company__in method=filter
      segments=2 total=12698ms chain_total=12698ms

→ background thread 가 14초 registry build 중에 main thread 의 lookup-path
IPC 가 _ensure_runtime_field_registry lock wait 12.7s 폭주.

이 fix 는 env 설정 없이 동작:
  - lock.acquire(timeout=1.0) 패턴
  - acquire 실패 시 caller 가 즉시 fallback (registry empty 유지)
  - build 완료 후 다음 호출부터 fast-path 회복

E2E 검증:
  1. lock 이 다른 thread 가 잡고 있을 때 acquire 가 timeout → caller 가 즉시 return
  2. timeout fallback 시 stderr 로그 emit
  3. build 완료 후 다음 호출 fast-path 정상
  4. DJLS_RUNTIME_REGISTRY_LOCK_TIMEOUT_S env 로 조정 가능

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_runtime_registry_lock_timeout -v
"""
from __future__ import annotations

import io
import os
import threading
import time
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from django_orm_intellisense.runtime import inspector


class RuntimeRegistryLockTimeoutTest(unittest.TestCase):
    def setUp(self) -> None:
        inspector._RUNTIME_FIELD_REGISTRY = {}
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = None
        inspector._RUNTIME_FIELD_REGISTRY_READY = False
        # lock 새로 생성 (이전 test 의 acquire 잔존 방지)
        inspector._RUNTIME_FIELD_REGISTRY_LOCK = threading.Lock()

    def test_acquire_timeout_returns_quickly_when_locked(self) -> None:
        """다른 thread 가 lock 잡고 있으면 acquire 가 timeout 후 caller 가 즉시 return.

        captain 시나리오: background thread 가 django.setup() 14s 진행 중 → main
        thread 의 IPC handler 가 lock_acquire(timeout=1s) → 1s 후 fallback.
        """
        # 다른 thread 가 lock 잡음
        inspector._RUNTIME_FIELD_REGISTRY_LOCK.acquire()
        try:
            with patch.object(
                inspector,
                '_RUNTIME_FIELD_REGISTRY_LOCK_TIMEOUT_S',
                0.2,
            ):
                captured = io.StringIO()
                start = time.perf_counter()
                with redirect_stderr(captured):
                    inspector._ensure_runtime_field_registry('myapp.settings')
                elapsed_ms = (time.perf_counter() - start) * 1000

            self.assertLess(
                elapsed_ms, 350,
                f'timeout=200ms — 250ms+ε 안에 return 해야 함. 실측 {elapsed_ms:.0f}ms',
            )
            self.assertGreater(
                elapsed_ms, 150,
                f'timeout 정확히 200ms 안에 fire — 너무 빠르면 안 wait. 실측 {elapsed_ms:.0f}ms',
            )
            self.assertIn(
                '[runtime:registry-lock-timeout]',
                captured.getvalue(),
                '진단 로그가 emit 되어야 captain 분석 시 fallback 발생 확인 가능',
            )
            self.assertFalse(
                inspector._RUNTIME_FIELD_REGISTRY_READY,
                'timeout 후 ready 마크 안 함 — 다음 호출이 다시 시도 가능',
            )
        finally:
            inspector._RUNTIME_FIELD_REGISTRY_LOCK.release()

    def test_fast_path_when_already_ready(self) -> None:
        """ready 상태면 lock 안 잡고 즉시 return — hot path 영향 없음."""
        inspector._RUNTIME_FIELD_REGISTRY_READY = True
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = 'myapp.settings'

        called: list[str | None] = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )
        try:
            start = time.perf_counter()
            inspector._ensure_runtime_field_registry('myapp.settings')
            elapsed_ms = (time.perf_counter() - start) * 1000
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertLess(elapsed_ms, 5, f'fast-path 5ms 이내 — 실측 {elapsed_ms:.2f}ms')
        self.assertEqual(called, [], 'fast-path 에서 locked build 호출 안 함')

    def test_recovery_after_build_completes(self) -> None:
        """다른 thread 의 build 완료 후 다음 호출은 fast-path 정상 회복."""
        # 시나리오:
        # 1. thread A 가 lock 잡고 build 진행 → ready=True 마크 + release
        # 2. main thread 호출 — ready 상태라 fast-path
        inspector._RUNTIME_FIELD_REGISTRY_READY = False

        def _slow_build_thread() -> None:
            with inspector._RUNTIME_FIELD_REGISTRY_LOCK:
                time.sleep(0.1)  # simulate build
                inspector._RUNTIME_FIELD_REGISTRY_READY = True
                inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = 'myapp.settings'

        t = threading.Thread(target=_slow_build_thread, daemon=True)
        t.start()
        t.join(timeout=2.0)

        # build 끝난 후 호출 — fast-path
        called: list[str | None] = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = (
            lambda sm: called.append(sm)
        )
        try:
            inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(called, [], 'build 완료 후엔 fast-path — 재build 안 함')

    def test_env_var_adjusts_timeout(self) -> None:
        """DJLS_RUNTIME_REGISTRY_LOCK_TIMEOUT_S 로 timeout 값 조정 가능."""
        # 모듈 reload 없이 env 직접 변경은 한계 — 현재 _RUNTIME_FIELD_REGISTRY_LOCK_TIMEOUT_S
        # 가 module load 시점에 한 번만 read. 그래서 patch.object 로 검증.
        with patch.object(
            inspector, '_RUNTIME_FIELD_REGISTRY_LOCK_TIMEOUT_S', 0.05,
        ):
            inspector._RUNTIME_FIELD_REGISTRY_LOCK.acquire()
            try:
                captured = io.StringIO()
                start = time.perf_counter()
                with redirect_stderr(captured):
                    inspector._ensure_runtime_field_registry('myapp.settings')
                elapsed_ms = (time.perf_counter() - start) * 1000

                self.assertLess(
                    elapsed_ms, 150,
                    f'timeout=50ms — 100ms 이내 return. 실측 {elapsed_ms:.0f}ms',
                )
            finally:
                inspector._RUNTIME_FIELD_REGISTRY_LOCK.release()


if __name__ == '__main__':
    unittest.main()
