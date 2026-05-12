// 옵션 3 reproducing E2E — receiver-trace 의 per-receiver Promise.race
// timeout 로직 검증.
//
// captain log.txt:374 의 7.5초 단일 receiver 추적 케이스를 단위 레벨에서
// 모방. vscode 의존성을 피하기 위해 vscode/daemon mock 대신 동일 로직을
// 재현한 inline race 헬퍼로 시뮬레이션. 실제 production 경로는
// `src/client/providers/pythonProviders.ts:1447-` 의 PER_RECEIVER_TIMEOUT_MS
// Promise.race.
//
// 실행:
//   npm run compile && node out/client/providers/receiverTraceTimeout.test.js

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Production 코드와 동일한 race shape. 한 쪽이 늦으면 다른 쪽(timeout)이
// 이겨서 null 반환. timer 는 finally 에서 항상 clear.
async function racedReceiverResolve<T>(
  underlying: Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T | null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const raced = await Promise.race([underlying, timeoutPromise]);
    return raced ?? null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function testTimeoutWinsWhenUnderlyingIsSlow(): Promise<void> {
  // captain 시나리오 재현: 단일 receiver 추적이 7.5초. timeout 1.5초.
  // Production budget = 1500ms. underlying 이 5000ms 면 timeout 이 이겨야 함.
  const start = Date.now();
  const slowResolver = delay(5000, { kind: 'manager' as const });
  const result = await racedReceiverResolve(slowResolver, 200);
  const elapsed = Date.now() - start;

  assert(result === null, `expected null on timeout, got ${JSON.stringify(result)}`);
  assert(
    elapsed < 400,
    `timeout 가드가 즉시 끊어야 함 — 실측 ${elapsed}ms (cap=200ms). ` +
      `captain 의 7.5초 폭주가 reproduce 됨.`,
  );
  // underlying 은 background 에서 계속 실행 중이지만 결과는 무시됨.
  // production 에서 이건 다음 receiver 처리를 가로막지 않으므로 OK.
  console.log(`  [ok] timeout 가드 ${elapsed}ms 만에 cap 발동`);
}

async function testUnderlyingWinsWhenFast(): Promise<void> {
  // 정상 케이스: receiver 추적이 10ms 면 timeout 이전에 완료. cap 발동 안 함.
  const start = Date.now();
  const fastResolver = delay(10, { kind: 'queryset' as const });
  const result = await racedReceiverResolve(fastResolver, 1500);
  const elapsed = Date.now() - start;

  assert(
    result !== null && result.kind === 'queryset',
    `정상 응답이 보존되어야 함. got ${JSON.stringify(result)}`,
  );
  assert(
    elapsed < 100,
    `정상 receiver 는 cap 영향 없이 빠르게 끝나야 함 — 실측 ${elapsed}ms`,
  );
  console.log(`  [ok] 정상 응답 ${elapsed}ms (cap=1500ms 영향 없음)`);
}

async function testRapidSequenceRespectsIndependentTimers(): Promise<void> {
  // captain 의 18개 receiver 시뮬레이션 중 3개가 slow, 15개가 fast. 각자
  // 독립된 timer 라서 slow 하나가 다른 fast 들을 가로막지 않아야 함.
  const start = Date.now();
  const results: Array<'fast' | 'slow' | null> = [];
  for (let i = 0; i < 6; i++) {
    const isSlow = i % 2 === 0;
    const result = await racedReceiverResolve(
      delay(isSlow ? 1000 : 10, isSlow ? ('slow' as const) : ('fast' as const)),
      150,
    );
    results.push(result);
  }
  const elapsed = Date.now() - start;

  const slowCount = results.filter((r) => r === null).length;
  const fastCount = results.filter((r) => r === 'fast').length;
  assert(slowCount === 3, `slow 3개는 timeout(null) 되어야 함, got ${slowCount}`);
  assert(fastCount === 3, `fast 3개는 정상 응답, got ${fastCount}`);

  // 순차 처리이지만 slow 가 cap(150ms) 만에 끊어지므로 6개 총합이
  // (3 × 150) + (3 × 10) ≈ 480ms 수준. cap 없으면 (3 × 1000) + 30 = 3030ms.
  assert(
    elapsed < 700,
    `누적 시간이 cap 으로 억제되어야 함 — 실측 ${elapsed}ms. ` +
      `cap 부재면 ~3000ms 로 폭주.`,
  );
  console.log(`  [ok] 6개 receiver 순차 처리 ${elapsed}ms (slow 3개 + fast 3개)`);
}

async function main(): Promise<void> {
  console.log('[1/3] testTimeoutWinsWhenUnderlyingIsSlow');
  await testTimeoutWinsWhenUnderlyingIsSlow();
  console.log('[2/3] testUnderlyingWinsWhenFast');
  await testUnderlyingWinsWhenFast();
  console.log('[3/3] testRapidSequenceRespectsIndependentTimers');
  await testRapidSequenceRespectsIndependentTimers();
  console.log('all 3 tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
