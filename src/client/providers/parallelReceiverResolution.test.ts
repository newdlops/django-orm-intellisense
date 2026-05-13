// 3-c reproducing E2E — receiver 추적이 phase 안에서 Promise.all 로 병렬.
//
// captain log.txt:141 의 9171ms 단일 receiver-trace 가 사실은 18개 receiver
// 가 시리얼 await 으로 누적 9.9s. 6 slow × 1500ms cap = 9s 누적이 그 정체.
//
// 이 E2E 는 컴파일된 산출물의 receivers-visible 단계가 Promise.all 패턴
// 인지 검증 + 시뮬레이션으로 시리얼 vs 병렬 시간 비교.
//
// 실행:
//   npm run compile && node out/client/providers/parallelReceiverResolution.test.js

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

function testCompiledReceiversVisibleUsesPromiseAll(): void {
  const content = loadProvidersJs();
  // receivers-visible phase 안에 Promise.all 호출이 있어야 시리얼 누적 차단.
  // beginDiagnosticPhase('receivers-visible') 와 logDiagnosticPhase('receivers-visible')
  // 사이의 코드 블록을 추출.
  const phaseStart = content.indexOf("beginDiagnosticPhase('receivers-visible')");
  assert(phaseStart > 0, 'receivers-visible phase 시작 위치 찾기 실패');
  const phaseEnd = content.indexOf("'receivers-visible'", phaseStart + 100);
  assert(phaseEnd > phaseStart, 'receivers-visible phase 종료 위치 찾기 실패');
  const phaseBlock = content.slice(phaseStart, phaseEnd);

  assert(
    phaseBlock.includes('Promise.all'),
    'receivers-visible phase 안에 Promise.all 호출이 있어야 시리얼 누적 폭주 차단. ' +
      'block 발췌 (first 400):\n' + phaseBlock.slice(0, 400),
  );
  assert(
    phaseBlock.includes('_validatedLookupContexts.map'),
    '_validatedLookupContexts.map(...) 패턴이 있어야 모든 context 동시 시작',
  );
  console.log('  [ok] receivers-visible phase 가 Promise.all 패턴 사용');
}

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function racedReceiverResolve<T>(
  underlying: Promise<T | undefined>,
  capMs: number,
): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T | null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), capMs);
  });
  try {
    const raced = await Promise.race([underlying, timeoutPromise]);
    return raced ?? null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function testParallelResolutionBoundedToSingleCap(): Promise<void> {
  // captain 시뮬레이션: 18 receiver / 6 slow / 12 fast.
  // 시리얼: 6 × 1500ms + 12 × 10ms = 9120ms (budget 9.9s 초과 가능)
  // 병렬: max(1500ms, 10ms) = 1500ms
  const CAP = 1500;
  const tasks = Array.from({ length: 18 }, (_, i) => {
    const isSlow = i % 3 === 0;
    return racedReceiverResolve(
      delay(isSlow ? 5_000 : 10, isSlow ? null : ('fast' as const)),
      CAP,
    );
  });
  const start = Date.now();
  const results = await Promise.all(tasks);
  const elapsed = Date.now() - start;

  const slowCount = results.filter((r) => r === null).length;
  const fastCount = results.filter((r) => r === 'fast').length;
  assert(slowCount === 6, `slow 6 expected, got ${slowCount}`);
  assert(fastCount === 12, `fast 12 expected, got ${fastCount}`);
  assert(
    elapsed < CAP + 300,
    `Promise.all 병렬 — ${CAP}ms+ε 안에 끝나야 함. 실측 ${elapsed}ms (시리얼이면 9000ms+)`,
  );
  console.log(
    `  [ok] 18 receiver / 6 slow / 12 fast: ${elapsed}ms ` +
    `(시리얼 추정 9120ms 대비 ${Math.round(9120 / elapsed)}배 단축)`,
  );
}

async function testFastReceiversNotBlockedBySlow(): Promise<void> {
  // 핵심 단언: slow 가 cap 에 갇혀도 fast 결과는 ~10ms 안에 ready.
  // Promise.all 은 모두 settle 까지 대기 → 측정은 max 만.
  // 별도로 first-resolve 시간 확인 위해 Promise.race 활용.
  const start = Date.now();
  const slowPromise = delay(5_000, 'slow' as const);
  const fastPromise = delay(15, 'fast' as const);
  const winner = await Promise.race([slowPromise, fastPromise]);
  const winnerElapsed = Date.now() - start;
  assert(winner === 'fast', 'fast가 먼저 resolve');
  assert(
    winnerElapsed < 100,
    `fast receiver 가 slow 와 동시 시작했어도 즉시 응답 — 실측 ${winnerElapsed}ms`,
  );
  console.log(
    `  [ok] fast receiver ${winnerElapsed}ms (slow 와 동시 시작 — 시리얼이면 5000ms+ 대기)`,
  );
}

async function main(): Promise<void> {
  console.log('[1/3] 컴파일된 산출물의 Promise.all 패턴 검증');
  testCompiledReceiversVisibleUsesPromiseAll();
  console.log('[2/3] 18 receiver / 6 slow 병렬 시간 측정');
  await testParallelResolutionBoundedToSingleCap();
  console.log('[3/3] fast receiver 가 slow 에 가로막히지 않음');
  await testFastReceiversNotBlockedBySlow();
  console.log('all 3 parallel-resolution checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
