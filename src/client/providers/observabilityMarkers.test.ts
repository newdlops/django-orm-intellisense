// captain 재배포 검증용 — out/ 산출물에 옵션 3 관측 마커들이 실제로
// 포함되어 있는지 확인하는 standalone smoke test.
//
// 사용자가 vsix 재설치 후 production 로그에서 다음 마커들이 보이는지로
// 배포 적용 여부를 판단:
//   1. `[extension] activate version=... recvTimeoutMs=...`  (boot 1회)
//   2. `recv-timeout=N/Xms` (diagnostics:perf 라인 매 cycle)
//   3. `[receiver-trace:timeout] ... file=... expr=...` (timeout 발동 시)
//
// 이 테스트는 산출물(out/)에 식별자가 살아 있는지 확인. 살아 있는데도
// production 로그에 안 보이면 vsix 캐시 / VSCode reload 이슈.
//
// 실행:
//   npm run compile && node out/client/providers/observabilityMarkers.test.js

import * as fs from 'fs';
import * as path from 'path';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function loadJs(relPath: string): string {
  const fullPath = path.resolve(__dirname, '..', '..', '..', 'out', relPath);
  assert(fs.existsSync(fullPath), `out file missing: ${fullPath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function main(): void {
  console.log('[1/3] extension.js — boot marker 포함');
  const extensionJs = loadJs('client/extension.js');
  assert(
    extensionJs.includes('[extension] activate version='),
    'extension.js 에 boot 마커가 컴파일되어 들어가야 함',
  );
  assert(
    extensionJs.includes('recvTimeoutMs='),
    'boot 마커가 recvTimeoutMs 값을 노출해야 함',
  );
  assert(
    extensionJs.includes('DJLS_RECEIVER_TRACE_TIMEOUT_MS'),
    'env var 키가 산출물에 살아 있어야 사용자가 override 가능',
  );
  console.log('  [ok] extension activate 마커 confirmed');

  console.log('[2/3] pythonProviders.js — receiver timeout 카운터/로그');
  const providersJs = loadJs('client/providers/pythonProviders.js');
  assert(
    providersJs.includes('PER_RECEIVER_TIMEOUT_MS'),
    'PER_RECEIVER_TIMEOUT_MS 상수가 컴파일되어야 함',
  );
  assert(
    providersJs.includes('perfReceiverTimeoutCount'),
    'phase 단위 timeout 카운터가 존재해야 함',
  );
  assert(
    providersJs.includes('[receiver-trace:timeout]'),
    'timeout 발동 시 emit 되는 로그 prefix 가 산출물에 있어야 함',
  );
  assert(
    providersJs.includes('recv-timeout='),
    '[diagnostics:perf] 라인에 recv-timeout 필드가 포함되어야 함',
  );
  assert(
    providersJs.includes('Promise.race'),
    'Promise.race 가 컴파일 후에도 남아 있어야 함 (timeout 전략 핵심)',
  );
  console.log('  [ok] receiver timeout 관측 마커 confirmed');

  console.log('[3/3] 마커 흔적 카운트 (regression sanity)');
  const timeoutMarkerCount = (providersJs.match(/\[receiver-trace:timeout\]/g) ?? []).length;
  assert(
    timeoutMarkerCount === 1,
    `[receiver-trace:timeout] 은 정확히 1곳에서 emit 되어야 함 (실측 ${timeoutMarkerCount}). ` +
      `여러 곳에서 emit 되면 누가 발동했는지 분석이 모호해짐.`,
  );
  const timeoutCounterIncrement = (providersJs.match(/perfReceiverTimeoutCount\+\+/g) ?? []).length;
  assert(
    timeoutCounterIncrement === 1,
    `perfReceiverTimeoutCount++ 도 1곳에서만 — 실측 ${timeoutCounterIncrement}. ` +
      `중복 증가 시 카운터 정확도 깨짐.`,
  );
  console.log(`  [ok] 마커 흔적 정확히 1회씩 emit (regression-safe)`);

  console.log('all 3 marker checks passed');
}

main();
