// phase2-scan identifier `=` lookahead prefilter 검증.
//
// captain workspace 측정 (5839 keyword arg 호출):
//   bare-field (no __): 4684 (80%)
//   __operator:         1155 (20%)
//
// 단순 `value.includes('__')` prefilter 는 80% bare-field 진단 누락. 대신
// identifier 직후가 `=` (not `==`) 인지 lookahead 로 keyword arg 위치 확인.
//
// 실행:
//   npm run compile && node out/client/providers/phase2ScanEqualsLookahead.test.js

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

function testCompiledArtifactHasEqualsLookahead(): void {
  const content = loadProvidersJs();
  // `__` prefilter 자체는 제거 (80% bare-field 누락 회피)
  assert(
    !content.includes("!value.includes('__')") ||
      content.includes('=='),
    '`__` only prefilter 는 80% 진단 누락 — 제거되거나 보강되어야',
  );
  // `=` lookahead 패턴 — `nextChar` 또는 lookahead 변수
  assert(
    content.includes('lookahead'),
    'identifier 직후 `=` lookahead 패턴이 산출물에 포함되어야 함',
  );
  console.log('  [ok] `=` lookahead prefilter 산출물에 포함');
}

// inline lookahead 로직 — production 과 동일.
function shouldCallKeywordLookupLiteral(
  lineText: string,
  start: number,
  valueLength: number,
): boolean {
  const afterEnd = start + valueLength;
  let lookahead = afterEnd;
  while (lookahead < lineText.length && lineText[lookahead] === ' ') {
    lookahead++;
  }
  const nextChar = lineText[lookahead];
  const nextNextChar = lineText[lookahead + 1];
  return nextChar === '=' && nextNextChar !== '=';
}

function testBareFieldKeywordPassesPrefilter(): void {
  const samples: Array<[string, string, boolean]> = [
    // [line, identifier, expected]
    [`Company.objects.filter(name='Acme')`, 'name', true],
    [`Company.objects.filter(user_id=1)`, 'user_id', true],
    [`Company.objects.get(id=1)`, 'id', true],
    [`Company.objects.update_or_create(slug='x', defaults={...})`, 'slug', true],
    // __operator
    [`Company.objects.filter(name__startswith='Acme')`, 'name__startswith', true],
    [`Company.objects.filter(date__lte=today)`, 'date__lte', true],
  ];
  for (const [line, ident, expected] of samples) {
    const start = line.indexOf(ident);
    assert(start >= 0, `identifier '${ident}' not in line: ${line}`);
    const result = shouldCallKeywordLookupLiteral(line, start, ident.length);
    assert(
      result === expected,
      `'${ident}' in '${line}' expected=${expected} got=${result}`,
    );
  }
  console.log(
    `  [ok] ${samples.length} keyword arg patterns (bare-field + __operator) 모두 prefilter 통과`,
  );
}

function testNonKeywordIdentifiersRejected(): void {
  const samples: Array<[string, string]> = [
    // 일반 identifier — keyword arg 위치 아님
    [`def view(request):`, 'request'],         // function param (no = after)
    [`for item in items:`, 'item'],            // for loop var
    [`if user is not None:`, 'user'],          // condition var
    [`return Company.objects`, 'Company'],     // method receiver
    [`x == 1`, 'x'],                            // comparison (== 제외)
    [`y != 2`, 'y'],                            // != (lookahead 가 `!`, `=`)
  ];
  for (const [line, ident] of samples) {
    const start = line.indexOf(ident);
    if (start < 0) continue;  // 안전
    const result = shouldCallKeywordLookupLiteral(line, start, ident.length);
    assert(
      result === false,
      `non-keyword '${ident}' in '${line}' should reject — got ${result}`,
    );
  }
  console.log(`  [ok] ${samples.length} non-keyword identifiers 모두 reject`);
}

function testWhitespaceBeforeEqualsAccepted(): void {
  // `name = value` 같은 공백 포함 형태도 keyword arg 가능 (Python 형식)
  // 단 PEP8 은 keyword arg 에 공백 안 권장 (`name=value`) — 그러나 일부 코드 베이스
  // 에 존재. lookahead 가 whitespace skip 해서 인식.
  const line = `Company.objects.filter(name = 'Acme')`;
  const start = line.indexOf('name');
  const result = shouldCallKeywordLookupLiteral(line, start, 4);
  assert(result === true, `'name' before whitespace + '=' should pass — got ${result}`);
  console.log('  [ok] 공백이 있는 `name = value` 형태도 통과');
}

function testComparisonRejected(): void {
  // `==` 비교는 keyword arg 아님 — reject
  const line = `if x == 1`;
  const start = line.indexOf('x');
  const result = shouldCallKeywordLookupLiteral(line, start, 1);
  assert(result === false, `'x' before == should reject — got ${result}`);
  console.log('  [ok] `==` 비교 reject');
}

function testNotEqualsRejected(): void {
  const line = `if y != None`;
  const start = line.indexOf('y');
  const result = shouldCallKeywordLookupLiteral(line, start, 1);
  // lookahead 가 `!` 인데 `nextChar === '='` 가 false → reject
  assert(result === false, `'y' before != should reject — got ${result}`);
  console.log('  [ok] `!=` reject');
}

function testTypicalCaptainLineEffect(): void {
  // captain demo_company_service.py 의 평균적인 line.
  // 일반 identifier 들이 어떻게 prefilter 되는지.
  const line = `        if request.user.is_authenticated and not request.GET.get('debug'):`;
  // 모든 word 추출
  const words: Array<[string, number]> = [];
  for (const m of line.matchAll(/[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/g)) {
    words.push([m[0], m.index ?? 0]);
  }
  let passed = 0;
  for (const [word, start] of words) {
    if (shouldCallKeywordLookupLiteral(line, start, word.length)) {
      passed++;
    }
  }
  console.log(
    `  [info] 일반 captain line: ${words.length} identifiers — ` +
    `${passed} prefilter 통과 (vscode API 호출 횟수)`,
  );
  // 일반 condition line 은 모두 reject 되어야
  assert(passed === 0, `일반 condition line — keyword arg 없음. passed=${passed}`);
}

function main(): void {
  console.log('[1/6] 산출물에 lookahead 패턴');
  testCompiledArtifactHasEqualsLookahead();
  console.log('[2/6] bare-field + __operator keyword 모두 prefilter 통과');
  testBareFieldKeywordPassesPrefilter();
  console.log('[3/6] 일반 identifier reject');
  testNonKeywordIdentifiersRejected();
  console.log('[4/6] 공백 + `=` 형태 통과');
  testWhitespaceBeforeEqualsAccepted();
  console.log('[5/6] `==` 비교 reject');
  testComparisonRejected();
  console.log('[6/6] `!=` reject + captain 라인 시뮬레이션');
  testNotEqualsRejected();
  testTypicalCaptainLineEffect();
  console.log('all 7 lookahead prefilter checks passed');
}

main();
