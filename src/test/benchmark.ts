// ============================================================================
// Django ORM Intellisense — Synthetic Benchmark
// ============================================================================
//
// Usage:
//   npm run benchmark            # default 5K models, human-readable
//   npm run benchmark:full       # multi-scale (1K, 5K, 10K) + pass/fail
//   npm run benchmark:json       # JSON output for CI
//   node out/test/benchmark.js [count] [--json] [--full]
// ============================================================================

import {
  buildWorkspaceIndex,
  diffSurfaceIndex,
  updateWorkspaceIndexIncremental,
  getOrBuildFieldTrie,
  type SurfaceIndex,
} from '../server/workspaceIndexer.js';
import { getCompletionCandidates } from '../server/lookupResolver.js';
import type { ParsedLookup } from '../server/types.js';

// ---------------------------------------------------------------------------
// Synthetic data generation
// ---------------------------------------------------------------------------

const FIELD_TYPES: Array<[string, string | null]> = [
  ['str', null],
  ['int', null],
  ['bool', null],
  ['datetime', null],
  ['float', null],
  ['Decimal', null],
  ['UUID', null],
  ['date', null],
];

function generateSurfaceIndex(modelCount: number): SurfaceIndex {
  const index: SurfaceIndex = {};

  for (let i = 0; i < modelCount; i++) {
    const label = `app${Math.floor(i / 100)}.Model${i}`;
    const instanceMembers: Record<string, [string, string | null]> = {};

    // 20 scalar fields
    for (let f = 0; f < 20; f++) {
      const fieldType = FIELD_TYPES[f % FIELD_TYPES.length];
      instanceMembers[`field_${f}`] = fieldType;
    }

    // 3 forward FK relations
    for (let r = 0; r < 3; r++) {
      const targetIdx = (i + r + 1) % modelCount;
      const targetLabel = `app${Math.floor(targetIdx / 100)}.Model${targetIdx}`;
      instanceMembers[`fk_${r}`] = [`ForeignKey[${targetLabel}]`, 'instance'];
      instanceMembers[`fk_${r}_id`] = ['int', null];
    }

    // 2 reverse relations
    for (let rv = 0; rv < 2; rv++) {
      const sourceIdx = (i + modelCount - rv - 1) % modelCount;
      const sourceLabel = `app${Math.floor(sourceIdx / 100)}.Model${sourceIdx}`;
      instanceMembers[`reverse_${rv}_set`] = [`RelatedManager[${sourceLabel}]`, 'related_manager'];
    }

    index[label] = { instance: instanceMembers };
  }

  return index;
}

// ---------------------------------------------------------------------------
// Performance budget (from optimization_plan.md [13])
// ---------------------------------------------------------------------------

interface Budget {
  buildWorkspaceIndex: number;
  diffNoOp: number;
  singleModelReindex: number;
  completionP50: number;
  completionP95: number;
  trieP95: number;
  heapMB: number;
}

const BUDGETS: Record<number, Budget> = {
  // Budgets for synthetic data (27 fields/model including FKs + reverse relations).
  // Real-world projects typically have fewer fields per model, so these are
  // conservative upper bounds.
  3000: {
    buildWorkspaceIndex: 150,
    diffNoOp: 10,
    singleModelReindex: 20,
    completionP50: 5,
    completionP95: 15,
    trieP95: 1,
    heapMB: 60,
  },
  15000: {
    buildWorkspaceIndex: 600,
    diffNoOp: 45,
    singleModelReindex: 20,
    completionP50: 5,
    completionP95: 25,
    trieP95: 1,
    heapMB: 250,
  },
  30000: {
    buildWorkspaceIndex: 1500,
    diffNoOp: 90,
    singleModelReindex: 20,
    completionP50: 5,
    completionP95: 30,
    trieP95: 1,
    heapMB: 500,
  },
};

function getBudget(modelCount: number): Budget {
  // Use closest defined budget, or interpolate from largest
  const keys = Object.keys(BUDGETS).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    if (modelCount <= k) return BUDGETS[k];
  }
  // Scale linearly from 30K budget
  const base = BUDGETS[30000];
  const scale = modelCount / 30000;
  return {
    buildWorkspaceIndex: base.buildWorkspaceIndex * scale,
    diffNoOp: base.diffNoOp * scale,
    singleModelReindex: base.singleModelReindex,
    completionP50: base.completionP50,
    completionP95: base.completionP95 + (modelCount - 30000) * 0.001,
    trieP95: base.trieP95,
    heapMB: base.heapMB * scale,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// Benchmark result types
// ---------------------------------------------------------------------------

interface BenchmarkMetrics {
  modelCount: number;
  buildWorkspaceIndexMs: number;
  diffNoOpMs: number;
  diffOneChangedMs: number;
  incrementalUpdateMs: number;
  trieBuildP50Ms: number;
  trieBuildP95Ms: number;
  trieBuildTotalMs: number;
  completionP50Ms: number;
  completionP95Ms: number;
  completionTotalMs: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  totalHeapMB: number;
}

interface BudgetCheck {
  metric: string;
  actual: number;
  budget: number;
  unit: string;
  pass: boolean;
}

interface BenchmarkResult {
  metrics: BenchmarkMetrics;
  checks: BudgetCheck[];
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Single-scale benchmark runner
// ---------------------------------------------------------------------------

function runBenchmark(modelCount: number, quiet = false): BenchmarkResult {
  const log = quiet ? (..._args: unknown[]) => {} : console.log;

  log(`\n${'='.repeat(60)}`);
  log(`Benchmark: ${modelCount} models`);
  log(`${'='.repeat(60)}\n`);

  const memBefore = process.memoryUsage();

  // --- 1. Generate synthetic data ---
  const t0 = performance.now();
  const surfaceIndex = generateSurfaceIndex(modelCount);
  const modelNames = Object.keys(surfaceIndex).map((l) =>
    l.includes('.') ? l.split('.').pop()! : l,
  );
  log(`Generate surfaceIndex: ${formatMs(performance.now() - t0)}`);

  // --- 2. Full build ---
  const t1 = performance.now();
  const index = buildWorkspaceIndex(surfaceIndex, modelNames);
  const buildMs = performance.now() - t1;
  log(`buildWorkspaceIndex: ${formatMs(buildMs)} (${index.models.size} models, tries=lazy)`);

  // --- 3. Diff: no-op ---
  const fingerprints = new Map<string, string>();
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t2 = performance.now();
  const noopDiff = diffSurfaceIndex(surfaceIndex, surfaceIndex, fingerprints);
  const noopMs = performance.now() - t2;
  log(`diffSurfaceIndex (no-op): ${formatMs(noopMs)} (${noopDiff.added.length}+${noopDiff.changed.length}~${noopDiff.removed.length}-)`);

  // --- 4. Diff: 1 model changed ---
  const modifiedIndex = { ...surfaceIndex };
  const firstLabel = Object.keys(surfaceIndex)[0];
  modifiedIndex[firstLabel] = {
    instance: {
      ...surfaceIndex[firstLabel].instance,
      new_field: ['str', null],
    },
  };
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t3 = performance.now();
  const oneDiff = diffSurfaceIndex(surfaceIndex, modifiedIndex, fingerprints);
  const oneDiffMs = performance.now() - t3;
  log(`diffSurfaceIndex (1 changed): ${formatMs(oneDiffMs)} (${oneDiff.added.length}+${oneDiff.changed.length}~${oneDiff.removed.length}-)`);

  // --- 5. Incremental update ---
  const t4 = performance.now();
  updateWorkspaceIndexIncremental(index, modifiedIndex, oneDiff);
  const incrMs = performance.now() - t4;
  log(`updateWorkspaceIndexIncremental (1 changed): ${formatMs(incrMs)}`);

  // --- 6. Lazy trie build ---
  const trieTimings: number[] = [];
  const sampleLabels = Object.keys(surfaceIndex).slice(0, 100);
  for (const label of sampleLabels) {
    const tt = performance.now();
    getOrBuildFieldTrie(index, label);
    trieTimings.push(performance.now() - tt);
  }
  trieTimings.sort((a, b) => a - b);
  log(
    `getOrBuildFieldTrie (${sampleLabels.length} models): ` +
    `p50=${formatMs(percentile(trieTimings, 0.5))} ` +
    `p95=${formatMs(percentile(trieTimings, 0.95))} ` +
    `total=${formatMs(trieTimings.reduce((s, v) => s + v, 0))}`,
  );

  // --- 7. Completion candidates ---
  const completionTimings: number[] = [];
  for (const label of sampleLabels) {
    const parsed: ParsedLookup = {
      segments: ['field_'],
      resolvedPath: [],
      state: 'partial',
      startModel: label,
    };
    const ct = performance.now();
    getCompletionCandidates(parsed, 'field_', index);
    completionTimings.push(performance.now() - ct);
  }
  completionTimings.sort((a, b) => a - b);
  log(
    `getCompletionCandidates (${sampleLabels.length} calls): ` +
    `p50=${formatMs(percentile(completionTimings, 0.5))} ` +
    `p95=${formatMs(percentile(completionTimings, 0.95))} ` +
    `total=${formatMs(completionTimings.reduce((s, v) => s + v, 0))}`,
  );

  // --- 8. Memory ---
  const memAfter = process.memoryUsage();
  const heapDeltaMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
  const rssDeltaMB = (memAfter.rss - memBefore.rss) / 1024 / 1024;
  log(`\nMemory delta: heap=${heapDeltaMB.toFixed(1)}MB rss=${rssDeltaMB.toFixed(1)}MB`);
  log(`Total heap: ${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB`);

  // --- Build metrics ---
  const metrics: BenchmarkMetrics = {
    modelCount,
    buildWorkspaceIndexMs: buildMs,
    diffNoOpMs: noopMs,
    diffOneChangedMs: oneDiffMs,
    incrementalUpdateMs: incrMs,
    trieBuildP50Ms: percentile(trieTimings, 0.5),
    trieBuildP95Ms: percentile(trieTimings, 0.95),
    trieBuildTotalMs: trieTimings.reduce((s, v) => s + v, 0),
    completionP50Ms: percentile(completionTimings, 0.5),
    completionP95Ms: percentile(completionTimings, 0.95),
    completionTotalMs: completionTimings.reduce((s, v) => s + v, 0),
    heapDeltaMB,
    rssDeltaMB,
    totalHeapMB: memAfter.heapUsed / 1024 / 1024,
  };

  // --- Budget checks ---
  const budget = getBudget(modelCount);
  const checks: BudgetCheck[] = [
    { metric: 'buildWorkspaceIndex', actual: buildMs, budget: budget.buildWorkspaceIndex, unit: 'ms', pass: buildMs <= budget.buildWorkspaceIndex },
    { metric: 'diffSurfaceIndex (no-op)', actual: noopMs, budget: budget.diffNoOp, unit: 'ms', pass: noopMs <= budget.diffNoOp },
    { metric: 'incrementalUpdate (1 model)', actual: incrMs, budget: budget.singleModelReindex, unit: 'ms', pass: incrMs <= budget.singleModelReindex },
    { metric: 'completion p50', actual: percentile(completionTimings, 0.5), budget: budget.completionP50, unit: 'ms', pass: percentile(completionTimings, 0.5) <= budget.completionP50 },
    { metric: 'completion p95', actual: percentile(completionTimings, 0.95), budget: budget.completionP95, unit: 'ms', pass: percentile(completionTimings, 0.95) <= budget.completionP95 },
    { metric: 'trie build p95', actual: percentile(trieTimings, 0.95), budget: budget.trieP95, unit: 'ms', pass: percentile(trieTimings, 0.95) <= budget.trieP95 },
    { metric: 'heap delta', actual: heapDeltaMB, budget: budget.heapMB, unit: 'MB', pass: heapDeltaMB <= budget.heapMB },
  ];

  const allPassed = checks.every((c) => c.pass);
  return { metrics, checks, allPassed };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function printBudgetReport(results: BenchmarkResult[]): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log('  PERFORMANCE BUDGET REPORT');
  console.log(`${'='.repeat(72)}`);

  for (const result of results) {
    console.log(`\n--- ${result.metrics.modelCount} models ---`);
    console.log(
      '  ' +
      'Metric'.padEnd(30) +
      'Actual'.padStart(10) +
      'Budget'.padStart(10) +
      '  Result',
    );
    console.log('  ' + '-'.repeat(58));

    for (const check of result.checks) {
      const actualStr = check.unit === 'MB'
        ? `${check.actual.toFixed(1)}${check.unit}`
        : `${formatMs(check.actual)}`;
      const budgetStr = check.unit === 'MB'
        ? `<${check.budget}${check.unit}`
        : `<${formatMs(check.budget)}`;
      const status = check.pass ? 'PASS' : 'FAIL';
      console.log(
        '  ' +
        check.metric.padEnd(30) +
        actualStr.padStart(10) +
        budgetStr.padStart(10) +
        `  ${status}`,
      );
    }
  }

  const totalPassed = results.every((r) => r.allPassed);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  Overall: ${totalPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
  console.log(`${'='.repeat(72)}\n`);
}

function toJsonReport(results: BenchmarkResult[]): object {
  return {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    results: results.map((r) => ({
      ...r.metrics,
      checks: r.checks,
      allPassed: r.allPassed,
    })),
    allPassed: results.every((r) => r.allPassed),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const fullMode = args.includes('--full');
const countArg = args.find((a) => !a.startsWith('--'));

// In JSON mode, suppress library console.log (e.g. [ls:indexer]) by
// capturing stdout and writing JSON to stderr, then swapping at the end.
if (jsonMode) {
  const origLog = console.log;
  // Suppress all console.log during benchmark runs
  console.log = () => {};

  const scales = fullMode ? [3000, 15000, 30000] : [parseInt(countArg || '15000', 10)];
  const results: BenchmarkResult[] = [];
  for (const scale of scales) {
    if (global.gc) global.gc();
    results.push(runBenchmark(scale, true));
  }

  // Restore and output clean JSON
  console.log = origLog;
  console.log(JSON.stringify(toJsonReport(results), null, 2));
  process.exit(results.every((r) => r.allPassed) ? 0 : 1);
} else if (fullMode) {
  const scales = [3000, 15000, 30000];
  const results: BenchmarkResult[] = [];

  for (const scale of scales) {
    if (global.gc) global.gc();
    results.push(runBenchmark(scale));
  }

  printBudgetReport(results);
  process.exit(results.every((r) => r.allPassed) ? 0 : 1);
} else {
  const count = parseInt(countArg || '15000', 10);
  const result = runBenchmark(count);
  console.log('');
  printBudgetReport([result]);
}
