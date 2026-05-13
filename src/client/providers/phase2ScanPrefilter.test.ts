// phase2-scan regex prefilter 검증 — captain L87 의 regex_other=2661ms 폭주
// 의 진짜 원인이 matchAll generator 호출 자체임을 측정으로 확정 후, mandatory
// substring 빠른 indexOf prefilter 로 matchAll skip 가능 lines 분기.
//
// 이 E2E 는:
//   1. prefilter 가 false-negative 없는지 (각 regex 의 mandatory substring 정확)
//   2. captain 같은 큰 파일 (2000 lines, 75% lookup 패턴 없음) 에서 측정
//   3. 컴파일 산출물에 prefilter 코드 존재
//
// 실행:
//   npm run compile && node out/client/providers/phase2ScanPrefilter.test.js

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

function testCompiledArtifactHasPrefilters(): void {
  const content = loadProvidersJs();
  // 3개 prefilter 변수 존재
  assert(content.includes('hasLookupMethodHint'), 'LOOKUP prefilter 변수');
  assert(content.includes('hasPrefetchHint'), 'PREFETCH prefilter');
  assert(content.includes('hasFExpressionHint'), 'F_EXPRESSION prefilter');

  // mandatory substring 들 모두 포함
  const requiredHints = [
    '.values(', '.values_list(', '.order_by(', '.only(',
    '.defer(', '.select_related(', '.prefetch_related(',
    'Prefetch(', 'F(',
  ];
  for (const hint of requiredHints) {
    assert(
      content.includes(hint),
      `prefilter mandatory substring '${hint}' 가 산출물에 포함되어야 함`,
    );
  }
  console.log('  [ok] 3 prefilters + 9 mandatory substrings 산출물 포함');
}

function testPrefilterFalseNegativeSafety(): void {
  // 5 regex 의 mandatory substring 이 정확한지 — 매칭되는 모든 케이스가 prefilter
  // 를 통과해야 함.
  const LOOKUP_HOVER_PATTERN = /\.(values|values_list|order_by|only|defer|select_related|prefetch_related)\(\s*(['"])([-\w.]+)\2/g;
  const PREFETCH_PATTERN = /(?:[A-Za-z_][\w.]*\.)?Prefetch\(\s*(['"])([-\w.]+)\1/g;
  const F_PATTERN = /(?:^|[^\w.])(?:[A-Za-z_][\w.]*\.)?F\(\s*(['"])([-\w.]+)\1/g;

  // 다양한 captain-realistic samples
  const samples = [
    'Company.objects.values("id", "name")',
    'qs.values_list("id", flat=True)',
    'Company.objects.order_by("-created_at")',
    'Company.objects.only("name")',
    'Company.objects.defer("description")',
    'Company.objects.select_related("user")',
    'Company.objects.prefetch_related("memberships")',
    'Article.objects.prefetch_related(Prefetch("comments"))',
    'F("user__name")',
    'Company.objects.annotate(x=F("count"))',
  ];

  let trueMatches = 0;
  let prefilterMatches = 0;
  for (const line of samples) {
    // 실제 regex 매칭 결과
    const hasLookup = [...line.matchAll(LOOKUP_HOVER_PATTERN)].length > 0;
    const hasPrefetch = [...line.matchAll(PREFETCH_PATTERN)].length > 0;
    const hasF = [...line.matchAll(F_PATTERN)].length > 0;
    const anyMatch = hasLookup || hasPrefetch || hasF;
    if (anyMatch) trueMatches++;

    // prefilter 결과
    const hasLookupMethodHint =
      line.indexOf('.values(') >= 0 ||
      line.indexOf('.values_list(') >= 0 ||
      line.indexOf('.order_by(') >= 0 ||
      line.indexOf('.only(') >= 0 ||
      line.indexOf('.defer(') >= 0 ||
      line.indexOf('.select_related(') >= 0 ||
      line.indexOf('.prefetch_related(') >= 0;
    const hasPrefetchHint = line.indexOf('Prefetch(') >= 0;
    const hasFExpressionHint = line.indexOf('F(') >= 0;
    const anyHint = hasLookupMethodHint || hasPrefetchHint || hasFExpressionHint;
    if (anyHint) prefilterMatches++;

    // false-negative 검증: regex 매칭되면 prefilter 도 매칭
    if (hasLookup) assert(hasLookupMethodHint, `LOOKUP false-negative: ${line}`);
    if (hasPrefetch) assert(hasPrefetchHint, `PREFETCH false-negative: ${line}`);
    if (hasF) assert(hasFExpressionHint, `F false-negative: ${line}`);
  }

  assert(trueMatches > 0, 'sample 들이 실제 매칭되어야 검증 유효');
  console.log(
    `  [ok] ${samples.length} samples, regex matches=${trueMatches}, ` +
    `prefilter matches=${prefilterMatches} (false-negative 0)`,
  );
}

function testPrefilterRejectsLinesWithoutPatterns(): void {
  const noPatternLines = [
    'def view(request):',
    '    pass',
    '# comment',
    'x = 1 + 2',
    'class Company:',
    '    objects = manager()',  // .objects.values 같은 method 없음
    'return None',
    'if x > 0: y = x * 2',
  ];

  let prefilterPasses = 0;
  for (const line of noPatternLines) {
    const hasLookupMethodHint =
      line.indexOf('.values(') >= 0 ||
      line.indexOf('.values_list(') >= 0 ||
      line.indexOf('.order_by(') >= 0 ||
      line.indexOf('.only(') >= 0 ||
      line.indexOf('.defer(') >= 0 ||
      line.indexOf('.select_related(') >= 0 ||
      line.indexOf('.prefetch_related(') >= 0;
    const hasPrefetchHint = line.indexOf('Prefetch(') >= 0;
    const hasFExpressionHint = line.indexOf('F(') >= 0;
    if (hasLookupMethodHint || hasPrefetchHint || hasFExpressionHint) {
      prefilterPasses++;
    }
  }
  assert(
    prefilterPasses === 0,
    `lookup 패턴 없는 라인들이 모두 prefilter 거절되어야 함 — ` +
    `실측 ${prefilterPasses}/${noPatternLines.length} pass`,
  );
  console.log(`  [ok] ${noPatternLines.length} no-pattern lines 100% reject`);
}

function testLargeFileSimulationPerformance(): void {
  // captain 시나리오: 2198 lines, 대부분 매칭 없음. matchAll 비용 vs prefilter 단축.
  const lines: string[] = [];
  for (let i = 0; i < 2198; i++) {
    if (i % 10 === 0) {
      lines.push(`X${i}.objects.values("id_${i}", "name_${i}")`);
    } else {
      lines.push(`# ${i} ${'a'.repeat(150)}`);  // 긴 라인 (captain 평균과 유사)
    }
  }

  // Without prefilter: matchAll always
  const start1 = Date.now();
  let count1 = 0;
  const LOOKUP_HOVER_PATTERN = /\.(values|values_list|order_by|only|defer|select_related|prefetch_related)\(\s*(['"])([-\w.]+)\2/g;
  for (const line of lines) {
    for (const _ of line.matchAll(LOOKUP_HOVER_PATTERN)) count1++;
  }
  const elapsed1 = Date.now() - start1;

  // With prefilter
  const start2 = Date.now();
  let count2 = 0;
  for (const line of lines) {
    const hasHint =
      line.indexOf('.values(') >= 0 ||
      line.indexOf('.values_list(') >= 0 ||
      line.indexOf('.order_by(') >= 0 ||
      line.indexOf('.only(') >= 0 ||
      line.indexOf('.defer(') >= 0 ||
      line.indexOf('.select_related(') >= 0 ||
      line.indexOf('.prefetch_related(') >= 0;
    if (hasHint) {
      for (const _ of line.matchAll(LOOKUP_HOVER_PATTERN)) count2++;
    }
  }
  const elapsed2 = Date.now() - start2;

  assert(count1 === count2, `matching count 동일해야 — ${count1} vs ${count2}`);
  console.log(
    `  [ok] 2198 lines: no-prefilter ${elapsed1}ms vs with-prefilter ${elapsed2}ms ` +
    `(${(elapsed1 / Math.max(elapsed2, 1)).toFixed(1)}x faster), matches=${count1}`,
  );
}

function main(): void {
  console.log('[1/4] 컴파일된 산출물에 3 prefilters + mandatory substrings');
  testCompiledArtifactHasPrefilters();
  console.log('[2/4] prefilter false-negative 0 — 매칭 lines 모두 통과');
  testPrefilterFalseNegativeSafety();
  console.log('[3/4] prefilter 가 패턴 없는 lines 100% reject');
  testPrefilterRejectsLinesWithoutPatterns();
  console.log('[4/4] 2198-line 시뮬레이션 with vs without prefilter');
  testLargeFileSimulationPerformance();
  console.log('all 4 prefilter checks passed');
}

main();
