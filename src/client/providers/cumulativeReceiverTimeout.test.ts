// captain 후속 분석 — 재배포 후 log.txt 가 노출한 새 폭주 패턴.
//
// 옵션 3 의 PER_RECEIVER_TIMEOUT_MS=1500ms cap 은 단일 runaway receiver 는
// 막지만, user/app_user.py 처럼 한 phase 에 18개 receiver 가 있고 그중 6개가
// 모두 1500ms cap 까지 매달리면 시리얼 누적 9000ms+ 로 phase budget(10s) 를
// 소진하고 `cancelled-before-batch` 로 끝나 진단 0건 publish.
//
// captain log.txt:414-416 재현:
//   time budget exhausted (10079ms > 10000ms, 18 requests, phase=receivers-visible)
//   receivers-visible 9975ms ... missing=6 noRecvReasons=unknown_root:4,self_reference:cls:2
//   cancelled-before-batch 0ms diagnostics=0
//
// 이 E2E 는 cap 자체는 정상 동작하지만 "N개 누적" 이라는 새 폭주 모드를
// 명시적으로 캡처. 옵션 3-c (Promise.all 병렬화) 의 근거가 된다.
//
// 실행:
//   npm run compile && node out/client/providers/cumulativeReceiverTimeout.test.js

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// production 코드와 동일한 race 헬퍼 (시뮬레이션용).
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
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// captain 의 production phase budget 과 동일.
const PHASE_BUDGET_MS = 10_000;
const PER_RECEIVER_TIMEOUT_MS = 1_500;

async function testSixSlowReceiversSerialAccumulatesBeyondBudget(): Promise<void> {
  // captain 실측 재현: 18 receiver 중 6개가 underlying 5초 (resolve 안 됨).
  // 시리얼 처리 시 6 × 1500ms = 9000ms 누적. fast 12개는 각 10ms.
  const start = Date.now();
  const results: Array<'slow-null' | 'fast'> = [];
  for (let i = 0; i < 18; i++) {
    const isSlow = i % 3 === 0; // 6개가 slow
    const result = await racedReceiverResolve(
      delay(isSlow ? 5_000 : 10, isSlow ? null : ('fast' as const)),
      PER_RECEIVER_TIMEOUT_MS,
    );
    results.push(result === null ? 'slow-null' : 'fast');
  }
  const elapsed = Date.now() - start;

  const slowCount = results.filter((r) => r === 'slow-null').length;
  const fastCount = results.filter((r) => r === 'fast').length;
  assert(slowCount === 6, `slow timeout 6개 예상, got ${slowCount}`);
  assert(fastCount === 12, `fast 12개 예상, got ${fastCount}`);

  // **이게 captain 새 폭주 패턴의 핵심 증거**: cap 이 있어도 시리얼 누적이
  // phase budget 을 넘어선다.
  assert(
    elapsed > 8_500,
    `시리얼 누적이 8.5s+ 여야 captain 폭주 재현 — 실측 ${elapsed}ms`,
  );
  assert(
    elapsed < PHASE_BUDGET_MS + 500,
    `이 시나리오는 budget 직전까지 가야 함 — 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] 6 slow × 1500ms cap = ${elapsed}ms 누적 ` +
    `(phase budget=${PHASE_BUDGET_MS}ms 임박, captain 시나리오 재현)`,
  );
}

async function testParallelExecutionWouldFitBudget(): Promise<void> {
  // 옵션 3-c (병렬화) 가 효과 있는지 미리 검증. 동일한 18 receiver / 6 slow 를
  // Promise.all 로 병렬 처리하면 누적 ≈ max(cap, fast_max) = 1500ms.
  const start = Date.now();
  const tasks: Array<Promise<'slow-null' | 'fast'>> = [];
  for (let i = 0; i < 18; i++) {
    const isSlow = i % 3 === 0;
    tasks.push(
      racedReceiverResolve(
        delay(isSlow ? 5_000 : 10, isSlow ? null : ('fast' as const)),
        PER_RECEIVER_TIMEOUT_MS,
      ).then((r) => (r === null ? ('slow-null' as const) : ('fast' as const))),
    );
  }
  const results = await Promise.all(tasks);
  const elapsed = Date.now() - start;

  assert(results.filter((r) => r === 'slow-null').length === 6, 'slow 6개');
  assert(results.filter((r) => r === 'fast').length === 12, 'fast 12개');
  // 병렬이면 ~cap+ε 안에 끝나야 함.
  assert(
    elapsed < PER_RECEIVER_TIMEOUT_MS + 500,
    `병렬화 시 ${PER_RECEIVER_TIMEOUT_MS}ms+ε 안에 끝나야 함 — 실측 ${elapsed}ms. ` +
    `시리얼 9000ms vs 병렬 ${elapsed}ms = ${Math.round(9000 / elapsed)}배 감소.`,
  );
  console.log(
    `  [ok] 병렬 실행: ${elapsed}ms (시리얼 9000ms 대비 ` +
    `${Math.round(9000 / elapsed)}배 개선)`,
  );
}

async function testCapSizeImpactIsLinearInSerialMode(): Promise<void> {
  // cap 을 줄이면 누적도 줄어듦을 확인 (option: cap 을 500ms 로 낮추면?).
  // 단, 정상 receiver 도 cap 에 걸리기 시작하므로 trade-off.
  const start = Date.now();
  for (let i = 0; i < 6; i++) {
    await racedReceiverResolve(delay(5_000, null), 500);
  }
  const elapsed = Date.now() - start;
  assert(
    elapsed >= 3_000 && elapsed < 3_500,
    `6 × 500ms cap = ~3000ms — 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] cap 500ms × 6 = ${elapsed}ms (1500ms 대비 1/3, ` +
    `하지만 false-negative 위험 증가)`,
  );
}

async function main(): Promise<void> {
  console.log('[1/3] 6 slow receiver 시리얼 누적 폭주 (captain 재현)');
  await testSixSlowReceiversSerialAccumulatesBeyondBudget();
  console.log('[2/3] Promise.all 병렬화 시 누적 사라짐 (옵션 3-c 검증)');
  await testParallelExecutionWouldFitBudget();
  console.log('[3/3] cap 크기 vs 시리얼 누적 (대안 옵션 검토)');
  await testCapSizeImpactIsLinearInSerialMode();
  console.log('all 3 cumulative-timeout patterns reproduced');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
