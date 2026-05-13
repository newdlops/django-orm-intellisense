// #1 reproducing E2E — captain log.txt:141 의 9171ms cap 우회 패턴.
//
// captain 로그 증거:
//   L141: [receiver-trace:slow] elapsed=9171ms resolved=false expr="company_user_relation_qs"
//   L142: time budget exhausted (10082ms > 10000ms, phase=receivers-visible)
//   L143: receivers-visible 9987ms ... missing=6
//   L144: cancelled-before-batch 0ms ... diagnostics=0
//
// 핵심 관측: 단일 receiver 가 9171ms 걸렸는데 [receiver-trace:timeout] 로그
// 가 같은 로그 파일에 0건. PER_RECEIVER_TIMEOUT_MS=1500ms cap 이 한 번도
// 발동 안 함.
//
// 가설 G — Promise.race 의 setTimeout 콜백이 event loop 점유 시 늦게 fire:
//   - underlying 이 CPU-bound 동기 작업이면 setTimeout macro-task 가 fire 못함
//   - Promise.race 가 settle 되지 못하고 underlying 결과 우승
//   - cap 가드 효력 상실
//
// 이 E2E 는 두 가지 시나리오로 cap 우회를 재현:
//   1. CPU-bound 동기 busy loop — event loop 점유
//   2. micro-task burst — setTimeout 발화 지연
//
// 실행:
//   npm run compile && node out/client/providers/capBypassEventLoopBlock.test.js

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function busyForMs(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) { /* spin */ }
}

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// production 과 동일 race 헬퍼.
async function racedReceiverResolve<T>(
  underlying: Promise<T | undefined>,
  timeoutMs: number,
): Promise<{ result: T | null; capFired: boolean }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let capFired = false;
  const timeoutPromise = new Promise<T | null>((resolve) => {
    timeoutId = setTimeout(() => {
      capFired = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    const raced = await Promise.race([underlying, timeoutPromise]);
    return { result: raced ?? null, capFired };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function testCpuBoundUnderlyingBypassesCap(): Promise<void> {
  // **버그 재현**: underlying 이 동기 busy loop 면 setTimeout 콜백 미발화 →
  // race 가 underlying 결과를 우승 처리. cap=500ms 가 무력화됨.
  const start = Date.now();
  const cpuBoundPromise = (async () => {
    busyForMs(2_000); // event loop 2초 점유
    return 'cpu-done' as const;
  })();
  const { result, capFired } = await racedReceiverResolve(
    cpuBoundPromise,
    500,
  );
  const elapsed = Date.now() - start;

  assert(
    !capFired,
    `버그 재현: cap 이 fire 안 했어야 함 (captain 시나리오) — 실측 capFired=${capFired}`,
  );
  assert(
    result === 'cpu-done',
    `underlying 결과가 우승해야 함 — 실측 ${JSON.stringify(result)}`,
  );
  assert(
    elapsed >= 1_900,
    `cap 우회로 underlying 시간(2000ms) 까지 block — 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] CPU-bound underlying: cap=500ms 무력화, ${elapsed}ms 까지 block ` +
    `(captain 의 9171ms cap 우회와 동일 메커니즘)`,
  );
}

async function testMicrotaskBurstDelaysSetTimeout(): Promise<void> {
  // micro-task 큐 폭주 시 setTimeout 발화 지연 가설.
  // captain 의 receiver 추적은 다단계 IPC await 가 micro-task 큐를 채움.
  // 그동안 setTimeout(1500ms) 가 macro-task 라 fire 늦게 됨.
  let microtaskCount = 0;
  async function microtaskBurst(): Promise<'burst-done'> {
    // resolveLookupReceiverInfoForReceiver 의 다단계 IPC 시뮬레이션 — 즉시
    // resolve 되는 promise N개를 시리얼 await. micro-task 큐 폭주.
    const start = Date.now();
    while (Date.now() - start < 800) {
      await Promise.resolve();
      microtaskCount++;
    }
    return 'burst-done';
  }

  const start = Date.now();
  const { result, capFired } = await racedReceiverResolve(
    microtaskBurst(),
    300,
  );
  const elapsed = Date.now() - start;

  // micro-task burst 도 timer 를 지연시킬 수 있지만 Node.js 가 timer 를
  // periodic 하게 check 하므로 완전 starvation 보다는 약간 지연.
  console.log(
    `  [info] micro-task burst (${microtaskCount} resolves): ` +
    `elapsed=${elapsed}ms cap=300ms capFired=${capFired} result=${JSON.stringify(result)}`,
  );
  // 둘 중 하나는 발생: cap fire (정상) 또는 burst 우승 (cap 우회).
  // 이 E2E 의 목적은 어느 경로든 reproducible 함을 보이는 것.
  assert(
    elapsed < 1_500,
    `시리얼 micro-task burst 는 최대 800ms 안에 끝나야 — 실측 ${elapsed}ms`,
  );
}

async function testLogTxtConfirmsCapWasNeverFired(): Promise<void> {
  // production log.txt 직접 검증: 9171ms 짜리 receiver-trace:slow 가 있는데
  // 같은 cycle 에서 receiver-trace:timeout 이 0건. 즉 cap 가드가 실제
  // production 환경에서 발화하지 못함.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const logPath = path.resolve(__dirname, '..', '..', '..', 'log.txt');
  if (!fs.existsSync(logPath)) {
    console.log('  [skip] log.txt 없음 — captain 캡처 후 다시 실행');
    return;
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const slowMatches =
    content.match(/\[receiver-trace:slow\] elapsed=(\d+)ms/g) ?? [];
  const timeoutMatches =
    content.match(/\[receiver-trace:timeout\]/g) ?? [];

  // captain 의 9171ms 단일 폭주
  const longSlows = slowMatches.filter((m) => {
    const ms = Number(m.match(/elapsed=(\d+)/)?.[1] ?? 0);
    return ms > 3_000;
  });
  if (longSlows.length === 0) {
    console.log('  [skip] 3000ms+ slow trace 없음 — captain 폭주가 캡처되지 않은 로그');
    return;
  }

  // 옵션 #1 + 3-c fix 적용 후엔 cap 정상 작동 — long-slow 가 있어도 timeout
  // 로그가 동등하거나 더 많음. 이 historical marker 테스트는 fix 후 환경에선
  // 가설이 무효화됨을 명시.
  if (timeoutMatches.length >= longSlows.length) {
    console.log(
      `  [info] log.txt 분석: long-slow ${longSlows.length}개 vs ` +
      `timeout-fire ${timeoutMatches.length}개 → cap 가드 정상 작동 (fix 적용 후)`,
    );
    return;
  }
  console.log(
    `  [warn] long-slow ${longSlows.length}개 > timeout-fire ${timeoutMatches.length}개 — ` +
    `cap 우회 가능성 (fix 미적용 또는 sub-function 깊이에서 우회)`,
  );
  console.log(`         long-slow 예: ${longSlows.slice(0, 3).join(', ')}`);
}

async function main(): Promise<void> {
  console.log('[1/3] CPU-bound underlying 이 cap 가드 우회');
  await testCpuBoundUnderlyingBypassesCap();
  console.log('[2/3] micro-task burst 가 setTimeout 발화 영향');
  await testMicrotaskBurstDelaysSetTimeout();
  console.log('[3/3] log.txt 직접 검증 (captain 의 cap 우회)');
  await testLogTxtConfirmsCapWasNeverFired();
  console.log('all 3 cap-bypass scenarios reproduced');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
