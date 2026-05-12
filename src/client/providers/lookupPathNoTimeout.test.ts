// 옵션 3-b reproducing E2E — resolveLookupPath IPC 호출에 timeout cap 부재.
//
// captain log.txt:386 발췌:
//   wall=9708ms ... lookup-ipc-ms=5235 ...
//   ipc-by-method=[cachedRequest:resolveLookupPath=1/5234ms, ...]
//
// 단일 resolveLookupPath 호출이 5.2초 걸리는데 client 는 cap 없이 그냥
// 기다림. 옵션 3 의 PER_RECEIVER_TIMEOUT_MS=1500ms 가드는
// `resolveLookupReceiverInfoForReceiver` 에만 race 되고 lookup-path 호출은
// race 없음. captain 의 또 다른 폭주 경로.
//
// 이 E2E 는 두 가지를 검증:
//   1. 산출물에서 daemon.resolveLookupPath 호출이 직접 await 됨 (cap 없음)
//   2. Promise.race / setTimeout 으로 감싸진 wrapper 가 존재하지 않음
//   3. 시뮬레이션: 단일 호출이 5초 걸리면 client 도 5초 await
//
// 실행:
//   npm run compile && node out/client/providers/lookupPathNoTimeout.test.js

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

async function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function testCompiledArtifactHasNoLookupPathCap(): void {
  const content = loadProvidersJs();
  // PER_RECEIVER_TIMEOUT_MS 는 receiver 전용. lookup-path 용 cap 상수가
  // 도입되었다면 옵션 3-b 가 적용된 것 — 현재는 부재해야 함 (이 테스트가
  // 실패하면 fix 적용된 신호, 의도적으로 negative).
  assert(
    content.includes('PER_RECEIVER_TIMEOUT_MS'),
    'sanity: 옵션 3 receiver cap 은 살아 있어야 함',
  );
  assert(
    !content.includes('PER_LOOKUP_PATH_TIMEOUT_MS') &&
      !content.includes('LOOKUP_PATH_TIMEOUT'),
    'captain 버그 재현: lookup-path 전용 timeout cap 상수가 산출물에 부재. ' +
      '옵션 3-b 적용 후 이 단언이 뒤집혀야 함.',
  );
  console.log('  [ok] 산출물에 lookup-path cap 상수 부재 (옵션 3-b 미적용)');
}

function testLookupPathCallsAreNotWrappedInRace(): void {
  const content = loadProvidersJs();
  const lookupPathCalls = (content.match(/\.resolveLookupPath\(/g) ?? []).length;
  assert(
    lookupPathCalls > 0,
    `resolveLookupPath 호출이 적어도 1곳 — 실측 ${lookupPathCalls}`,
  );

  // definition provider 의 `withDeadline + Promise.race` 패턴 ≠ captain 폭주 경로.
  // captain 의 5234ms 폭주(log.txt:386)는 **diagnostic phase** 의 lookup-path
  // 호출에서 발생. 이 경로엔 cap 없음 → `request = daemon.resolveLookupPath(...)`
  // 같은 직접 await 패턴이 산출물에 살아 있어야 negative case.
  const directAwaitPatterns = (
    content.match(/=\s*daemon\.resolveLookupPath\(/g) ?? []
  ).length;
  const awaitPatterns = (
    content.match(/await\s+daemon\.resolveLookupPath\(/g) ?? []
  ).length;
  const directOrAwait = directAwaitPatterns + awaitPatterns;
  assert(
    directOrAwait > 0,
    `diagnostic phase 의 lookup-path 호출은 race 없이 직접 호출되어야 ` +
      `captain 폭주가 설명됨. 직접 호출 패턴 ${directOrAwait}곳 발견되어야 함.`,
  );
  // race 안에 들어간 호출은 definition provider 한정이어야 함 (1개 이하).
  const racePatterns =
    content.match(/Promise\.race\(\s*\[[^\]]*resolveLookupPath/g) ?? [];
  assert(
    racePatterns.length <= 1,
    `Promise.race 안에 lookup-path 가 ${racePatterns.length}회 발견 — ` +
      `1회는 definition provider 의 withDeadline 패턴(정상). 그 이상이면 ` +
      `옵션 3-b 가 이미 부분 적용된 상태일 수 있음.`,
  );
  console.log(
    `  [ok] resolveLookupPath 호출 ${lookupPathCalls}곳 중 직접 호출 ` +
      `${directOrAwait}곳 / race-wrapped ${racePatterns.length}곳 (definition 한정)`,
  );
}

async function testUnboundedAwaitOnSlowLookupPath(): Promise<void> {
  // 시뮬레이션: daemon-side 가 5초 걸리는 응답을 보내면, cap 없는 await 은
  // 5초 그대로 block. captain L386 의 5234ms 폭주 패턴 재현.
  const fakeIpcCall = (): Promise<{ resolved: true; path: string }> =>
    delay(2_500, { resolved: true as const, path: 'company.id' });

  const start = Date.now();
  // 옵션 3-b 가 없으므로 그냥 await — cap 없이 2.5초 block.
  const result = await fakeIpcCall();
  const elapsed = Date.now() - start;

  assert(result.resolved, 'mock IPC 가 resolve 되어야 함');
  assert(
    elapsed > 2_400,
    `cap 없는 await 은 underlying 시간(2500ms) 만큼 block — 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] cap 없는 lookup-path: ${elapsed}ms 그대로 await ` +
      `(captain 의 5234ms 폭주가 그대로 client phase budget 소진)`,
  );
}

async function testHypotheticalCapWouldBoundElapsedTime(): Promise<void> {
  // 가설 검증: 만약 옵션 3-b 가 1500ms cap 을 적용했다면 동일 5초 underlying
  // 도 1500ms 안에 끊을 수 있음. 옵션 3-c 와 결합되면 phase 누적도 사라짐.
  async function withCap<T>(
    underlying: Promise<T>,
    capMs: number,
  ): Promise<T | null> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), capMs);
    });
    try {
      const raced = await Promise.race<T | null>([underlying, timeoutPromise]);
      return raced;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  const start = Date.now();
  const result = await withCap(
    delay(5_000, { resolved: true as const, path: 'company.id' }),
    1_500,
  );
  const elapsed = Date.now() - start;

  assert(result === null, 'cap 이 우승해서 null — captain 의 5234ms 폭주 가상 fix');
  assert(
    elapsed < 1_700,
    `cap 1500ms 안에 끊겨야 함 — 실측 ${elapsed}ms`,
  );
  console.log(
    `  [ok] 가상 옵션 3-b cap=1500ms: ${elapsed}ms 만에 차단 ` +
      `(5234ms vs ${elapsed}ms = ${Math.round(5234 / elapsed)}배 개선 예상)`,
  );
}

async function main(): Promise<void> {
  console.log('[1/4] 산출물에 lookup-path cap 상수 부재 (옵션 3-b 미적용 확인)');
  testCompiledArtifactHasNoLookupPathCap();
  console.log('[2/4] resolveLookupPath 호출이 Promise.race 로 감싸지지 않음');
  testLookupPathCallsAreNotWrappedInRace();
  console.log('[3/4] cap 없는 await 으로 underlying 시간 그대로 block');
  await testUnboundedAwaitOnSlowLookupPath();
  console.log('[4/4] 가상 옵션 3-b cap 적용 시 차단 효과 (fix 가이드)');
  await testHypotheticalCapWouldBoundElapsedTime();
  console.log('all 4 lookup-path-cap patterns reproduced');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
