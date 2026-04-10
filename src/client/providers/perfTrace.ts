// ============================================================================
// Django ORM Intellisense — Provider Performance Tracing
// ============================================================================
//
// Always active. Logs to the extension output channel with file:line detail.
// ============================================================================

import * as vscode from 'vscode';

let _output: vscode.OutputChannel | undefined;
let _depth = 0;

export function initPerfTrace(output: vscode.OutputChannel): void {
  _output = output;
}

// ---------------------------------------------------------------------------
// Span-based tracing
// ---------------------------------------------------------------------------

export interface PerfSpan {
  name: string;
  detail: string;
  start: number;
  depth: number;
}

export function traceBegin(name: string, detail: string): PerfSpan {
  const span: PerfSpan = { name, detail, start: performance.now(), depth: _depth };
  _depth++;
  return span;
}

export function traceEnd(span: PerfSpan | undefined, extra?: string): number {
  if (!span) return 0;
  _depth = span.depth;
  const durationMs = performance.now() - span.start;
  if (_output) {
    const indent = '  '.repeat(span.depth);
    const suffix = extra ? ` → ${extra}` : '';
    _output.appendLine(
      `${indent}[PERF] ${span.name}: ${durationMs.toFixed(1)}ms | ${span.detail}${suffix}`
    );
  }
  return durationMs;
}
