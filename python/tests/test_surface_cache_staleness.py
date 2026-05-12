"""옵션 1 reproducing E2E — captain의 stale surface cache 문제.

captain 로그(`log.txt:32`)에서 발견:
    [initialize] load_cached_surface_index models=1318 elapsed=2.96s

즉 옵션 C 코드 변경 후에도 daemon은 옛 캐시(`zuzu.Company` 키 형식)를 그대로
로드해서 사용함. 이유는 캐시 무효화 조건(`load_cached_surface_index`)이
세 가지만 보기 때문:

    schemaVersion              ← 코드 변경 시 수동 bump 필요
    sourceFingerprint          ← 워크스페이스 소스 변화로만 변경
    runtimeFingerprint         ← Django runtime 변화로만 변경

옵션 C는 surface dict의 키 의미를 바꿨음 (candidate.label → graph.label).
캐시된 surface는 옛 키만 보유. 이 mismatch는 위 세 가드 어디에도 걸리지 않음.

이 E2E는 두 가지를 검증:

  (1) 현재 동작 (`CACHE_SCHEMA_VERSION` 가드만 작동) — schemaVersion이 다르면
      캐시가 None을 반환해 재빌드됨. 단순 dump-then-load 라운드트립으로 확인.

  (2) **현재 잡히지 않는 stale 패턴** — schemaVersion이 같지만 캐시 내용이
      현재 ModelGraph 라벨과 mismatch (옛 zuzu.* 키만 있고 db.* 키 없음).
      이 케이스에서 시스템이 mismatch를 감지하고 재빌드/경고하는지 검증.
      현재는 mismatch가 감지되지 않고 옛 캐시가 그대로 사용됨 — captain 재현.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_surface_cache_staleness -v
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from django_orm_intellisense.cache import store as cache_store
from django_orm_intellisense.cache.store import (
    CACHE_SCHEMA_VERSION,
    load_cached_surface_index,
    save_surface_index,
)
from django_orm_intellisense.features.orm_members import (
    build_surface_index,
    log_surface_index_gap,
)
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


def _build_captain_inputs() -> tuple[StaticIndex, RuntimeInspection]:
    """captain 패턴: candidate.label=zuzu.Company, runtime.label=db.Company."""
    candidate = ModelCandidate(
        app_label='zuzu',
        object_name='Company',
        label='zuzu.Company',
        module='zuzu.db.models.company.company',
        file_path='/captain/zuzu/db/models/company/company.py',
        line=1,
        column=0,
        is_abstract=False,
        base_class_refs=('TimestampedModel', 'SoftDeletableModel'),
        source='static',
    )
    static_index = StaticIndex(
        python_file_count=1,
        package_init_count=0,
        reexport_module_count=0,
        star_import_count=0,
        explicit_all_count=0,
        modules={},
        model_candidates=[candidate],
    )
    runtime_model = RuntimeModelSummary(
        label='db.Company',
        module='zuzu.db.models.company.company',
        field_names=['id'],
        relation_names=[],
        reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(
                name='id', field_kind='AutoField',
                is_relation=False, related_model_label=None, direction=None,
            ),
        ],
        relations=[],
        manager_names=['objects'],
    )
    runtime = RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True,
        django_version='5.0',
        bootstrap_status='ready',
        settings_module='zuzu.settings',
        bootstrap_error=None,
        app_count=1, model_count=1, field_count=1,
        relation_count=0, reverse_relation_count=0, manager_count=1,
        model_catalog=[runtime_model],
        model_preview=[runtime_model],
    )
    return static_index, runtime


class CaptainStaleSurfaceCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp_dir_ctx = tempfile.TemporaryDirectory()
        self._tmp_dir = Path(self._tmp_dir_ctx.name)
        self._workspace_root = self._tmp_dir / 'captain'
        self._workspace_root.mkdir(parents=True, exist_ok=True)
        # 모든 캐시 I/O를 임시 디렉토리로 격리.
        cache_store.os.environ['DJANGO_ORM_INTELLISENSE_CACHE_DIR'] = str(
            self._tmp_dir / 'cache_root'
        )

    def tearDown(self) -> None:
        cache_store.os.environ.pop('DJANGO_ORM_INTELLISENSE_CACHE_DIR', None)
        self._tmp_dir_ctx.cleanup()

    def test_schema_version_mismatch_invalidates_cache(self) -> None:
        """현재 동작 검증: schemaVersion이 다르면 캐시가 None을 반환.

        옵션 C 코드 변경 시 SchemaVersion을 bump 하면 captain의 옛 캐시가
        자동 무효화됨 — 가장 단순한 buster.
        """
        save_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
            surface_index={'zuzu.Company': {}},
        )

        # 같은 fingerprint로 로드 — 정상 케이스, 캐시 hit.
        loaded = load_cached_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
        )
        self.assertEqual(
            loaded, {'zuzu.Company': {}},
            '동일 fingerprint 라운드트립은 hit 되어야 함',
        )

        # schemaVersion 차이를 시뮬레이션: 저장된 파일을 직접 읽어서 metadata 변조.
        cache_path = (
            cache_store._workspace_cache_dir(self._workspace_root)
            / cache_store.SURFACE_INDEX_CACHE_NAME
        )
        self.assertTrue(cache_path.exists())
        import json
        payload = json.loads(cache_path.read_text())
        payload['metadata']['schemaVersion'] = CACHE_SCHEMA_VERSION - 1
        cache_path.write_text(json.dumps(payload))

        loaded_after_bump = load_cached_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
        )
        self.assertIsNone(
            loaded_after_bump,
            'schemaVersion 이 다르면 무효화되어야 함 — 옵션 C 같은 surface '
            '키 의미 변경 시 schemaVersion bump가 안전한 buster.',
        )

    def test_stale_surface_keys_silently_pass_when_fingerprints_match(
        self,
    ) -> None:
        """**버그 재현**: source/runtime fingerprint가 동일하면, surface 키가
        현재 graph 라벨과 mismatch 해도 캐시가 그대로 로드됨.

        captain 시나리오:
          - 옵션 C 이전 빌드가 surface 캐시를 `{zuzu.Company: ...}`로 저장
          - 옵션 C 적용 후 빌드: 같은 sourceFingerprint(워크스페이스 변경 없음),
            같은 runtimeFingerprint(Django 변경 없음) → schemaVersion만 그대로면
            옛 캐시가 그대로 hit. 새 코드가 만들었어야 할 `{db.Company: ...}`는
            반영되지 않음.

        이 테스트는 현재 동작을 문서화 — 의도된 버그 노출. 가드 추가가 필요.
        """
        save_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
            # 옵션 C 이전 형식 — candidate.label 그대로
            surface_index={'zuzu.Company': {'model_class': {}}},
        )

        loaded = load_cached_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
        )
        # 현재 가드 부재 — 옛 키 그대로 로드됨. 이게 captain의 문제.
        self.assertEqual(
            loaded, {'zuzu.Company': {'model_class': {}}},
            'captain 패턴 재현: surface 키가 옛 형식이어도 캐시 가드가 잡지 못함.',
        )
        # 이 캐시 결과를 현재 ModelGraph와 합쳤을 때 갭이 노출되는지 확인.
        static_index, runtime = _build_captain_inputs()
        model_graph = build_model_graph(static_index, runtime)
        # 정상 빌드라면 surface는 'db.Company' 키를 가져야 함.
        expected_fresh = build_surface_index(static_index, runtime, model_graph)
        self.assertIn(
            'db.Company', expected_fresh,
            'sanity: 옵션 C 적용 빌드는 db.Company 키로 surface 생성.',
        )
        self.assertNotIn(
            'db.Company', loaded,
            'captain 증상: 캐시된 surface 는 db.Company 키가 없어서 TS의 '
            'Pylance 라벨 조회가 영원히 미스.',
        )

    def test_pre_option_c_cache_schema_15_is_invalidated_on_load(self) -> None:
        """옵션 1 fix 검증: CACHE_SCHEMA_VERSION 15 ↔ 16 bump 가 captain 의
        옛 캐시를 자동 무효화함.

        시나리오:
          - captain 의 디스크 캐시는 옵션 C 이전(`schemaVersion=15`)에 만들어짐
          - 옵션 C 빌드 배포 후 daemon 이 `CACHE_SCHEMA_VERSION=16` 으로 로드 시도
          - 가드가 `schemaVersion` mismatch 를 잡아서 None 반환
          - daemon 은 surface 를 새로 빌드 → 옵션 C 의 graph-label 키로 저장

        이 가드가 없으면 captain 은 코드 변경 후에도 영원히 옛 캐시 사용.
        """
        # 옵션 C 이전 형식의 캐시를 디스크에 수동 작성 (schemaVersion=15, zuzu.* 키)
        import json
        cache_dir = cache_store._workspace_cache_dir(self._workspace_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / cache_store.SURFACE_INDEX_CACHE_NAME
        legacy_payload = {
            'metadata': {
                'schemaVersion': 15,
                'workspaceRoot': str(self._workspace_root),
                'sourceFingerprint': 'src-fp',
                'runtimeFingerprint': 'rt-fp',
                'createdAt': '2025-01-01T00:00:00+00:00',
            },
            'payload': {'zuzu.Company': {'model_class': {}}},
        }
        cache_path.write_text(json.dumps(legacy_payload))

        # 현재 코드 (CACHE_SCHEMA_VERSION=16) 로 로드 시도.
        self.assertEqual(
            CACHE_SCHEMA_VERSION, 16,
            '옵션 C 후속 조치로 CACHE_SCHEMA_VERSION 은 16 이어야 함 — '
            '옛 캐시(15) 자동 무효화 트리거.',
        )
        loaded = load_cached_surface_index(
            workspace_root=self._workspace_root,
            source_fingerprint='src-fp',
            runtime_fingerprint='rt-fp',
        )
        self.assertIsNone(
            loaded,
            f'schemaVersion=15 캐시가 16 가드를 통과해버림 — captain 은 옛 '
            f'캐시(zuzu.* 키)를 계속 사용하게 됨. got {loaded!r}',
        )

    def test_log_surface_index_gap_can_detect_stale_keys(self) -> None:
        """캐시 가드가 부재해도, `log_surface_index_gap` 진단으로 갭을 감지
        가능함을 확인. 이게 captain 로그의 `[surface:gap] graph-only=109` 가
        나오는 메커니즘이며, 실제로 graph(db.Company) ↔ surface(zuzu.Company)
        mismatch 를 노출함.
        """
        static_index, runtime = _build_captain_inputs()
        model_graph = build_model_graph(static_index, runtime)
        stale_surface = {'zuzu.Company': {'model_class': {}}}

        # 진단 함수가 stderr로 갭을 출력하는지 확인 (예외 없이 호출 OK).
        import io
        import sys
        old_stderr = sys.stderr
        sys.stderr = captured = io.StringIO()
        try:
            log_surface_index_gap(static_index, model_graph, stale_surface)
        finally:
            sys.stderr = old_stderr

        output = captured.getvalue()
        self.assertIn(
            'surface:gap', output,
            '진단 함수가 갭을 stderr에 출력해야 captain 같은 환경에서 '
            'stale cache 를 시각적으로 감지 가능.',
        )
        self.assertIn(
            'db.Company', output,
            'graph-only 라벨 (db.Company) 이 갭 로그에 명시되어야 함.',
        )


if __name__ == '__main__':
    unittest.main()
