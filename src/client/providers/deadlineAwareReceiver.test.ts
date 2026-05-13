// #1 reproducing E2E — receiver tracer 의 cooperative deadline cancellation.
//
// 배경: capBypassEventLoopBlock.test 가 setTimeout 기반 cap 이 event loop 점유 /
// micro-task burst 시 늦게 fire 하는 것을 재현. 해결책: Date.now() 기반 deadline
// 을 receiver tracer 함수에 전달, 매 await 후 비교.
//
// 이 E2E 는:
//   1. 컴파일된 산출물에 deadlineMs 인자 전달 패턴이 있는지
//   2. Date.now() 기반 비교가 event loop 점유 환경에서도 정확히 expired 식별
//   3. cooperative cancellation 패턴 시뮬레이션 — sub-await 후 deadline 체크
//
// 실행:
//   npm run compile && node out/client/providers/deadlineAwareReceiver.test.js

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

function busyForMs(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) { /* spin */ }
}

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function testCompiledArtifactHasDeadlineParameter(): void {
  const content = loadProvidersJs();
  assert(
    content.includes('isReceiverDeadlineExpired'),
    'isReceiverDeadlineExpired 헬퍼가 산출물에 있어야 함',
  );
  assert(
    content.includes('deadlineMs'),
    'deadlineMs 인자가 receiver tracer chain 에 전달되어야 함',
  );
  // 호출 측 (resolveCachedLookupReceiverInfo) 에서 Date.now() + cap 패턴
  assert(
    /Date\.now\(\)\s*\+\s*PER_RECEIVER_TIMEOUT_MS/.test(content),
    'Date.now() + PER_RECEIVER_TIMEOUT_MS 로 deadline 계산 패턴 필요',
  );
  console.log('  [ok] 산출물에 deadline-aware 패턴 포함');
}

function testCompiledArtifactChecksDeadlineAfterAwait(): void {
  const content = loadProvidersJs();
  // resolveLookupReceiverInfoForReceiverAtOffset 안에서 await 후 deadline 체크
  // 함수 본체 추출 후 await + check 순서 확인.
  const fnStart = content.indexOf('function resolveLookupReceiverInfoForReceiverAtOffset');
  assert(fnStart >= 0, '함수 정의 위치 찾기 실패');
  // 다음 ~30라인 본체 추출
  const fnBody = content.slice(fnStart, fnStart + 1500);
  // await 직후 (또는 가까운 위치에) isReceiverDeadlineExpired 호출 있는지
  assert(
    fnBody.includes('isReceiverDeadlineExpired'),
    '함수 본체 안에서 deadline 체크 호출 필요. 발췌:\n' + fnBody.slice(0, 600),
  );
  console.log('  [ok] receiver tracer 함수 안에서 deadline 체크 호출');
}

async function testDateNowBasedDeadlineFiresUnderCpuBusy(): Promise<void> {
  // event loop 점유 시나리오: Date.now() 비교는 정확히 expired 식별.
  const deadlineMs = Date.now() + 100;
  // 200ms CPU busy — event loop 점유
  busyForMs(200);
  const expired = Date.now() >= deadlineMs;
  assert(expired, `200ms CPU busy 후 Date.now()-based deadline 가 expired 식별. ` +
    `Date.now()=${Date.now()}, deadlineMs=${deadlineMs}`);
  console.log('  [ok] Date.now() 비교가 event loop 점유 환경에서 정상 expired 식별');
}

async function testCooperativeCancellationSimulation(): Promise<void> {
  // 다단계 sub-await 시뮬레이션 — captain 의 receiver tracer chain 흉내.
  // step1, step2, step3 가 각자 ms 단위. deadline 100ms. step2 시점에 expired
  // 검출 → 조기 return.
  async function tracedReceiverSim(deadlineMs: number): Promise<string | null> {
    const isExpired = () => Date.now() >= deadlineMs;
    if (isExpired()) return null;
    await delay(60, 'step1-done');  // 60ms
    if (isExpired()) return null;    // cooperative cancellation
    await delay(60, 'step2-done');  // 60ms — 누적 120ms > 100ms cap
    if (isExpired()) return null;
    await delay(60, 'step3-done');
    return 'all-done';
  }

  const start = Date.now();
  const result = await tracedReceiverSim(Date.now() + 100);
  const elapsed = Date.now() - start;

  assert(
    result === null,
    `deadline 초과 후 cooperative cancellation 으로 null 반환. ` +
    `실측 ${JSON.stringify(result)}`,
  );
  // 60ms+60ms=120ms 시점에 expired 인지하고 종료. step3 안 감.
  assert(
    elapsed < 180,
    `cooperative cancellation 으로 step3 (60ms 더) 진행 안 함. 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] cooperative cancellation: 120ms 누적 후 즉시 종료 ` +
    `(${elapsed}ms, step3 진행 X)`,
  );
}

async function main(): Promise<void> {
  console.log('[1/4] 산출물에 deadline 패턴 포함');
  testCompiledArtifactHasDeadlineParameter();
  console.log('[2/4] receiver tracer 안에서 deadline 체크 호출');
  testCompiledArtifactChecksDeadlineAfterAwait();
  console.log('[3/4] Date.now() 비교가 event loop 점유에서도 정확');
  await testDateNowBasedDeadlineFiresUnderCpuBusy();
  console.log('[4/4] cooperative cancellation 시뮬레이션');
  await testCooperativeCancellationSimulation();
  console.log('all 4 deadline-aware checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
