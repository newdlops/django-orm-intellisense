// 옵션 C reproducing E2E — IPC envelope round-trip (Python daemon → TS client).
//
// captain log.txt 의 initialize 22.8MB payload 가 cold-start 의 큰 비용:
//   stdout pipe write ~hundreds of ms + JSON.parse ~hundreds of ms.
// gzip+base64 envelope 으로 ~10x 압축하면 두 비용 모두 절감.
//
// 이 E2E 는 Python 측이 만들 envelope 포맷을 시뮬레이션 하여 TS 의
// decompressIpcEnvelope() 가 정확히 원본 메시지를 복원하는지 검증.
//
// 실행:
//   npm run compile && node out/client/daemon/ipcCompression.test.js

import * as zlib from 'zlib';
import { decompressIpcEnvelope, isCompressedEnvelope } from './ipcCompression';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function buildEnvelope(message: Record<string, unknown>): string {
  const serialized = JSON.stringify(message);
  const compressed = zlib.gzipSync(Buffer.from(serialized, 'utf8'));
  const data = compressed.toString('base64');
  return JSON.stringify({ _enc: 'gzip+b64', data });
}

function testRoundTripPreservesMessage(): void {
  const original = {
    id: 42,
    result: {
      surfaceIndex: {
        'db.Company': { instance: { id: ['scalar', 'db.Company', 'field', null] } },
        'db.User': { manager: { filter: ['queryset', 'db.User', 'method', null] } },
      },
    },
  };
  const envelope = buildEnvelope(original);
  const parsed = JSON.parse(envelope) as { _enc: string; data: string };
  const decoded = decompressIpcEnvelope(parsed.data);
  assert(
    JSON.stringify(decoded) === JSON.stringify(original),
    `round-trip mismatch — expected ${JSON.stringify(original)}, got ${JSON.stringify(decoded)}`,
  );
  console.log('  [ok] surfaceIndex round-trip 무손실');
}

function testLargePayloadCompressionRatio(): void {
  // captain initialize 시뮬레이션 — 500개 모델 × 50 entries
  const surfaceIndex: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) {
    const model: Record<string, Record<string, unknown[]>> = {
      instance: {},
      manager: {},
    };
    for (let j = 0; j < 20; j++) {
      model.instance[`field_${j}`] = ['scalar', `db.Model${i}`, 'field', null];
    }
    for (let j = 0; j < 30; j++) {
      model.manager[`method_${j}`] = ['queryset', `db.Model${i}`, 'method', null];
    }
    surfaceIndex[`db.Model${i}`] = model;
  }
  const original = { id: 1, result: { surfaceIndex } };
  const serialized = JSON.stringify(original);
  const envelope = buildEnvelope(original);

  const ratio = serialized.length / envelope.length;
  assert(
    ratio > 5.0,
    `압축 비율 5x 이상 기대 — 실측 ${ratio.toFixed(1)}x ` +
      `(raw=${serialized.length}, envelope=${envelope.length})`,
  );
  console.log(
    `  [ok] 500 model 시뮬레이션: ${(serialized.length / 1024).toFixed(0)}KB → ` +
      `${(envelope.length / 1024).toFixed(0)}KB (${ratio.toFixed(1)}x 압축)`,
  );

  // decode 시간 측정 — JSON.parse 비교 우위.
  const parsed = JSON.parse(envelope) as { data: string };
  const startDecode = Date.now();
  const decoded = decompressIpcEnvelope(parsed.data);
  const decodeMs = Date.now() - startDecode;
  const startParse = Date.now();
  JSON.parse(serialized);
  const parseMs = Date.now() - startParse;

  assert(decoded !== undefined, 'decompress should succeed');
  console.log(
    `  [info] decode ${decodeMs}ms vs raw JSON.parse ${parseMs}ms ` +
      `(payload ${(serialized.length / 1024).toFixed(0)}KB)`,
  );
}

function testCorruptedDataReturnsUndefined(): void {
  // 잘못된 base64 / gzip 데이터는 undefined — daemon 통신 무결성 방어.
  const result = decompressIpcEnvelope('not-valid-base64-zzz!!!');
  assert(
    result === undefined,
    `corrupt envelope 은 undefined 반환해야 함, got ${JSON.stringify(result)}`,
  );
  console.log('  [ok] 잘못된 envelope → undefined (안전)');
}

function testEmptyDataReturnsUndefined(): void {
  const result = decompressIpcEnvelope('');
  assert(result === undefined, 'empty data → undefined');
  console.log('  [ok] 빈 envelope → undefined');
}

function testTypeGuard(): void {
  assert(isCompressedEnvelope({ _enc: 'gzip+b64', data: 'abc' }), 'valid envelope');
  assert(!isCompressedEnvelope({ id: 1, result: {} }), 'plain message');
  assert(!isCompressedEnvelope(null), 'null');
  assert(!isCompressedEnvelope({ _enc: 'other', data: 'x' }), 'wrong _enc');
  assert(!isCompressedEnvelope({ _enc: 'gzip+b64' }), 'missing data');
  console.log('  [ok] type guard');
}

function main(): void {
  console.log('[1/5] round-trip 무손실');
  testRoundTripPreservesMessage();
  console.log('[2/5] captain initialize 압축 비율 + decode 시간');
  testLargePayloadCompressionRatio();
  console.log('[3/5] 잘못된 데이터 안전 처리');
  testCorruptedDataReturnsUndefined();
  console.log('[4/5] 빈 데이터 안전 처리');
  testEmptyDataReturnsUndefined();
  console.log('[5/5] isCompressedEnvelope type guard');
  testTypeGuard();
  console.log('all 5 ipc compression checks passed');
}

main();
