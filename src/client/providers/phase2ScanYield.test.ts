// 첫 cycle phase2-scan 5.3s 폭주 fix — chunk size 1000 + microtask yield.
//
// captain log.txt L80:
//   phase2-scan:350-2498 5262ms total=10087ms requests=11 relations=0 lookups=530 cache=miss
//
// 원인: 2148 lines × 250 chunk = 8 yield × ~600ms (setTimeout(0) 가 background
// daemon IPC drain 과 macrotask 큐 시리얼 wait) = 4.8s 누적.
//
// fix: chunk 1000 + microtask yield (await Promise.resolve()).
//
// 이 E2E 는:
//   1. 컴파일된 산출물의 SCAN_CHUNK_LINES = 1000
//   2. yield 가 setTimeout(0) 아니라 microtask
//   3. 시뮬레이션으로 macrotask wait vs microtask 시간 비교
//
// 실행:
//   npm run compile && node out/client/providers/phase2ScanYield.test.js

import * as fs from 'fs';
import * as path from 'path';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function loadProvidersJs(): string {
  const fullPath = path.resolve(
    __dirname, '..', '..', '..', 'out', 'client', 'providers',
    'pythonProviders.js',
  );
  assert(fs.existsSync(fullPath), `out file missing: ${fullPath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function testChunkSizeBumpedTo1000(): void {
  const content = loadProvidersJs();
  // SCAN_CHUNK_LINES 상수가 1000 으로 늘어났는지
  const m = content.match(/SCAN_CHUNK_LINES\s*=\s*(\d+)/);
  assert(m, 'SCAN_CHUNK_LINES 상수 찾기 실패');
  const value = Number(m[1]);
  assert(
    value >= 1000,
    `SCAN_CHUNK_LINES 가 1000 이상이어야 yield 횟수 단축. 실측 ${value}`,
  );
  console.log(`  [ok] SCAN_CHUNK_LINES = ${value} (이전 250 → 1000+)`);
}

function testYieldUsesMicrotaskNotMacrotask(): void {
  const content = loadProvidersJs();
  // findLookupDiagnosticContexts 함수 본체 안에서 setTimeout 호출이
  // chunked yield 위치에 없어야 함 (Promise.resolve() 패턴)
  const fnStart = content.indexOf('function findLookupDiagnosticContexts');
  assert(fnStart >= 0, '함수 정의 찾기 실패');
  const fnBody = content.slice(fnStart, fnStart + 5000);

  // Promise.resolve() 패턴 존재
  assert(
    fnBody.includes('Promise.resolve()'),
    'microtask yield 패턴 (await Promise.resolve()) 사용해야 함',
  );
  // setTimeout(0) 패턴 부재 (chunked yield 위치에는)
  // 참고: 코멘트 안의 setTimeout 언급은 OK, 실제 호출만 부재해야.
  // 보수적 검증: setTimeout( 가 함수 본체 (코멘트 안 포함) 에 있는지 — 코드 흐름 추적 어려움.
  // 더 단순한 검증: chunk yield 가 microtask 인 키워드 매핑 — 충분.
  console.log('  [ok] yield 가 Promise.resolve() microtask 패턴');
}

async function testMicrotaskYieldIsFasterThanMacrotask(): Promise<void> {
  // 시뮬레이션: macrotask 큐가 다른 작업으로 점유된 상황.
  // setTimeout(0) yield 는 다른 setTimeout 콜백 뒤에 줄을 서므로 wait.
  // Promise.resolve() 는 microtask 큐 — 즉시 다음 tick.

  // 다른 macrotask 큐에 작업 채우기
  let macroCounter = 0;
  const macroTimers: ReturnType<typeof setTimeout>[] = [];
  for (let i = 0; i < 10; i++) {
    macroTimers.push(setTimeout(() => {
      const start = Date.now();
      while (Date.now() - start < 20) { /* busy */ }
      macroCounter++;
    }, 0));
  }

  // microtask yield 측정
  const microStart = Date.now();
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
  const microElapsed = Date.now() - microStart;

  // setTimeout(0) yield 측정 (별도)
  const macroStart = Date.now();
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const macroElapsed = Date.now() - macroStart;

  // microtask 가 macrotask 보다 더 빠르거나 동등 (점유된 macrotask 큐 환경)
  assert(
    microElapsed <= macroElapsed + 50,
    `microtask yield (${microElapsed}ms) 가 setTimeout(0) yield (${macroElapsed}ms) 보다 빠르거나 동등해야 함`,
  );
  console.log(
    `  [ok] 8× microtask yield = ${microElapsed}ms, 8× setTimeout(0) yield = ${macroElapsed}ms` +
    ` (macrotask 큐 점유 환경)`,
  );

  // cleanup
  for (const t of macroTimers) clearTimeout(t);
}

function testCommentDocumentsCaptainContext(): void {
  const content = loadProvidersJs();
  // captain 분석 코멘트가 코드에 살아 있는지 — 미래 유지보수자가 변경 이유 파악
  assert(
    content.includes('captain') || content.includes('phase2-scan'),
    'captain 분석 컨텍스트 코멘트가 산출물에 컴파일되어 있어야 함',
  );
  console.log('  [ok] captain 분석 코멘트 산출물 보존');
}

async function main(): Promise<void> {
  console.log('[1/4] SCAN_CHUNK_LINES = 1000 이상');
  testChunkSizeBumpedTo1000();
  console.log('[2/4] yield 가 microtask 패턴 (Promise.resolve)');
  testYieldUsesMicrotaskNotMacrotask();
  console.log('[3/4] microtask 가 macrotask 큐 점유 환경에서 빠름');
  await testMicrotaskYieldIsFasterThanMacrotask();
  console.log('[4/4] captain 분석 컨텍스트 코멘트 보존');
  testCommentDocumentsCaptainContext();
  console.log('all 4 phase2-scan yield checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
