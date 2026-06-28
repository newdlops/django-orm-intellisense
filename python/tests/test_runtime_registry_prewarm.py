"""옵션 A2 reproducing E2E — runtime field registry background pre-warm.

captain log.txt 직전 분석에서 lazy build 가 첫 lookup IPC 시점에 2.8s 폭주
(`[runtime:registry-build] settings=zuzu.app.settings models=1360 fields=19438
total=2807ms stages=[django_setup=2776ms,enumerate_fields=27ms]`).

옵션 A2 는 두 단계:
  1. _ensure_runtime_field_registry 가 thread-safe (lock 으로 중복 build 방지)
  2. daemon initialize 핸들러 끝에 background thread 시작 → 사용자 첫 IPC
     시점엔 이미 ready 또는 거의 ready

이 E2E 는:
  - 동시 다중 thread 호출 시 build 가 1회만 실행 (lock 검증)
  - daemon 코드에 `_start_runtime_field_registry_prewarm` 호출 존재
  - thread name marker 가 production 로그/ps 에서 식별 가능

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_runtime_registry_prewarm -v
"""
from __future__ import annotations

import re
import threading
import unittest
from pathlib import Path

from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app as server_app


APP_SOURCE = Path(server_app.__file__).read_text()
INSPECTOR_SOURCE = Path(inspector.__file__).read_text()


class RuntimeRegistryThreadSafetyTest(unittest.TestCase):
    def setUp(self) -> None:
        # reset registry state — each test starts clean
        inspector._RUNTIME_FIELD_REGISTRY = {}
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = None
        inspector._RUNTIME_FIELD_REGISTRY_READY = False

    def test_lock_serializes_concurrent_build_attempts(self) -> None:
        """동시 다중 thread 가 _ensure_runtime_field_registry 호출해도 build 가
        1회만 실행. _ensure_runtime_field_registry_locked 를 mock 해서 호출
        횟수 카운트.
        """
        call_count = 0
        build_started = threading.Event()
        finish_build = threading.Event()

        def slow_locked_build(settings_module: str | None) -> None:
            nonlocal call_count
            call_count += 1
            build_started.set()
            # 두 번째 thread 가 lock wait 하도록 의도적 지연
            finish_build.wait(timeout=2.0)
            # registry build 흉내 — ready 마커 set
            inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = settings_module
            inspector._RUNTIME_FIELD_REGISTRY_READY = True

        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = slow_locked_build
        try:
            threads = [
                threading.Thread(
                    target=inspector._ensure_runtime_field_registry,
                    args=('myapp.settings',),
                )
                for _ in range(5)
            ]
            for t in threads:
                t.start()
            self.assertTrue(
                build_started.wait(timeout=1.0),
                '첫 thread 의 build 가 시작되어야 함',
            )
            # 5개 thread 모두 진행 중 — 첫 thread 가 lock 잡고 build, 나머지
            # 4개는 lock wait 또는 fast-path 통과.
            finish_build.set()  # 첫 thread 의 build 해제
            for t in threads:
                t.join(timeout=2.0)
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        # 핵심 단언: locked build 가 1회만 호출됨 (race-free)
        self.assertEqual(
            call_count, 1,
            f'동시 5 thread 호출 시 build 가 1회만 실행되어야 함 — '
            f'실측 {call_count} 회',
        )

    def test_fast_path_returns_immediately_when_ready(self) -> None:
        """이미 ready 상태에서 호출하면 lock 안 잡고 즉시 return — hot-path."""
        inspector._RUNTIME_FIELD_REGISTRY_READY = True
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = 'myapp.settings'

        # _ensure_runtime_field_registry_locked 가 호출 안 되어야 함
        called = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = lambda sm: called.append(sm)
        try:
            inspector._ensure_runtime_field_registry('myapp.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(
            called, [],
            'ready 상태 fast-path 에서 locked build 호출되면 안 됨',
        )

    def test_different_settings_module_triggers_rebuild(self) -> None:
        """settings_module 변경 시 fast-path 통과 안 함 → rebuild trigger."""
        inspector._RUNTIME_FIELD_REGISTRY_READY = True
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = 'app_a.settings'

        called = []
        original = inspector._ensure_runtime_field_registry_locked
        inspector._ensure_runtime_field_registry_locked = lambda sm: called.append(sm)
        try:
            inspector._ensure_runtime_field_registry('app_b.settings')
        finally:
            inspector._ensure_runtime_field_registry_locked = original

        self.assertEqual(
            called, ['app_b.settings'],
            'settings_module 가 다르면 rebuild 호출되어야 함',
        )


class DaemonInitializePrewarmTriggerTest(unittest.TestCase):
    def test_initialize_calls_runtime_field_registry_prewarm(self) -> None:
        """daemon initialize 가 _start_runtime_field_registry_prewarm 을 호출해야
        captain 의 lazy 2.8s 폭주가 background 로 이동.
        """
        # 닫는 괄호를 포함하지 않아 인자가 추가돼도(예: health_snapshot) 깨지지
        # 않는다 — 검증하려는 건 호출의 존재 자체.
        self.assertIn(
            'self._start_runtime_field_registry_prewarm(runtime',
            APP_SOURCE,
            'initialize 핸들러에 background pre-warm 호출이 있어야 함',
        )

    def test_prewarm_method_uses_threading_with_named_thread(self) -> None:
        """thread name 이 production 분석에서 식별 가능해야 함."""
        self.assertIn(
            "name='runtime-field-registry-prewarm'",
            APP_SOURCE,
            'pre-warm thread name marker 가 captain ps/process list 식별용',
        )

    def test_prewarm_skips_when_runtime_not_ready(self) -> None:
        """runtime.bootstrap_status != 'ready' 이면 prewarm 의미 없음 — skip."""
        prewarm_match = re.search(
            r"def _start_runtime_field_registry_prewarm.*?(?=\n    def )",
            APP_SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(prewarm_match, 'prewarm 메서드 정의 없음')
        body = prewarm_match.group(0)
        self.assertIn(
            "bootstrap_status != 'ready'",
            body,
            'bootstrap not ready 케이스 guard 가 있어야 함 — '
            'django.setup() 실패 환경에서 noop',
        )


class InspectorLockMarkerTest(unittest.TestCase):
    def test_inspector_module_defines_registry_lock(self) -> None:
        self.assertIn(
            '_RUNTIME_FIELD_REGISTRY_LOCK = threading.Lock()',
            INSPECTOR_SOURCE,
            'thread-safety 용 lock module-level 정의 필요',
        )

    def test_lock_is_held_during_locked_build(self) -> None:
        """_ensure_runtime_field_registry 안에 `with _RUNTIME_FIELD_REGISTRY_LOCK:`
        가드가 있어야 race-free."""
        self.assertIn(
            'with _RUNTIME_FIELD_REGISTRY_LOCK:',
            INSPECTOR_SOURCE,
            'lock 가드가 _ensure_runtime_field_registry 안에 있어야 함',
        )


if __name__ == '__main__':
    unittest.main()
