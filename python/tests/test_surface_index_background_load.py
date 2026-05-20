"""옵션 D reproducing E2E — surface_index cache load 를 idle/on-demand 로.

captain log.txt 측정 (옵션 C 적용 후):
    L17  load_cached_static_index        0.76s
    L18  load_cached_runtime_inspection  0.87s
    L25  load_cached_model_graph         1.27s
    L32  load_cached_surface_index       1.68s   ← cold-start 의 92% 차지
    L34  initialize complete             1.83s

옵션 D 는 surface_index 로드를 main thread 밖으로 옮긴 뒤, 현재는 idle 또는
사용자 요청 on-demand 시점까지 미뤄 initialize 직후 작업량을 최소화한다.

이 E2E 는 코드 흐름 변경을 검증:
  1. initialize main thread 가 surface_index={} 로 즉시 진행
  2. idle/on-demand worker 가 cache hit 시도 → 성공 시 _apply_surface_index(from_cache=True)
  3. cache miss 시 prebuild 로 fallback → _apply_surface_index(from_cache=False)
  4. _apply_surface_index 의 from_cache=True 케이스는 save_surface_index 안 부름
     (디스크에 이미 있음)

대부분의 검증은 코드 grep + import smoke test. 실제 daemon spawn 은 vscode-test
환경 필요하므로 단위 레벨에서 패턴 확인.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_surface_index_background_load -v
"""
from __future__ import annotations

import inspect
import re
import unittest
from pathlib import Path

from django_orm_intellisense.server import app as server_app


APP_SOURCE = Path(server_app.__file__).read_text()


class CaptainSurfaceIndexBackgroundLoadTest(unittest.TestCase):
    def test_main_thread_does_not_call_load_cached_surface_index_directly(
        self,
    ) -> None:
        """main initialize 흐름 (`load_cached_surface_index` call site) 가
        지정된 background worker 안에만 있어야 함. main thread 동기 호출이
        남아 있으면 옵션 D 가 무효화됨.
        """
        # 모든 load_cached_surface_index 호출 위치 추출
        call_sites = []
        for m in re.finditer(r'load_cached_surface_index\(', APP_SOURCE):
            # 호출 라인의 인덴테이션과 함께 50자 컨텍스트
            start = max(0, m.start() - 200)
            ctx = APP_SOURCE[start: m.end() + 100]
            call_sites.append(ctx)
        # 1개 호출 — _background_worker 안에서만 사용
        self.assertGreater(
            len(call_sites), 0,
            'load_cached_surface_index 호출이 사라지면 안 됨 — background 에서 필요',
        )
        # main initialize 흐름 (대략 line 950 부근) 에 호출이 없어야 함:
        # `_background_worker` 또는 `_start_surface_index_prebuild` 안에서만.
        for ctx in call_sites:
            self.assertNotIn(
                'load_cached_runtime_inspection',
                ctx[:200],
                'load_cached_surface_index 가 main initialize 의 시리얼 캐시 '
                'load 순서 안에 있으면 옵션 D 미적용. context:\n' + ctx,
            )

    def test_initialize_uses_defer_load_or_prebuild_status(self) -> None:
        """main initialize 가 항상 defer_load_or_prebuild 상태로 진행 — cache hit
        도 background. cold-start 경로 일관성 확인."""
        self.assertIn(
            "surface_index_status = 'defer_load_or_prebuild'",
            APP_SOURCE,
            '옵션 D status 마커가 main initialize 에 있어야 함',
        )
        # 옛 분기들이 제거되었는지
        self.assertNotIn(
            "surface_index_status = 'load_cached'",
            APP_SOURCE,
            '옛 동기 load_cached 분기가 남아 있음 — cold-start 미단축',
        )
        self.assertNotIn(
            "surface_index_status = 'prebuild'",
            APP_SOURCE,
            '옛 동기 prebuild 분기가 남아 있음',
        )

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

    def test_thread_name_indicates_load_or_prebuild_pattern(self) -> None:
        """thread name 이 옵션 D 의 두 시나리오를 모두 반영."""
        self.assertIn(
            "name='surface-index-load-or-prebuild'",
            APP_SOURCE,
            'thread name 이 cache load + prebuild 두 경로를 반영해야 captain '
            'process list / ps 에서 즉시 식별 가능',
        )


if __name__ == '__main__':
    unittest.main()
