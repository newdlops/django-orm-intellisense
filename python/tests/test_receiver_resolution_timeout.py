"""옵션 3 reproducing E2E — captain `user/app_user.py` 의 7.5초 receiver
추적 timeout 케이스.

captain 로그(`log.txt:373-377`)에서 발견:
    [receiver-step:slow] step=loopTarget elapsed=512ms ctx="company_user_relation_qs"
    [receiver-trace:slow] elapsed=7466ms resolved=false expr="company_user_relation_qs"
    [diagnostics] time budget exhausted (10078ms > 10000ms, 18 requests, phase=receivers-visible)
    receivers-visible 9997ms ... noRecvSamples=[
        "return cls.objects#self_reference:cls",
        "qs.exclude_confidential()#unknown_root",
        "qs#unknown_root"
    ]
    cancelled-before-batch 0ms total=10078ms diagnostics=0

핵심 분석:
  - daemon `resolveOrmMember(modelLabel=Company, ...)` 응답은 2.3ms (L365)
  - daemon `resolveOrmMemberChain(modelLabel=Company, chain=[get_queryset], ...)` 4.1ms (L371)
  - **7.5초는 TS client-side receiver-trace 추적**의 단일 표현식 처리 시간
  - 18개 receiver 중 6개가 `missing` → 부분적 실패가 전체 phase 를 cancel

이 E2E는 Python(daemon) 측에서만 검증 가능한 두 가지:

  (1) daemon 의 `resolveOrmMember` 가 **unknown receiver** 케이스 (`qs`,
      임시 변수 등)에 대해 빠르게 not_found 를 반환하는지 — daemon 단계가
      느리면 client timeout 의 underlying cause 가 됨.

  (2) `cls.objects` self-reference 같은 케이스에 대해 daemon 이 무한 루프나
      과도한 작업 없이 응답하는지 (visited set 가 사이클 방어를 제대로 함).

7.5초 자체는 client-side 추적 로직 (`src/client/providers/pythonProviders.ts`
의 receiver-trace step) 이슈이므로 별도 vscode-test 가 필요. 이 파일은
daemon 측 contribution 만 핀.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_receiver_resolution_timeout -v
"""
from __future__ import annotations

import time
import unittest

from django_orm_intellisense.features.orm_members import (
    prebuild_member_surface_cache,
    resolve_orm_member,
    resolve_orm_member_chain,
)
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


# captain 의 db.Company 패턴 — `app_user.py` 에서 reverse 관계로 자주 참조됨.
COMPANY_MODULE = 'zuzu.db.models.company.company'
COMPANY_FILE = '/captain/zuzu/db/models/company/company.py'


def _build_captain_inputs() -> tuple[StaticIndex, RuntimeInspection]:
    candidate = ModelCandidate(
        app_label='zuzu', object_name='Company', label='zuzu.Company',
        module=COMPANY_MODULE, file_path=COMPANY_FILE,
        line=1, column=0, is_abstract=False,
        base_class_refs=('TimestampedModel', 'SoftDeletableModel'),
        source='static',
    )
    static_index = StaticIndex(
        python_file_count=1, package_init_count=0,
        reexport_module_count=0, star_import_count=0,
        explicit_all_count=0, modules={},
        model_candidates=[candidate],
    )
    runtime_model = RuntimeModelSummary(
        label='db.Company', module=COMPANY_MODULE,
        field_names=['id'],
        relation_names=[], reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(
                name='id', field_kind='AutoField',
                is_relation=False, related_model_label=None, direction=None,
            ),
        ],
        relations=[], manager_names=['objects'],
    )
    runtime = RuntimeInspection(
        python_executable='/usr/bin/python3',
        django_importable=True, django_version='5.0',
        bootstrap_status='ready', settings_module='zuzu.settings',
        bootstrap_error=None,
        app_count=1, model_count=1, field_count=1,
        relation_count=0, reverse_relation_count=0, manager_count=1,
        model_catalog=[runtime_model], model_preview=[runtime_model],
    )
    return static_index, runtime


# daemon 응답이 이 시간을 넘으면 client timeout 의 underlying 원인으로 의심.
# captain 로그 기준 정상 응답은 1~10ms 수준이라 여유있게 100ms.
DAEMON_RESPONSE_BUDGET_S = 0.100


class CaptainReceiverResolutionDaemonBudgetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.static_index, self.runtime = _build_captain_inputs()
        self.model_graph = build_model_graph(self.static_index, self.runtime)
        prebuild_member_surface_cache(
            self.static_index, self.runtime, self.model_graph,
        )

    def test_unknown_member_returns_not_found_quickly(self) -> None:
        """`qs.exclude_confidential()` 류 케이스: TS 가 임시 변수의 멤버명을
        daemon 에 던지면 daemon 은 빠르게 not_found 로 끊어야 함. 느리면
        client receiver-trace 가 매 step 마다 누적되어 7.5초 timeout 으로 폭주.
        """
        started = time.perf_counter()
        result = resolve_orm_member(
            static_index=self.static_index, runtime=self.runtime,
            model_graph=self.model_graph,
            # TS 가 unqualified `Company` 라벨을 보내는 케이스 (log.txt L365 재현)
            model_label='Company',
            receiver_kind='queryset',
            name='exclude_confidential',
        )
        elapsed = time.perf_counter() - started
        self.assertFalse(result.get('resolved'))
        self.assertEqual(result.get('reason'), 'not_found')
        self.assertLess(
            elapsed, DAEMON_RESPONSE_BUDGET_S,
            f'unknown 멤버 resolve 가 {elapsed*1000:.1f}ms 소요됨. captain '
            f'환경에서 receiver-trace step 이 매번 이걸 호출하면 timeout 으로 폭주.',
        )

    def test_chain_with_unknown_first_hop_returns_quickly(self) -> None:
        """`cls.objects.something_unknown` 류: chain 의 첫 hop 부터 fail
        하면 daemon 은 즉시 끊어야 함.
        """
        started = time.perf_counter()
        result = resolve_orm_member_chain(
            static_index=self.static_index, runtime=self.runtime,
            model_graph=self.model_graph,
            model_label='db.Company',
            receiver_kind='model_class',
            chain=['this_does_not_exist', 'filter'],
        )
        elapsed = time.perf_counter() - started
        self.assertFalse(result.get('resolved'))
        self.assertLess(
            elapsed, DAEMON_RESPONSE_BUDGET_S,
            f'unknown 첫 hop resolve 가 {elapsed*1000:.1f}ms — 너무 느리면 '
            f'client 의 chain 추적이 누적되어 phase 단위로 timeout.',
        )

    def test_cls_self_reference_chain_is_bounded(self) -> None:
        """captain 의 `return cls.objects#self_reference:cls` 패턴.

        classmethod 내부의 `cls.objects` 는 TS 쪽이 self-reference 로 해석해서
        daemon 에 `(modelLabel=현재 모델, chain=[objects])` 식으로 보냄. daemon
        은 이걸 일반 chain 처럼 처리하면 됨 — 사이클 detection 가드가 무한
        루프 없이 빠르게 응답하는지 확인.
        """
        started = time.perf_counter()
        result = resolve_orm_member_chain(
            static_index=self.static_index, runtime=self.runtime,
            model_graph=self.model_graph,
            model_label='db.Company',
            receiver_kind='model_class',
            chain=['objects', 'all', 'filter'],
        )
        elapsed = time.perf_counter() - started
        self.assertTrue(
            result.get('resolved'),
            f'cls.objects.all().filter() chain 은 정상 resolve 되어야 함. '
            f'got {result!r}',
        )
        self.assertLess(
            elapsed, DAEMON_RESPONSE_BUDGET_S,
            f'다중 hop chain 이 {elapsed*1000:.1f}ms — 정상 케이스는 빠르게 '
            f'끝나야 client timeout 의 underlying cause 가 아닐 수 있음을 확정.',
        )

    def test_repeated_chain_resolution_uses_cache(self) -> None:
        """동일 chain 을 18번 (captain receivers-visible requests 수) 반복 해도
        cache 덕분에 첫 호출보다 빠르거나 동등해야 함. captain 의 18개 receiver
        가 7.5초 누적되었다는 건 cache 가 무효화되거나 매번 cold path 를 탔다는 뜻.
        """
        chain = ['objects', 'all']

        # 워밍업
        resolve_orm_member_chain(
            static_index=self.static_index, runtime=self.runtime,
            model_graph=self.model_graph,
            model_label='db.Company', receiver_kind='model_class',
            chain=chain,
        )

        repeats = 18
        started = time.perf_counter()
        for _ in range(repeats):
            result = resolve_orm_member_chain(
                static_index=self.static_index, runtime=self.runtime,
                model_graph=self.model_graph,
                model_label='db.Company', receiver_kind='model_class',
                chain=chain,
            )
            self.assertTrue(result.get('resolved'))
        elapsed = time.perf_counter() - started

        average_ms = (elapsed / repeats) * 1000
        self.assertLess(
            average_ms, 5.0,
            f'18회 반복 평균 {average_ms:.2f}ms — surface cache hit 경로가 '
            f'유지되어야 client receiver-trace 가 cumulative 하게 폭주하지 않음.',
        )


if __name__ == '__main__':
    unittest.main()
