// ============================================================================
// Django ORM Intellisense — Synthetic Benchmark (5000+ models)
// ============================================================================
//
// Usage: npm run compile && npm run benchmark
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
      instanceMembers[`fk_${r}`] = ['ForeignKey', 'instance'];
      instanceMembers[`fk_${r}_id`] = ['int', null];
      // Add target info in typeStr for extractTargetModel
      instanceMembers[`fk_${r}`] = [`ForeignKey[${targetLabel}]`, 'instance'];
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
// Benchmark runner
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function runBenchmark(modelCount: number): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Benchmark: ${modelCount} models`);
  console.log(`${'='.repeat(60)}\n`);

  const memBefore = process.memoryUsage();

  // --- 1. Generate synthetic data ---
  const t0 = performance.now();
  const surfaceIndex = generateSurfaceIndex(modelCount);
  const modelNames = Object.keys(surfaceIndex).map((l) =>
    l.includes('.') ? l.split('.').pop()! : l,
  );
  console.log(`Generate surfaceIndex: ${formatMs(performance.now() - t0)}`);

  // --- 2. Full build (first load) ---
  const t1 = performance.now();
  const index = buildWorkspaceIndex(surfaceIndex, modelNames);
  const buildMs = performance.now() - t1;
  console.log(`buildWorkspaceIndex: ${formatMs(buildMs)} (${index.models.size} models, tries=lazy)`);

  // --- 3. Diff: no-op (identical surfaceIndex) ---
  const fingerprints = new Map<string, string>();
  // Initialise fingerprints
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t2 = performance.now();
  const noopDiff = diffSurfaceIndex(surfaceIndex, surfaceIndex, fingerprints);
  const noopMs = performance.now() - t2;
  console.log(`diffSurfaceIndex (no-op): ${formatMs(noopMs)} (${noopDiff.added.length}+${noopDiff.changed.length}~${noopDiff.removed.length}-)`);

  // --- 4. Diff: 1 model changed ---
  const modifiedIndex = { ...surfaceIndex };
  const firstLabel = Object.keys(surfaceIndex)[0];
  modifiedIndex[firstLabel] = {
    instance: {
      ...surfaceIndex[firstLabel].instance,
      new_field: ['str', null],
    },
  };
  // Re-initialise fingerprints for the original
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t3 = performance.now();
  const oneDiff = diffSurfaceIndex(surfaceIndex, modifiedIndex, fingerprints);
  const oneDiffMs = performance.now() - t3;
  console.log(`diffSurfaceIndex (1 changed): ${formatMs(oneDiffMs)} (${oneDiff.added.length}+${oneDiff.changed.length}~${oneDiff.removed.length}-)`);

  // --- 5. Incremental update (1 model changed) ---
  const t4 = performance.now();
  updateWorkspaceIndexIncremental(index, modifiedIndex, oneDiff);
  const incrMs = performance.now() - t4;
  console.log(`updateWorkspaceIndexIncremental (1 changed): ${formatMs(incrMs)}`);

  // --- 6. Lazy trie build ---
  const trieTimings: number[] = [];
  const sampleLabels = Object.keys(surfaceIndex).slice(0, 100);
  for (const label of sampleLabels) {
    const tt = performance.now();
    getOrBuildFieldTrie(index, label);
    trieTimings.push(performance.now() - tt);
  }
  trieTimings.sort((a, b) => a - b);
  console.log(
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
  console.log(
    `getCompletionCandidates (${sampleLabels.length} calls): ` +
    `p50=${formatMs(percentile(completionTimings, 0.5))} ` +
    `p95=${formatMs(percentile(completionTimings, 0.95))} ` +
    `total=${formatMs(completionTimings.reduce((s, v) => s + v, 0))}`,
  );

  // --- 8. Memory ---
  const memAfter = process.memoryUsage();
  const heapUsedMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
  const rssMB = (memAfter.rss - memBefore.rss) / 1024 / 1024;
  console.log(`\nMemory delta: heap=${heapUsedMB.toFixed(1)}MB rss=${rssMB.toFixed(1)}MB`);
  console.log(`Total heap: ${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const count = parseInt(process.argv[2] || '5000', 10);
runBenchmark(count);
