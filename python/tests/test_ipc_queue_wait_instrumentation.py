"""옵션 6+ reproducing E2E — daemon IPC queue wait 측정 instrumentation.

captain log.txt 의 단일 cycle 에서 동시 다중 IPC 가 정확히 같은 wall time 으로
완료 (resolveModule typing.ClassVar=2627.8ms, resolveOrmMember=2627.4ms,
memberAccess.resolveOrmMember=2627ms, memberAccess.annotated=2691ms × N).

이는 핸들러 본체가 빠르더라도 dispatch 시점 (worker thread 가 GIL 받는 시점)
이 일괄 지연되어 모든 IPC 가 동시에 unblock 된 흔적. 가설: Python GIL
contention — background runtime_field_registry_prewarm thread 의 django.setup()
이 CPU-bound 진행 중에 main / BG worker thread 가 GIL 못 받음.

이 E2E 는 진단 instrumentation 자체를 검증:
  1. 모든 request 에 `_dequeued_at` 시점 박힘
  2. handler 진입 시 queue_wait_ms 계산 → 50ms+ 시 stderr 로그 emit
  3. 로그 형식: `[ipc:queue-wait] req-N method=X queue_wait=Yms background=Z`

다음 captain 캡처에서:
  - `[ipc:queue-wait]` 라인이 N건 보임 → GIL contention 확정
  - 라인 없음 → queue wait 작음, 다른 원인 (handler 본체)

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_ipc_queue_wait_instrumentation -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from django_orm_intellisense.server import app as server_app


APP_SOURCE = Path(server_app.__file__).read_text()


class IpcQueueWaitInstrumentationTest(unittest.TestCase):
    def test_request_is_marked_with_dequeue_timestamp(self) -> None:
        """read loop 에서 request 가 dispatch 큐로 넘기기 전에 `_dequeued_at` 박음."""
        self.assertIn(
            "request['_dequeued_at'] = time.perf_counter()",
            APP_SOURCE,
            'read loop 에서 dispatch 직전에 dequeue 시점 박아야 함',
        )

    def test_handler_extracts_dequeued_at_and_computes_wait(self) -> None:
        """_handle_request 가 dequeued_at 사용해서 queue_wait_ms 계산."""
        self.assertIn(
            "dequeued_at = request.get('_dequeued_at')",
            APP_SOURCE,
        )
        self.assertIn(
            'queue_wait_ms',
            APP_SOURCE,
            'queue_wait_ms 변수가 계산되어야 함',
        )

    def test_emits_log_line_when_wait_exceeds_threshold(self) -> None:
        """50ms+ wait 시 stderr 로 노출 — captain 분석 시 GIL contention 식별 가능."""
        self.assertIn(
            '[ipc:queue-wait]',
            APP_SOURCE,
            'log prefix 가 산출물에 있어야 grep 으로 발췌 가능',
        )
        # 형식 검증: req-ID + method + queue_wait + background
        m = re.search(
            r"f'\[ipc:queue-wait\].*?queue_wait=.*?method=.*?background=",
            APP_SOURCE,
            re.DOTALL,
        )
        # 정확한 순서는 코드에 따라 다르지만 queue_wait + method + background 가
        # 모두 포함되어야 함.
        log_block_start = APP_SOURCE.find('[ipc:queue-wait]')
        self.assertGreater(log_block_start, 0)
        log_block = APP_SOURCE[log_block_start: log_block_start + 400]
        self.assertIn('queue_wait', log_block)
        self.assertIn('method=', log_block)
        self.assertIn('background=', log_block)

    def test_threshold_avoids_production_noise(self) -> None:
        """임계값(50ms) 이상만 emit — 정상 케이스 noise 없음."""
        # 코드 안의 threshold 숫자 추출
        m = re.search(r'if queue_wait_ms\s*>=\s*(\d+)', APP_SOURCE)
        self.assertIsNotNone(m, 'queue_wait_ms threshold 비교 표현식이 있어야 함')
        threshold = int(m.group(1))
        self.assertGreaterEqual(
            threshold, 10,
            f'threshold {threshold}ms 가 너무 낮으면 captain 정상 cycle 에도 '
            f'logs 폭주. 50ms 정도가 적절.',
        )
        self.assertLessEqual(
            threshold, 200,
            f'threshold {threshold}ms 가 너무 높으면 captain 의 2627ms 같은 큰 '
            f'wait 도 안 잡힘. 100ms 이하.',
        )


if __name__ == '__main__':
    unittest.main()
