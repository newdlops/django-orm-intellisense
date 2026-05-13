// E2E for D — phase2-scan worker logic.
//
// worker entry 안의 regex scan 로직을 standalone 으로 검증.
// vscode 의존성 없음 — runWorkerScan 함수 직접 호출.
//
// 실행:
//   npm run compile && node out/client/providers/phase2ScanWorker.test.js

import { runWorkerScan } from './phase2ScanWorker';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function testOrderByLookupDetected(): void {
  // LOOKUP_HOVER_PATTERN 매칭 method 들: values|values_list|order_by|only|defer|
  // select_related|prefetch_related. filter 는 KEYWORD_LOOKUP_METHOD_PATTERN
  // 로 별도 처리 (keywordLookupLiteral) — worker 본체에는 포함 안 됨.
  const text = [
    'def view(request):',
    '    return Company.objects.order_by("-name", "id")',
    '',
  ].join('\n');
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 3 });
  const lookups = results.filter((r) => r.patternKind === 'lookup');
  // regex 는 `\.method\(\s*['"]([-\w.]+)['"]` — method 호출의 첫 quoted 인자만.
  assert(lookups.length === 1, `1 lookup 매칭 예상 (첫 인자), got ${lookups.length}`);
  assert(lookups[0].method === 'order_by', `expected order_by, got ${lookups[0].method}`);
  assert(lookups[0].value === '-name', `expected -name, got ${lookups[0].value}`);
  assert(lookups[0].line === 1, `expected line 1, got ${lookups[0].line}`);
  console.log('  [ok] .order_by("-name", ...) 첫 인자 lookup 감지');
}

function testPrefetchPatternDetected(): void {
  const text = `Article.objects.prefetch_related(Prefetch('comments'))`;
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 1 });
  const prefetch = results.find((r) => r.patternKind === 'prefetch');
  assert(prefetch !== undefined, 'prefetch 매칭');
  assert(prefetch.value === 'comments', `expected comments, got ${prefetch.value}`);
  console.log('  [ok] Prefetch("...") 감지');
}

function testDictKeyDetected(): void {
  const text = `Company.objects.filter(**{'name__startswith': 'Acme'})`;
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 1 });
  const dictKey = results.find((r) => r.patternKind === 'dict-key');
  assert(dictKey !== undefined, 'dict-key 매칭');
  assert(dictKey.value === 'name__startswith', `got ${dictKey.value}`);
  console.log('  [ok] **{"key": ...} dict key 감지');
}

function testFExpressionDetected(): void {
  const text = `Company.objects.annotate(x=F('user__name'))`;
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 1 });
  const fexpr = results.find((r) => r.patternKind === 'f-expression');
  assert(fexpr !== undefined, 'F expression 매칭');
  assert(fexpr.value === 'user__name', `expected user__name, got ${fexpr.value}`);
  console.log('  [ok] F("...") expression 감지');
}

function testStartEndLineRespected(): void {
  const text = [
    'a.objects.order_by("x__exact")',  // line 0
    'b.objects.order_by("y__exact")',  // line 1
    'c.objects.order_by("z__exact")',  // line 2
  ].join('\n');
  // line 1 만 scan
  const results = runWorkerScan({ documentText: text, startLine: 1, endLine: 2 });
  const lookups = results.filter((r) => r.patternKind === 'lookup');
  assert(lookups.length === 1, `1 lookup 예상, got ${lookups.length}`);
  assert(lookups[0].value === 'y__exact', `got ${lookups[0].value}`);
  assert(lookups[0].line === 1, `got line ${lookups[0].line}`);
  console.log('  [ok] startLine/endLine 범위 정확히 제한');
}

function testLineStartOffsetCorrect(): void {
  const text = 'aaa\nbbbbb.objects.order_by("c__exact")';
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 2 });
  const lookup = results.find((r) => r.patternKind === 'lookup');
  assert(lookup, 'lookup 패턴 매칭되어야 함');
  // line 1 의 시작 offset = 4 ('aaa\n' 길이)
  assert(
    lookup.lineStartOffset === 4,
    `line 1 startOffset 4 예상, got ${lookup.lineStartOffset}`,
  );
  console.log('  [ok] lineStartOffset 정확');
}

function testLargeFilePerformance(): void {
  // 2000 lines (captain L128 의 phase2-scan:450-2498 와 유사 크기)
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 4 === 0) {
      // order_by 가 LOOKUP_HOVER_PATTERN 매칭. 각 라인에 2 lookups.
      lines.push(`X${i}.objects.order_by("-name${i}", "id${i}")`);
    } else {
      lines.push(`# comment line ${i}`);
    }
  }
  const text = lines.join('\n');

  const start = Date.now();
  const results = runWorkerScan({ documentText: text, startLine: 0, endLine: 2000 });
  const elapsed = Date.now() - start;

  const lookups = results.filter((r) => r.patternKind === 'lookup');
  // 500 lines × 1 first-arg lookup each = 500
  assert(lookups.length === 500, `500 lookups 예상, got ${lookups.length}`);

  // standalone (vscode API 없음) 측정: captain 의 main-thread 5.6s 와 비교 가능.
  // worker 안에서는 vscode.lineAt 없으니 더 빠를 가능성.
  console.log(
    `  [info] 2000 lines / 500 lookups: worker scan ${elapsed}ms ` +
    `(captain main-thread 측정 5.6s 참고)`,
  );
  assert(elapsed < 2000, `worker scan 2초 미만 — 실측 ${elapsed}ms`);
}

function main(): void {
  console.log('[1/7] .order_by(...) 패턴');
  testOrderByLookupDetected();
  console.log('[2/7] Prefetch() 패턴');
  testPrefetchPatternDetected();
  console.log('[3/7] **{} dict-key 패턴');
  testDictKeyDetected();
  console.log('[4/7] F() expression 패턴');
  testFExpressionDetected();
  console.log('[5/7] startLine/endLine 범위 제한');
  testStartEndLineRespected();
  console.log('[6/7] lineStartOffset 정확성');
  testLineStartOffsetCorrect();
  console.log('[7/7] 2000-line 성능 측정');
  testLargeFilePerformance();
  console.log('all 7 worker scan checks passed');
}

main();
