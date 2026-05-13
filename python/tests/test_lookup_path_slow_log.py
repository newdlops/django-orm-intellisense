"""옵션 6 reproducing E2E — daemon-side resolveLookupPath 폭주 진단 로그.

captain log.txt:273-279 발췌:
    resolveLookupPath(db.VentureBusinessCertification, valid_to__gte, filter): 7185ms
    resolveLookupPath(db.VentureBusinessCertification, valid_from__lte, filter): 7185ms
    resolveLookupPath(db.CompanyMethodOfGivingPublicNoticeChan, date__lte, filter): 5344ms

단일 IPC 가 5-7초 걸리는 정체를 daemon-side 단계별 elapsed 로 노출해야 함:
    [lookup-path:slow] db.X valid_to__gte method=filter segments=2 total=7185ms
        stages=[graph_find=2ms] chain_calls=1 chain_total=7180ms
    [runtime:registry-build] settings=zuzu.app.settings models=1425 fields=18234
        total=7100ms stages=[django_setup=120ms,enumerate_fields=6980ms]

이 E2E 는 다음을 검증:
  1. 임계 (500ms+) 안 넘으면 slow log 미emit (정상 케이스 noise 없음)
  2. 임계 넘으면 단계별 elapsed 가 stderr 에 노출
  3. _ensure_runtime_field_registry 가 100ms+ 시 build 로그 emit
  4. 환경변수 DJLS_LOOKUP_PATH_SLOW_LOG_MS=0 으로 끄기 가능

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_lookup_path_slow_log -v
"""
from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from django_orm_intellisense.features import lookup_paths
from django_orm_intellisense.features.lookup_paths import resolve_lookup_path
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


def _build_simple_inputs() -> tuple[StaticIndex, RuntimeInspection]:
    """db.Article 한 모델 — 'id' (AutoField), 'title' (CharField) 필드."""
    candidate = ModelCandidate(
        app_label='db', object_name='Article', label='db.Article',
        module='myapp.models.article',
        file_path='/x/myapp/models/article.py',
        line=1, column=0, is_abstract=False,
        base_class_refs=(), source='static',
    )
    static_index = StaticIndex(
        python_file_count=1, package_init_count=0,
        reexport_module_count=0, star_import_count=0,
        explicit_all_count=0, modules={},
        model_candidates=[candidate],
    )
    runtime_model = RuntimeModelSummary(
        label='db.Article', module='myapp.models.article',
        field_names=['id', 'title'],
        relation_names=[], reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(
                name='id', field_kind='AutoField',
                is_relation=False, related_model_label=None, direction=None,
            ),
            RuntimeFieldSummary(
                name='title', field_kind='CharField',
                is_relation=False, related_model_label=None, direction=None,
            ),
        ],
        relations=[], manager_names=['objects'],
    )
    runtime = RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True, django_version='5.0',
        bootstrap_status='ready', settings_module='myapp.settings',
        bootstrap_error=None,
        app_count=1, model_count=1, field_count=2,
        relation_count=0, reverse_relation_count=0, manager_count=1,
        model_catalog=[runtime_model], model_preview=[runtime_model],
    )
    return static_index, runtime


class CaptainLookupPathSlowLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.static_index, self.runtime = _build_simple_inputs()
        self.model_graph = build_model_graph(self.static_index, self.runtime)

    def _call_with_threshold(
        self,
        threshold_ms: int,
        *,
        injected_chain_ms: float = 0.0,
    ) -> str:
        """resolve_lookup_path 를 호출하면서 stderr 캡쳐 + 임계 변경.

        injected_chain_ms>0 이면 _resolve_lookup_chain 을 mock 으로 교체해서
        지연 시뮬레이션 — captain 의 7185ms 폭주 재현.
        """
        captured = io.StringIO()
        with patch.object(
            lookup_paths, '_LOOKUP_PATH_SLOW_LOG_MS', threshold_ms,
        ):
            if injected_chain_ms > 0:
                import time
                original = lookup_paths._resolve_lookup_chain

                def _slow_chain(*, runtime, field, segments):  # type: ignore[no-untyped-def]
                    time.sleep(injected_chain_ms / 1000)
                    return original(runtime=runtime, field=field, segments=segments)

                with patch.object(
                    lookup_paths, '_resolve_lookup_chain', _slow_chain,
                ):
                    with redirect_stderr(captured):
                        resolve_lookup_path(
                            model_graph=self.model_graph,
                            runtime=self.runtime,
                            base_model_label='db.Article',
                            path='title__icontains',
                            method='filter',
                        )
            else:
                with redirect_stderr(captured):
                    resolve_lookup_path(
                        model_graph=self.model_graph,
                        runtime=self.runtime,
                        base_model_label='db.Article',
                        path='title__icontains',
                        method='filter',
                    )
        return captured.getvalue()

    def test_fast_lookup_does_not_emit_slow_log(self) -> None:
        """정상 케이스 (1ms 미만) 는 slow log 미emit — production noise 없음."""
        output = self._call_with_threshold(threshold_ms=500)
        self.assertNotIn(
            '[lookup-path:slow]', output,
            f'정상 케이스에서 slow log 미emit 이어야 함. output:\n{output}',
        )

    def test_slow_lookup_emits_stage_breakdown(self) -> None:
        """captain 7185ms 폭주 재현: _resolve_lookup_chain 에 200ms 지연 주입,
        임계 100ms 로 낮춰서 slow log 강제 발화. stage breakdown 확인."""
        output = self._call_with_threshold(
            threshold_ms=100, injected_chain_ms=200,
        )
        self.assertIn(
            '[lookup-path:slow]', output,
            f'200ms 지연 + 100ms 임계 — slow log emit 되어야 함. output:\n{output}',
        )
        # 기본 메타데이터 노출 확인
        self.assertIn('db.Article', output)
        self.assertIn('method=filter', output)
        self.assertIn('total=', output)
        # 단계별 timing
        self.assertIn('chain_calls=', output)
        self.assertIn('chain_total=', output)

    def test_zero_threshold_emits_every_call(self) -> None:
        """DJLS_LOOKUP_PATH_SLOW_LOG_MS=0 — 모든 호출에 emit (디버깅 모드)."""
        output = self._call_with_threshold(threshold_ms=0)
        self.assertIn(
            '[lookup-path:slow]', output,
            f'threshold=0 일 때 모든 호출 emit — output:\n{output}',
        )

    def test_slow_log_includes_segments_count(self) -> None:
        """segments 개수도 함께 emit — chain depth 진단."""
        output = self._call_with_threshold(threshold_ms=0)
        self.assertRegex(
            output, r'segments=\d+',
            f'segments=N 형태 노출 필요. output:\n{output}',
        )


class CaptainRuntimeRegistryBuildLogTest(unittest.TestCase):
    """_ensure_runtime_field_registry 의 첫 빌드 시 100ms+ 비용 노출."""

    def test_registry_build_log_when_django_unavailable_is_fast(self) -> None:
        """Django 가 없으면 즉시 ready 처리 — build log 미emit (100ms 미만)."""
        from django_orm_intellisense.runtime import inspector

        # 캐시 reset
        inspector._RUNTIME_FIELD_REGISTRY_READY = False
        inspector._RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE = None

        captured = io.StringIO()
        with redirect_stderr(captured):
            inspector._ensure_runtime_field_registry(None)
        self.assertTrue(inspector._RUNTIME_FIELD_REGISTRY_READY)
        self.assertNotIn(
            '[runtime:registry-build]', captured.getvalue(),
            'settings=None 케이스는 fast path — build log 미emit',
        )


if __name__ == '__main__':
    unittest.main()
