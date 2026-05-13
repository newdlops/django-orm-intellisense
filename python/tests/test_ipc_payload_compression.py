"""옵션 C reproducing E2E — IPC payload gzip+base64 압축.

captain log.txt 의 initialize 22.8MB payload 가 cold-start 의 ~0.7-1s 차지:
    [ipc:write] req-1 payload=22873.8KB
    [IPC:recv] req-1 payload=22873.8KB
    initialize(...) 6796.8ms

daemon 측에서 message 가 임계값(기본 256KB) 이상이면 gzip+base64 로 wrap.
TS client 가 `_enc=gzip+b64` 감지하면 unwrap.

이 E2E 는:
  1. _maybe_compress_ipc_payload 의 임계 미만 / 초과 분기
  2. envelope 포맷 (`{"_enc":"gzip+b64","data":"..."}`) 정확성
  3. Python 압축 → TS 의 decompressIpcEnvelope 가 readJSON 동등 결과 — round-trip
     (Python 측에서 decompress 동등 확인)
  4. 환경변수 DJLS_IPC_COMPRESS_MIN_KB=0 으로 비활성화

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_ipc_payload_compression -v
"""
from __future__ import annotations

import base64
import gzip
import json
import unittest
from unittest.mock import patch

from django_orm_intellisense.server import app as server_app
from django_orm_intellisense.server.app import _maybe_compress_ipc_payload


class IpcPayloadCompressionTest(unittest.TestCase):
    def test_small_payload_passes_through_uncompressed(self) -> None:
        """임계 미만 (기본 256KB) 메시지는 raw 그대로 — 압축 오버헤드 회피."""
        small = json.dumps({'id': 1, 'result': {'value': 'tiny'}})
        line, enc = _maybe_compress_ipc_payload(small)
        self.assertIsNone(enc)
        self.assertEqual(line, small)

    def test_large_payload_is_wrapped_in_gzip_b64_envelope(self) -> None:
        """임계 초과 메시지는 envelope 으로 wrap, _enc 마커 노출."""
        # captain initialize 시뮬레이션: 큰 surface_index dict
        big_payload = json.dumps({
            'id': 1,
            'result': {
                'surfaceIndex': {
                    f'db.Model{i}': {
                        'instance': {f'field_{j}': ['scalar', f'db.Model{i}', 'field', None]
                                     for j in range(20)},
                        'manager': {f'method_{j}': ['queryset', f'db.Model{i}', 'method', None]
                                    for j in range(30)},
                    }
                    for i in range(500)  # 500 model × 50 entries ~= 큰 payload
                },
            },
        })
        # 시뮬레이션이라 충분히 크게.
        self.assertGreater(len(big_payload), 256 * 1024)

        line, enc = _maybe_compress_ipc_payload(big_payload)
        self.assertEqual(enc, 'gzip+b64')
        self.assertTrue(line.startswith('{"_enc":"gzip+b64","data":"'))
        self.assertTrue(line.endswith('"}'))

        # 압축 효과 — 최소 5x 이상 (gzip 의 dict 키 반복 압축 강점)
        ratio = len(big_payload) / len(line)
        self.assertGreater(
            ratio, 5.0,
            f'gzip 압축 비율이 5x 이상이어야 cold-start 효과. 실측 {ratio:.1f}x',
        )

    def test_envelope_round_trips_through_decompression(self) -> None:
        """envelope 의 data 를 base64 decode → gunzip → JSON.parse 하면
        원본 payload 와 동등.
        """
        original = json.dumps({
            'id': 42,
            'result': {'surfaceIndex': {'db.X': {'a': 1}}},
        })
        # 임계 강제로 작게 해서 강제 압축
        with patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 0):
            line, enc = _maybe_compress_ipc_payload(original)
        # 임계 0 도 wrap 안 되도록 코드가 되어있으니 (≤0 → 비활성), 직접 forced 변경:
        # _IPC_COMPRESS_MIN_KB=0 은 비활성으로 정의되어 있음. 강제 압축은 다른 경로.
        # 임계를 1 (1KB) 로 낮추면 작은 메시지도 압축.
        with patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 1):
            line, enc = _maybe_compress_ipc_payload(original)
        if enc is None:
            # 메시지가 1KB 미만이라 압축 안 됨 — 더 큰 메시지 사용
            big = json.dumps({'id': 42, 'result': 'x' * 2000})
            with patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 1):
                line, enc = _maybe_compress_ipc_payload(big)
            self.assertEqual(enc, 'gzip+b64')
            envelope = json.loads(line)
            self.assertEqual(envelope['_enc'], 'gzip+b64')
            decompressed = gzip.decompress(
                base64.b64decode(envelope['data'])
            ).decode('utf-8')
            self.assertEqual(decompressed, big)
        else:
            envelope = json.loads(line)
            decompressed = gzip.decompress(
                base64.b64decode(envelope['data'])
            ).decode('utf-8')
            self.assertEqual(decompressed, original)

    def test_threshold_zero_disables_compression(self) -> None:
        """DJLS_IPC_COMPRESS_MIN_KB=0 환경에서 모든 메시지 raw — disable flag."""
        big = json.dumps({'id': 1, 'data': 'x' * (300 * 1024)})
        with patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 0):
            line, enc = _maybe_compress_ipc_payload(big)
        self.assertIsNone(enc)
        self.assertEqual(line, big)

    def test_envelope_is_single_line_for_streaming_compat(self) -> None:
        """envelope 은 newline 포함 안 함 — daemon stdout line-delimited 호환."""
        big = json.dumps({'id': 1, 'result': {'x': 'y' * (300 * 1024)}})
        line, enc = _maybe_compress_ipc_payload(big)
        self.assertEqual(enc, 'gzip+b64')
        self.assertNotIn(
            '\n', line,
            'envelope 안에 newline 있으면 stdout line stream parsing 깨짐',
        )


if __name__ == '__main__':
    unittest.main()
