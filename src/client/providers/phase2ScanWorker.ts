// captain D — phase2-scan 의 line-by-line regex 본체를 worker thread 에서.
//
// main thread block 해소가 핵심 목적. worker 안에서 동일 regex 로 scan, 결과는
// plain object 로 transfer. main 에서 vscode.Range/Position 변환.
//
// 활성화: env DJLS_PHASE2_SCAN_WORKER=1
//
// captain 측정 (E) 결과 보고 lineAt/offsetAt 이 hotspot 이면 worker 효과 큼.
// regex 가 hotspot 이면 worker 안에서도 동일 비용 — main thread block 해소만.

import { parentPort, isMainThread } from 'worker_threads';

interface ScanRequest {
  documentText: string;
  startLine: number;
  endLine: number;
}

export interface ScanResultEntry {
  // plain numbers — vscode.Range/Position 은 main thread 에서 생성
  line: number;
  charStart: number;
  charEnd: number;
  lineStartOffset: number;
  value: string;
  method: string;
  patternKind:
    | 'lookup'
    | 'prefetch'
    | 'dict-key'
    | 'f-expression'
    | 'expression-string';
}

// Patterns — main module 과 동일. duplicate 이지만 worker self-contained.
const LOOKUP_METHOD_PATTERN_STR =
  'values|values_list|order_by|only|defer|select_related|prefetch_related|filter|exclude|get|get_or_create|update_or_create';
const LOOKUP_HOVER_PATTERN = new RegExp(
  String.raw`\.(${LOOKUP_METHOD_PATTERN_STR})\(\s*(['"])([-\w.]+)\2`,
  'g',
);
const PREFETCH_LOOKUP_HOVER_PATTERN =
  /(?:[A-Za-z_][\w.]*\.)?Prefetch\(\s*(['"])([-\w.]+)\1/g;
const LOOKUP_DICT_KEY_HOVER_PATTERN =
  /(?:\*\*\{\s*|,\s*)(?:[rRuUbBfF]{0,2})(['"])([^'"]+)\1\s*:/g;
const F_EXPRESSION_HOVER_PATTERN = new RegExp(
  String.raw`(?:^|[^\w.])(?:[A-Za-z_][\w.]*\.)?F\(\s*(['"])([-\w.]+)\1`,
  'g',
);
const EXPRESSION_STRING_HOVER_PATTERN = /(['"])([-\w.]+)\1/g;

export function runWorkerScan(req: ScanRequest): ScanResultEntry[] {
  const { documentText, startLine, endLine } = req;
  // line 분해 + 각 라인 시작 offset 계산을 한 번에.
  const lines: Array<{ text: string; startOffset: number }> = [];
  let cursor = 0;
  let lineIdx = 0;
  while (cursor <= documentText.length && lineIdx < endLine) {
    const nl = documentText.indexOf('\n', cursor);
    const end = nl === -1 ? documentText.length : nl;
    if (lineIdx >= startLine) {
      lines.push({ text: documentText.slice(cursor, end), startOffset: cursor });
    }
    if (nl === -1) break;
    cursor = nl + 1;
    lineIdx++;
  }

  const results: ScanResultEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const absLine = startLine + i;
    const { text: lineText, startOffset: lineStartOffset } = lines[i];

    for (const match of lineText.matchAll(LOOKUP_HOVER_PATTERN)) {
      const [, method, , value] = match;
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      results.push({
        line: absLine,
        charStart: start,
        charEnd: start + value.length,
        lineStartOffset,
        value,
        method,
        patternKind: 'lookup',
      });
    }

    for (const match of lineText.matchAll(PREFETCH_LOOKUP_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      results.push({
        line: absLine,
        charStart: start,
        charEnd: start + value.length,
        lineStartOffset,
        value,
        method: 'prefetch',
        patternKind: 'prefetch',
      });
    }

    for (const match of lineText.matchAll(LOOKUP_DICT_KEY_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      results.push({
        line: absLine,
        charStart: start,
        charEnd: start + value.length,
        lineStartOffset,
        value,
        method: '',
        patternKind: 'dict-key',
      });
    }

    for (const match of lineText.matchAll(F_EXPRESSION_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      results.push({
        line: absLine,
        charStart: start,
        charEnd: start + value.length,
        lineStartOffset,
        value,
        method: 'f_expression',
        patternKind: 'f-expression',
      });
    }

    for (const match of lineText.matchAll(EXPRESSION_STRING_HOVER_PATTERN)) {
      const value = match[2];
      const start = (match.index ?? 0) + 1;
      results.push({
        line: absLine,
        charStart: start,
        charEnd: start + value.length,
        lineStartOffset,
        value,
        method: 'expression_string',
        patternKind: 'expression-string',
      });
    }
  }

  return results;
}

// Worker entry. 단일 message → scan → response.
if (!isMainThread && parentPort) {
  parentPort.on('message', (req: ScanRequest) => {
    try {
      const results = runWorkerScan(req);
      parentPort!.postMessage({ ok: true, results });
    } catch (error) {
      parentPort!.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
