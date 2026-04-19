// Compare a post-phase benchmark JSON to the baseline. Flags regressions
// beyond a noise threshold on the metrics that matter.
//
// Usage:
//   node out/bench/compare.js bench/baseline-ts.json bench/after-p2-ts.json
//
// Exit code 0 on no regression, 1 on regression.

import * as fs from 'fs';

interface ScaleResult {
  modelCount: number;
  buildWorkspaceIndexMs: number;
  diffNoOpMs: number;
  completionP50Ms: number;
  completionP95Ms: number;
  trieBuildP95Ms: number;
  heapDeltaMB: number;
}

interface BenchFile {
  results: ScaleResult[];
}

// Minimum absolute change we care about (below this, variance dominates).
const ABS_FLOORS_MS: Partial<Record<keyof ScaleResult, number>> = {
  buildWorkspaceIndexMs: 5,
  diffNoOpMs: 3,
  completionP50Ms: 0.01,
  completionP95Ms: 0.02,
  trieBuildP95Ms: 0.01,
};

// Relative regression threshold.
const REL_THRESHOLD = 0.15;

function loadBench(p: string): BenchFile {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BenchFile;
}

function compareScale(base: ScaleResult, head: ScaleResult): string[] {
  const regressions: string[] = [];
  const keys: Array<keyof ScaleResult> = [
    'buildWorkspaceIndexMs',
    'diffNoOpMs',
    'completionP50Ms',
    'completionP95Ms',
    'trieBuildP95Ms',
    'heapDeltaMB',
  ];
  for (const k of keys) {
    const b = base[k];
    const h = head[k];
    if (typeof b !== 'number' || typeof h !== 'number') continue;
    const absFloor = ABS_FLOORS_MS[k] ?? 0;
    if (h - b < absFloor) continue;
    const rel = (h - b) / b;
    if (rel > REL_THRESHOLD) {
      regressions.push(
        `  ${k}: ${b.toFixed(3)} → ${h.toFixed(3)} (+${(rel * 100).toFixed(1)}%)`,
      );
    }
  }
  return regressions;
}

function main(): void {
  const [, , basePath, headPath] = process.argv;
  if (!basePath || !headPath) {
    console.error('usage: compare <base.json> <head.json>');
    process.exit(2);
  }
  const base = loadBench(basePath);
  const head = loadBench(headPath);
  let hasRegression = false;
  for (let i = 0; i < base.results.length; i++) {
    const b = base.results[i];
    const h = head.results.find((r) => r.modelCount === b.modelCount);
    if (!h) {
      console.error(`head missing scale ${b.modelCount}`);
      hasRegression = true;
      continue;
    }
    const regs = compareScale(b, h);
    if (regs.length > 0) {
      hasRegression = true;
      console.log(`REGRESSION at modelCount=${b.modelCount}:`);
      for (const r of regs) console.log(r);
    } else {
      console.log(`OK  at modelCount=${b.modelCount}`);
    }
  }
  process.exit(hasRegression ? 1 : 0);
}

main();
