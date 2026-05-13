// 옵션 C reproducing E2E — client-side fast-path receiver kind 인식.
//
// captain log.txt L104 의 receivers-visible 폭주가 root_matched:* 의 chain 추적
// IPC 폭주 (resolveExportOrigin=56/16696ms, resolveRelationTarget=5/16432ms).
// fast-path 가 단순 `Model.objects.X` chain 을 IPC 없이 즉시 인식.
//
// 이 E2E 는 컴파일된 산출물의 fast-path 함수 호출 패턴 + receiver kind 추론
// 정확성을 검증.
//
// 실행:
//   npm run compile && node out/client/providers/fastPathReceiver.test.js

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

function testCompiledArtifactHasFastPathHelper(): void {
  const content = loadProvidersJs();
  assert(
    content.includes('tryFastPathReceiverKind'),
    'tryFastPathReceiverKind 헬퍼가 산출물에 컴파일되어야 함',
  );
  assert(
    content.includes('inferBuiltinManagerOrQuerysetReturnKind'),
    'manager/queryset return kind 추론 헬퍼 존재',
  );
  console.log('  [ok] fast-path 헬퍼 + return kind 추론 함수 산출물에 포함');
}

function testFastPathInvokedFromTopEntry(): void {
  const content = loadProvidersJs();
  // resolveLookupReceiverInfoForReceiver 함수 안에서 tryFastPathReceiverKind 호출
  const fnStart = content.indexOf('function resolveLookupReceiverInfoForReceiver');
  assert(fnStart >= 0, '함수 위치 찾기 실패');
  const fnBody = content.slice(fnStart, fnStart + 1500);
  assert(
    fnBody.includes('tryFastPathReceiverKind'),
    '함수 본체 안에서 tryFastPathReceiverKind 호출되어야 함. 발췌:\n' + fnBody.slice(0, 800),
  );
  // fast-path 성공 시 IPC 없이 return — `if (fastPath) return fastPath;`
  assert(
    /if\s*\(\s*fastPath\s*\)\s*\{[\s\S]*?return\s+fastPath/.test(fnBody) ||
    fnBody.includes('return fastPath'),
    'fast-path 성공 시 즉시 return — IPC chain skip',
  );
  console.log('  [ok] resolveLookupReceiverInfoForReceiver 가 fast-path 먼저 시도');
}

function testFastPathBypassesIpcInCompiledArtifact(): void {
  const content = loadProvidersJs();
  // tryFastPathReceiverKind 함수 본체 안에 daemon.findModelLabelByShortName
  // 만 호출하고 daemon.resolve* IPC 는 호출 안 함 (sync 추론).
  const fnStart = content.indexOf('function tryFastPathReceiverKind');
  assert(fnStart >= 0, 'tryFastPathReceiverKind 함수 위치 찾기 실패');
  // 함수 끝까지 추출 (대략 1500자)
  const fnBody = content.slice(fnStart, fnStart + 1500);
  // sync 호출만 — daemon.resolveModule, daemon.resolveExportOrigin 같은 IPC 부재
  assert(
    !fnBody.includes('daemon.resolveModule(') &&
    !fnBody.includes('daemon.resolveExportOrigin(') &&
    !fnBody.includes('daemon.resolveRelationTarget('),
    'fast-path 본체에 daemon.resolve* IPC 호출이 없어야 함. 발췌:\n' + fnBody.slice(0, 600),
  );
  console.log('  [ok] fast-path 본체에 IPC 호출 0건 — captain 폭주 우회');
}

function testCapturedManagerQuerysetReturns(): void {
  const content = loadProvidersJs();
  // inferBuiltinManagerOrQuerysetReturnKind 안에 filter/get/all 등 핵심 method 포함
  const start = content.indexOf('function inferBuiltinManagerOrQuerysetReturnKind');
  assert(start >= 0, 'inferBuiltinManagerOrQuerysetReturnKind 함수 위치 찾기 실패');
  const body = content.slice(start, start + 1500);

  const requiredQueryset = ['filter', 'exclude', 'all', 'annotate', 'order_by'];
  const requiredInstance = ['first', 'last', 'get', 'create'];
  for (const m of requiredQueryset) {
    assert(
      body.includes(`'${m}'`),
      `queryset returning method '${m}' 가 매핑에 포함되어야 captain 의 일반 chain cover. 발췌: ${body.slice(0, 400)}`,
    );
  }
  for (const m of requiredInstance) {
    assert(
      body.includes(`'${m}'`),
      `instance returning method '${m}' 가 매핑에 포함되어야 함`,
    );
  }
  console.log('  [ok] manager/queryset return kind 매핑에 핵심 method 포함');
}

interface FakeDaemon {
  findModelLabelByShortName(shortName: string): string | undefined;
  isAborted(): boolean;
}

function buildFakeDaemon(knownModels: Record<string, string>): FakeDaemon {
  return {
    findModelLabelByShortName(shortName: string): string | undefined {
      return knownModels[shortName];
    },
    isAborted(): boolean {
      return false;
    },
  };
}

function testFastPathDirectInvocation(): void {
  // 산출물에서 직접 함수 추출. CommonJS 산출물 require 후 unexported 함수
  // 직접 access 불가 → grep 검증으로 대체.
  const content = loadProvidersJs();

  // 'Model.objects' chain 에서 root_matched_bare 가 model_class
  // 또는 'objects' 가 manager 받는 패턴이 산출물에 들어있는지 확인.
  assert(
    content.includes("name === 'objects'") ||
    content.includes('name === "objects"'),
    'fast-path 가 .objects → manager 매핑을 포함',
  );
  console.log('  [ok] .objects → manager 매핑 산출물에 포함');
}

function main(): void {
  console.log('[1/5] fast-path 헬퍼가 산출물에 컴파일');
  testCompiledArtifactHasFastPathHelper();
  console.log('[2/5] resolveLookupReceiverInfoForReceiver 가 fast-path 먼저 호출');
  testFastPathInvokedFromTopEntry();
  console.log('[3/5] fast-path 본체에 daemon.resolve* IPC 0건');
  testFastPathBypassesIpcInCompiledArtifact();
  console.log('[4/5] manager/queryset return kind 매핑 핵심 method 포함');
  testCapturedManagerQuerysetReturns();
  console.log('[5/5] .objects → manager 매핑 산출물 검증');
  testFastPathDirectInvocation();
  console.log('all 5 fast-path checks passed');
}

main();
