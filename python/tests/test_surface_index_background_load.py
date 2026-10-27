"""Structural smoke checks for cold or explicitly scheduled background surface loads.

Warm initialization/source/cache behavior is exercised in test_initialize_cached_surface.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from django_orm_intellisense.server import app as server_app

APP_SOURCE = Path(server_app.__file__).read_text()


class CaptainSurfaceIndexBackgroundLoadTest(unittest.TestCase):
    def test_initialize_schedules_idle_or_on_demand_surface_load(self) -> None:
        """initialize 는 즉시 worker 를 시작하지 않고 idle/on-demand 로 지연."""
        self.assertIn(
            '_schedule_surface_index_idle_load',
            APP_SOURCE,
            'surface_index load 는 initialize 에서 idle scheduler 로 연결되어야 함',
        )
        self.assertIn(
            'defer_surface_index_load',
            APP_SOURCE,
            'idle/on-demand 지연 로그 마커가 있어야 cold-start 경로 추적 가능',
        )
        self.assertIn(
            'SURFACE_INDEX_ON_DEMAND_METHODS',
            APP_SOURCE,
            'hover/completion 계열 요청에서 on-demand load 를 앞당기는 method set 필요',
        )
        self.assertIn(
            "source != 'diagnostic'",
            APP_SOURCE,
            'diagnostic 경로는 surface cache load 를 on-demand 로 깨우면 안 됨',
        )

    def test_apply_surface_index_supports_from_cache_flag(self) -> None:
        """`_apply_surface_index` 가 `from_cache` 키워드를 받고 cache 케이스엔
        save_surface_index 안 부르도록 변경되었는지."""
        self.assertIn('from_cache: bool', APP_SOURCE)
        # save_surface_index 호출이 from_cache=False 조건 안에만 있어야 함
        save_idx = APP_SOURCE.find('save_surface_index(\n                    workspace_root,')
        self.assertGreaterEqual(save_idx, 0, 'save_surface_index 호출 위치 찾기 실패')
        # 호출 직전 100자에 `if not from_cache:` 가 있어야 함
        preceding = APP_SOURCE[max(0, save_idx - 200): save_idx]
        self.assertIn(
            'if not from_cache',
            preceding,
            'save_surface_index 호출이 `if not from_cache:` 가드 뒤에 와야 함 — '
            'cache hit 케이스 디스크 재기록 방지',
        )

    def test_background_worker_attempts_cache_first_then_prebuild(self) -> None:
        """background worker 가 cache load 시도 → prebuild fallback 순서."""
        # _background_worker 함수 source 추출
        worker_match = re.search(
            r'def _background_worker\(\).*?(?=\n        thread = threading\.Thread)',
            APP_SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(
            worker_match,
            'def _background_worker 정의를 찾지 못함',
        )
        worker_src = worker_match.group(0)
        # cache load 호출이 prebuild 호출보다 먼저
        cache_idx = worker_src.find('load_cached_surface_index')
        prebuild_idx = worker_src.find('_bg_prebuild_surface_index')
        self.assertGreaterEqual(cache_idx, 0, 'cache load 호출 없음')
        self.assertGreaterEqual(prebuild_idx, 0, 'prebuild 호출 없음')
        self.assertLess(
            cache_idx, prebuild_idx,
            'cache load 가 prebuild 보다 먼저 시도되어야 옵션 D 의미 있음',
        )
        self.assertIn(
            'static_index=static_index',
            worker_src,
            'cache hit는 현재 concrete model/field coverage를 검증해야 함',
        )
        self.assertIn(
            'model_graph=model_graph',
            worker_src,
            'cache hit는 현재 graph label/field coverage를 검증해야 함',
        )

    def test_thread_name_indicates_load_or_prebuild_pattern(self) -> None:
        """thread name 이 옵션 D 의 두 시나리오를 모두 반영."""
        self.assertIn(
            "name='surface-index-load-or-prebuild'",
            APP_SOURCE,
            'thread name 이 cache load + prebuild 두 경로를 반영해야 captain '
            'process list / ps 에서 즉시 식별 가능',
        )

    def test_cache_miss_builds_surface_by_default(self) -> None:
        """버그 fix 검증: cache miss 시 기본적으로 surface 를 백그라운드 빌드해야
        함 (예전엔 DJLS_SURFACE_PREBUILD_ON_MISS != '1' 이면 skip 해서 재시작 후
        bulk 자동완성이 id/pk 로 붕괴). 이제 명시적 opt-out (== '0') 만 skip."""
        worker_match = re.search(
            r'def _background_worker\(\).*?(?=\n        thread = threading\.Thread)',
            APP_SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(worker_match, 'def _background_worker 정의를 찾지 못함')
        worker_src = worker_match.group(0)

        # The skip branch must be an explicit opt-out, not the default.
        self.assertIn(
            "os.environ.get('DJLS_SURFACE_PREBUILD_ON_MISS') == '0'",
            worker_src,
            'cache miss 시 기본 빌드 + 명시적 opt-out(== "0") 만 skip 해야 함',
        )
        self.assertNotIn(
            "os.environ.get('DJLS_SURFACE_PREBUILD_ON_MISS') != '1'",
            worker_src,
            '예전 opt-in 게이트(!= "1")가 남아 있으면 cache miss 마다 skip 되어 '
            'db.Company 같은 워크스페이스 모델이 id/pk 로 붕괴',
        )
        # On miss (no opt-out) the prebuild path must run.
        skip_idx = worker_src.find("== '0'")
        prebuild_idx = worker_src.find('_bg_prebuild_surface_index')
        self.assertGreaterEqual(prebuild_idx, 0, 'cache miss prebuild 경로 없음')
        self.assertLess(
            skip_idx, prebuild_idx,
            'opt-out skip 분기 이후에 기본 prebuild 경로가 와야 함',
        )


if __name__ == '__main__':
    unittest.main()
