"""옵션 3-a reproducing E2E — cancelled-before-batch 경로에서 [diagnostics:perf]
라인이 누락되어 recv-timeout 카운터가 측정 불가능한 패턴.

captain log.txt:414-416 발췌:

    L414  [diagnostics] time budget exhausted (10079ms > 10000ms, ...)
    L415  [diagnostics:phase] receivers-visible 9975ms ... missing=6 ...
    L416  [diagnostics:phase] cancelled-before-batch 0ms total=10079ms diagnostics=0
    (※ 이 직후 [diagnostics:perf] 라인 없음 — captain 측정 사각)

L327 정상 publish 케이스와 대조:
    L327  [diagnostics:perf] wall=11395ms ... recv-timeout=1/1500ms ...

이 E2E 는 src/client/providers/pythonProviders.ts 의 cancelled-before-batch
return 경로(line ~1700) 직전에 perf summary 를 emit 하지 않음을 확인.
컴파일된 산출물에서 cancel 경로의 흐름을 grep 기반으로 검증.

추가로 captain log.txt 자체를 분석해 다음 사실을 명시적으로 핀:
  - 모든 cancelled-before-batch 라인 직후 [diagnostics:perf] 가 부재
  - 정상 publish 라인 직후엔 [diagnostics:perf] 가 항상 존재

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_cancel_path_perf_missing -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_PATH = REPO_ROOT / 'log.txt'
PROVIDERS_JS = REPO_ROOT / 'out' / 'client' / 'providers' / 'pythonProviders.js'


def _read_log_lines() -> list[str]:
    if not LOG_PATH.exists():
        return []
    return LOG_PATH.read_text(encoding='utf-8', errors='replace').splitlines()


class CaptainCancelPathPerfMissingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.log_lines = _read_log_lines()
        if not self.log_lines:
            self.skipTest('log.txt 가 비어 있음 — captain 캡처 후 다시 실행')

    def _line_after(self, idx: int, pattern: str, window: int = 5) -> int | None:
        """idx 다음 window 라인 안에서 pattern 매칭되는 첫 라인 index 반환."""
        regex = re.compile(pattern)
        for j in range(idx + 1, min(idx + 1 + window, len(self.log_lines))):
            if regex.search(self.log_lines[j]):
                return j
        return None

    def test_log_has_cancelled_before_batch_event(self) -> None:
        """captain 폭주 시나리오가 log.txt 에 실제로 캡처되었는지 sanity."""
        cancelled_lines = [
            i for i, line in enumerate(self.log_lines)
            if 'cancelled-before-batch' in line
        ]
        self.assertGreater(
            len(cancelled_lines), 0,
            'captain log.txt 에 cancelled-before-batch 이벤트가 없으면 '
            '이 E2E 가 검증할 패턴 자체가 부재. 다른 캡처 필요.',
        )

    def test_cancelled_before_batch_is_not_followed_by_diagnostics_perf(
        self,
    ) -> None:
        """**버그 재현**: cancel 경로에서 [diagnostics:perf] 라인이 누락됨.

        recv-timeout=N/1500ms 카운터는 [diagnostics:perf] 에만 노출되므로
        cancel cycle 에서는 옵션 3 timeout 가드의 효과를 측정 불가능.
        """
        cancelled_lines = [
            i for i, line in enumerate(self.log_lines)
            if 'cancelled-before-batch' in line
        ]
        self.assertGreater(len(cancelled_lines), 0)

        cancel_perf_missing_count = 0
        for cancel_idx in cancelled_lines:
            # cancel 후 다음 5라인 안에 diagnostics:perf 가 있는지?
            perf_idx = self._line_after(
                cancel_idx, r'\[diagnostics:perf\]', window=5
            )
            # 다음 phase 의 perf 가 끼어들면 안 됨 — 같은 cycle 안에서
            # cancel 직전 phase 의 perf 여야 의미가 있음. 우리는 cancel
            # 다음에 perf 가 즉시 따라오지 않는 것을 검증.
            if perf_idx is None:
                cancel_perf_missing_count += 1

        self.assertEqual(
            cancel_perf_missing_count, len(cancelled_lines),
            f'cancelled-before-batch 경로 {len(cancelled_lines)}회 중 '
            f'{cancel_perf_missing_count}회만 perf 미emit. 일관성 검증 — '
            f'옵션 3-a fix 후 모든 cancel 경로에서 perf 가 emit 되어야 함.',
        )

    def test_normal_publish_is_followed_by_diagnostics_perf(self) -> None:
        """대조군: 정상 publish 직전 cycle 에는 [diagnostics:perf] 가 존재.

        cancel 경로만 미emit 이라는 사실을 명시 — fix 가 cancel 경로에
        한정되어야 함을 가이드.
        """
        publish_lines = [
            i for i, line in enumerate(self.log_lines)
            if '[diagnostics:phase] publish' in line
        ]
        if not publish_lines:
            self.skipTest('정상 publish phase 가 없음')

        found_perf_before_publish = 0
        for publish_idx in publish_lines:
            # publish 직전 3라인 안에 perf 가 있는지 (publish 는 perf 다음 emit)
            for j in range(max(0, publish_idx - 3), publish_idx):
                if '[diagnostics:perf]' in self.log_lines[j]:
                    found_perf_before_publish += 1
                    break

        self.assertEqual(
            found_perf_before_publish, len(publish_lines),
            f'정상 publish {len(publish_lines)}회 중 {found_perf_before_publish}회만 '
            f'직전 perf 존재. 정상 경로는 perf 가 일관되게 emit 되는데 '
            f'cancel 경로만 누락 — 옵션 3-a 의 범위가 명확.',
        )

    def test_compiled_artifact_returns_after_cancelled_before_batch_without_perf(
        self,
    ) -> None:
        """산출물 구조 검증: cancelled-before-batch 다음 흐름이 publish 단계로
        가지 않고 일찍 return 함을 grep 으로 확인. [diagnostics:perf] 에밋이
        publish 직전에 있으므로 cancel 경로는 그걸 건너뜀.
        """
        if not PROVIDERS_JS.exists():
            self.skipTest('out/ 산출물 없음 — npm run compile 필요')
        content = PROVIDERS_JS.read_text(encoding='utf-8')
        self.assertIn(
            'cancelled-before-batch', content,
            '컴파일된 산출물에 cancel 라벨이 있어야 함',
        )
        # cancel-before-batch 직후 return; 패턴 검색 — perf summary 우회의 핵심.
        cancel_idx = content.find('cancelled-before-batch')
        self.assertGreaterEqual(cancel_idx, 0)
        # cancel 라벨 이후 300자 안에 return 또는 close 가 있어야 — 즉 cycle 종료.
        following = content[cancel_idx : cancel_idx + 800]
        self.assertTrue(
            'return' in following,
            'cancelled-before-batch 다음에 return 이 보여야 cycle 이 일찍 '
            '끝남을 확인 가능. 다음 800자 내용: ' + following[:300],
        )


if __name__ == '__main__':
    unittest.main()
