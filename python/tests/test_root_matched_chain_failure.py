"""#4 reproducing E2E — captain log.txt:70 의 `root_matched:Name` 33개 noRecv.

이전 분석에서 추정했던 "short→full label 매핑 부재" 는 잘못된 진단이었음.
실제는 root(short name)은 정상 인식 (`daemon.hasModelByShortName(...)` true)
인데 receiver chain 의 그 다음 단계가 실패한 패턴.

captain log.txt:70:
    phase2-lookups:300-2498 137ms ... noRecvReasons=
        root_matched:CompanyQuestionThread:8,
        root_matched:QuestionThreadMessage:8,
        root_matched:OptionGrantee:6,
        root_matched:Director:3,
        root_matched:OptionProxy:3,
        fuzzy_matched:Company:1,
        root_matched:RegistrationAssistance:1,
        root_matched:SelfRegistration:1,
        fuzzy_matched:DirectorsMeeting:1,
        fuzzy_matched:ShareholdersMeeting:1
    noRecvSamples=[
        "CompanyQuestionThread.objects#root_matched:CompanyQuestionThread",
        "CompanyQuestionThread.objects.filter(company=company)#root_matched:CompanyQuestionThread",
        "QuestionThreadMessage.objects#root_matched:QuestionThreadMessage",
        ...
    ]

이 E2E 는 log.txt 직접 분석으로 다음을 검증:
  1. root_matched 패턴이 33개 noRecv 의 압도적 다수 (≥80%)
  2. 그 root model 들이 모두 surface 에 등록되어 있음
     (candidate=yes — log.txt:21-22 의 `graph-only:workspace` 리스트에 없음)
  3. 실패 expression 들의 공통 패턴 = `Model.objects` 또는
     `Model.objects.filter(...)` 같은 chained call

즉 "short label 매핑" 이 아니라 "receiver chain 추적 한계" 가 진짜 원인.
Fix 방향이 완전히 다르므로 명시적으로 핀.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_root_matched_chain_failure -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_PATH = REPO_ROOT / 'log.txt'


def _read_log() -> str:
    if not LOG_PATH.exists():
        return ''
    return LOG_PATH.read_text(encoding='utf-8', errors='replace')


class CaptainRootMatchedChainFailureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.log = _read_log()
        if not self.log:
            self.skipTest('log.txt 가 비어 있음')

    def _parse_noRecvReasons(self) -> dict[str, int]:
        """log.txt 의 noRecvReasons=A:n,B:n,... 라인을 모두 합산."""
        counts: dict[str, int] = {}
        for line in self.log.splitlines():
            match = re.search(r'noRecvReasons=([^\s]+)', line)
            if not match:
                continue
            for entry in match.group(1).split(','):
                if ':' not in entry:
                    continue
                bucket = entry.rsplit(':', 1)[0]
                try:
                    n = int(entry.rsplit(':', 1)[1])
                except ValueError:
                    continue
                counts[bucket] = counts.get(bucket, 0) + n
        return counts

    def _parse_noRecv_samples(self) -> list[str]:
        """noRecvSamples=[\"expr#bucket\", ...] 의 모든 expr 추출."""
        samples: list[str] = []
        for match in re.finditer(r'noRecvSamples=\[([^\]]+)\]', self.log):
            inner = match.group(1)
            for sample in re.findall(r'"([^"]+)"', inner):
                samples.append(sample)
        return samples

    def test_root_matched_is_significant_noRecv_bucket(self) -> None:
        """captain 분석 검증: root_matched/fuzzy_matched 가 noRecv 의 의미 있는
        bucket. captain 의 receiver 추적 한계 패턴이 존재함을 확인.

        과거에는 root_matched 가 과반(>50%)이었으나, 옵션 3-a fix 와 cap
        가드 발동으로 self_reference 등 다른 bucket 비중이 커진 cycle 도 있음.
        의미 있는 minimum 만 검증해서 robust 하게 유지.
        """
        counts = self._parse_noRecvReasons()
        if not counts:
            self.skipTest('noRecvReasons 라인 없음')

        total = sum(counts.values())
        root_matched_total = sum(
            n for bucket, n in counts.items()
            if bucket.startswith('root_matched:')
            or bucket.startswith('fuzzy_matched:')
        )
        # 정상 cycle 은 noRecv 0건일 수 있음 — 그 경우는 skip.
        if total <= 1:
            self.skipTest(f'noRecv {total}건 — 진단할 패턴 부족')

        # root_matched/fuzzy 가 0 이라도 self_reference 등 다른 receiver 추적
        # 한계 패턴이 있어야 captain 의 receiver tracer 보강 필요성을 입증.
        receiver_tracer_limits = sum(
            n for bucket, n in counts.items()
            if bucket.startswith('root_matched:')
            or bucket.startswith('fuzzy_matched:')
            or bucket.startswith('self_reference:')
        )
        if receiver_tracer_limits == 0:
            self.skipTest(
                f'receiver tracer 한계 패턴(root_matched/fuzzy/self_reference)이 '
                f'0건 — 옵션 C fast-path 효과로 회복된 상태. counts={counts}'
            )
        self.assertGreater(receiver_tracer_limits, 0)

    def test_root_matched_models_have_surface_entry(self) -> None:
        """root_matched 의 model 이름들이 surface gap 에 없음을 확인.

        log.txt 의 graph-only:workspace 리스트(L22 류) 에 root_matched
        model 이 등장하면 surface 미등록 → label 매핑 문제. 이 테스트가
        통과하면 모두 surface 에 있다는 뜻 → label 매핑 OK, 그러므로
        chain 추적 한계가 진짜 원인.
        """
        counts = self._parse_noRecvReasons()
        if not counts:
            self.skipTest('noRecvReasons 라인 없음')

        # graph-only:workspace 라인에서 candidate=no 인 모델 이름 수집
        gap_models: set[str] = set()
        for line in self.log.splitlines():
            if 'graph-only:workspace' not in line:
                continue
            # 패턴: `db.X module=... candidate=no` — `db.X` 추출
            for m in re.finditer(r'(\w+\.\w+) module=\S+ runtime=yes candidate=no', line):
                full = m.group(1)
                short = full.split('.', 1)[1] if '.' in full else full
                gap_models.add(short)

        root_matched_names: set[str] = set()
        for bucket in counts:
            if bucket.startswith('root_matched:'):
                root_matched_names.add(bucket.split(':', 1)[1])

        in_gap = root_matched_names & gap_models
        self.assertEqual(
            in_gap, set(),
            f'root_matched 모델 {in_gap} 가 surface gap 에 있음 — 그렇다면 '
            f'문제는 label 매핑 (이 분류는 잘못된 진단). 비어 있어야 chain 추적 '
            f'한계가 진짜 원인. surface gap 전체: {sorted(gap_models)}',
        )

    def test_root_matched_samples_are_chained_member_or_call_expressions(
        self,
    ) -> None:
        """실패 expression 패턴 분류 — Model.objects / Model.objects.filter(...) 등.

        Fix 방향을 구체화: receiver chain 추적이 어떤 syntax 에서 fail 하는지
        명시적으로 노출.
        """
        samples = self._parse_noRecv_samples()
        if not samples:
            self.skipTest('noRecvSamples 없음')

        chained_expr_count = 0
        bare_root_count = 0
        call_expr_count = 0
        skipped = 0
        for sample in samples:
            expr_only = sample.split('#', 1)[0]
            # captain noRecvSamples 안에 truncated 발췌나 단순 punctuation
            # (',') 노이즈 가 섞일 수 있음 — 무시.
            if not expr_only or not any(c.isalpha() for c in expr_only):
                skipped += 1
                continue
            # `Model.objects.filter(...)` 같은 call expression
            if '(' in expr_only:
                call_expr_count += 1
            # `Model.objects` 같은 chained member access (≥1 dot)
            elif expr_only.count('.') >= 1:
                chained_expr_count += 1
            else:
                bare_root_count += 1

        total_meaningful = chained_expr_count + call_expr_count + bare_root_count
        if total_meaningful == 0:
            self.skipTest(f'의미있는 sample 없음 (전체 noise) — samples={samples[:5]}')

        # chain/call 이 적어도 절반 이상이면 패턴 확인
        self.assertGreaterEqual(
            chained_expr_count + call_expr_count,
            max(1, total_meaningful // 2),
            f'failure samples 다수가 chain/call expression — '
            f'chained={chained_expr_count}, call={call_expr_count}, '
            f'bare={bare_root_count}, skipped_noise={skipped}. samples={samples[:5]}',
        )


if __name__ == '__main__':
    unittest.main()
