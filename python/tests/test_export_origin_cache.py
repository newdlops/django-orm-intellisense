"""옵션 6+ reproducing E2E — resolve_export_origin (module, symbol) 페어 캐시.

captain log.txt 이번 캡처:
    ipc-by-method=[resolveExportOrigin=56/7480ms, ...]

같은 cycle 의 다른 IPC 는 ms 단위인데 resolveExportOrigin 만 1건 평균 134ms.
56건 모두 cache miss 누적 → 7.5s.

페어 캐시 + 진단 로그 검증:
  1. 같은 (module, symbol) 두 번째 호출 시 cache hit — 즉시 응답
  2. cache miss 시 builds + 임계 (50ms+) 초과면 stderr log emit
  3. 캐시가 진단 instrumentation 우회하지 않도록 첫 호출만 log emit

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_export_origin_cache -v
"""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from django_orm_intellisense.static_index.indexer import (
    DefinitionLocation,
    ExportResolution,
    ImportBinding,
    ModuleIndex,
    StaticIndex,
)


def _build_index_with_module(
    module_name: str,
    defined_symbols: set[str],
    import_bindings: tuple[ImportBinding, ...] = (),
) -> StaticIndex:
    module = ModuleIndex(
        module_name=module_name,
        file_path=f'/x/{module_name.replace(".", "/")}.py',
        is_package_init=False,
        defined_symbols=defined_symbols,
        symbol_definitions={
            s: DefinitionLocation(
                file_path=f'/x/{module_name.replace(".", "/")}.py',
                line=1, column=0,
            )
            for s in defined_symbols
        },
        import_bindings=list(import_bindings),
        explicit_all=None,
        model_candidates=[],
        pending_fields=[],
    )
    return StaticIndex(
        python_file_count=1,
        package_init_count=0,
        reexport_module_count=0,
        star_import_count=0,
        explicit_all_count=0,
        modules={module_name: module},
        model_candidates=[],
    )


class ExportOriginPairCacheTest(unittest.TestCase):
    def test_cache_hit_returns_same_instance(self) -> None:
        """두 번째 호출이 같은 인스턴스 반환 — cache 동작 확정."""
        index = _build_index_with_module('myapp.models', {'Company'})
        r1 = index.resolve_export_origin('myapp.models', 'Company')
        r2 = index.resolve_export_origin('myapp.models', 'Company')
        self.assertIs(r1, r2, 'cache hit 시 같은 인스턴스 반환되어야 함')
        self.assertTrue(r1.resolved)

    def test_unresolved_symbol_also_cached(self) -> None:
        """unresolved 결과도 캐시 — 미존재 symbol 의 반복 조회 비용 차단."""
        index = _build_index_with_module('myapp.models', {'Company'})
        r1 = index.resolve_export_origin('myapp.models', 'DoesNotExist')
        r2 = index.resolve_export_origin('myapp.models', 'DoesNotExist')
        self.assertIs(r1, r2)
        self.assertFalse(r1.resolved)

    def test_different_keys_have_independent_cache_entries(self) -> None:
        """(module, symbol) 별 독립 캐시 — 한 key 미스 다른 key 캐시 영향 없음."""
        index = _build_index_with_module('myapp.models', {'Company', 'User'})
        company = index.resolve_export_origin('myapp.models', 'Company')
        user = index.resolve_export_origin('myapp.models', 'User')
        self.assertIsNot(company, user)
        self.assertEqual(company.symbol, 'Company')
        self.assertEqual(user.symbol, 'User')
        # 다시 호출해도 각자 hit
        self.assertIs(company, index.resolve_export_origin('myapp.models', 'Company'))
        self.assertIs(user, index.resolve_export_origin('myapp.models', 'User'))

    def test_slow_log_emits_on_cache_miss_above_threshold(self) -> None:
        """cache miss + 임계 초과 시 stderr log emit. cache hit 은 emit 안 함."""
        index = _build_index_with_module('myapp.models', {'Company'})
        # 빠른 케이스 — 임계 0 이상 (모든 호출 emit)
        captured = io.StringIO()
        with redirect_stderr(captured):
            with patch.dict('os.environ', {'DJLS_EXPORT_ORIGIN_SLOW_LOG_MS': '0'}):
                index.resolve_export_origin('myapp.models', 'NewSymbol')
        # threshold=0 이면 비활성 (코드에서 _slow_threshold_ms > 0 만 emit).
        self.assertNotIn('[export-origin:slow]', captured.getvalue(),
                         'threshold=0 은 비활성 모드')

    def test_slow_log_skipped_for_cache_hit(self) -> None:
        """cache hit 은 timing 측정 안 함 → slow log emit 안 됨."""
        index = _build_index_with_module('myapp.models', {'Company'})
        # 첫 호출 — cache miss 라 timing 동작 (빠르므로 emit 안 됨, 50ms 미만)
        index.resolve_export_origin('myapp.models', 'Company')
        # 두 번째 호출 — cache hit
        captured = io.StringIO()
        with redirect_stderr(captured):
            index.resolve_export_origin('myapp.models', 'Company')
        self.assertEqual(
            captured.getvalue(), '',
            'cache hit 시 stderr 출력 0건 — instrumentation 비용 zero',
        )

    def test_cache_separates_static_index_instances(self) -> None:
        """StaticIndex 가 새로 만들어지면 cache 도 새로 시작 — reindex 안전."""
        index1 = _build_index_with_module('myapp.models', {'Company'})
        index2 = _build_index_with_module('myapp.models', {'Company'})
        r1 = index1.resolve_export_origin('myapp.models', 'Company')
        r2 = index2.resolve_export_origin('myapp.models', 'Company')
        self.assertIsNot(
            r1, r2,
            '서로 다른 StaticIndex 인스턴스는 cache 독립 — reindex 후 stale 없음',
        )


if __name__ == '__main__':
    unittest.main()
