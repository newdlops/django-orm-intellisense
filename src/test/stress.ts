// ============================================================================
// Django ORM Intellisense — Stress Test (100K models)
// ============================================================================
//
// Generates a realistic large-scale Django project with:
//   - 100,000 models across 1,000 apps
//   - Random multi-level inheritance chains (up to depth 4)
//   - Forward FK, M2M, and reverse relation sets
//   - Mixed field counts per model (5~40 fields)
//   - Cross-app relations
//
// Usage:
//   npm run compile && node out/test/stress.js [count] [--json]
// ============================================================================

import {
  buildWorkspaceIndex,
  diffSurfaceIndex,
  updateWorkspaceIndexIncremental,
  getOrBuildFieldTrie,
  type SurfaceIndex,
} from '../server/workspaceIndexer.js';
import { getCompletionCandidates, parseLookupChain } from '../server/lookupResolver.js';
import type { ParsedLookup } from '../server/types.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (deterministic results)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_TYPES: Array<[string, string | null]> = [
  ['str', null], ['int', null], ['bool', null], ['datetime', null],
  ['float', null], ['Decimal', null], ['UUID', null], ['date', null],
  ['text', null], ['json', null], ['binary', null], ['email', null],
];

const RECEIVER_KINDS = ['instance', 'model_class', 'manager', 'queryset', 'related_manager'] as const;

// ---------------------------------------------------------------------------
// Realistic surface index generator
// ---------------------------------------------------------------------------

function generateStressSurfaceIndex(modelCount: number, seed = 42): SurfaceIndex {
  const rand = mulberry32(seed);
  const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  const index: SurfaceIndex = {};
  const labels: string[] = [];
  const appCount = Math.max(10, Math.floor(modelCount / 100));

  // Pre-generate all labels
  for (let i = 0; i < modelCount; i++) {
    labels.push(`app${i % appCount}.Model${i}`);
  }

  // Inheritance chains: ~20% of models inherit from another
  const baseOf = new Map<number, number>(); // child → parent
  for (let i = 0; i < modelCount; i++) {
    if (rand() < 0.2 && i > 0) {
      // Pick a parent from earlier models (max depth ~4)
      let parentIdx = randInt(0, i - 1);
      let depth = 0;
      let cur = parentIdx;
      while (baseOf.has(cur) && depth < 3) {
        cur = baseOf.get(cur)!;
        depth++;
      }
      if (depth < 4) {
        baseOf.set(i, parentIdx);
      }
    }
  }

  for (let i = 0; i < modelCount; i++) {
    const instanceMembers: Record<string, [string, string | null]> = {};
    const modelClassMembers: Record<string, [string, string | null]> = {};
    const managerMembers: Record<string, [string, string | null]> = {};
    const querysetMembers: Record<string, [string, string | null]> = {};

    // Scalar fields: random count 5~40
    const fieldCount = randInt(5, 40);
    for (let f = 0; f < fieldCount; f++) {
      const ft = pick(FIELD_TYPES);
      instanceMembers[`field_${f}`] = ft;
    }

    // Forward FK relations: 1~5
    const fkCount = randInt(1, 5);
    for (let r = 0; r < fkCount; r++) {
      const targetIdx = randInt(0, modelCount - 1);
      instanceMembers[`fk_${r}`] = [`ForeignKey[${labels[targetIdx]}]`, 'instance'];
      instanceMembers[`fk_${r}_id`] = ['int', null];
    }

    // M2M relations: 0~2
    const m2mCount = randInt(0, 2);
    for (let m = 0; m < m2mCount; m++) {
      const targetIdx = randInt(0, modelCount - 1);
      instanceMembers[`m2m_${m}`] = [`ManyToManyRelatedManager[${labels[targetIdx]}]`, 'related_manager'];
    }

    // Reverse FK relations: 0~8 (simulating reverse_*_set)
    const reverseCount = randInt(0, 8);
    for (let rv = 0; rv < reverseCount; rv++) {
      const sourceIdx = randInt(0, modelCount - 1);
      instanceMembers[`reverse_${rv}_set`] = [`RelatedManager[${labels[sourceIdx]}]`, 'related_manager'];
    }

    // Inherited fields from parent
    if (baseOf.has(i)) {
      const parentIdx = baseOf.get(i)!;
      instanceMembers['parent_ptr'] = [`OneToOneField[${labels[parentIdx]}]`, 'instance'];
      instanceMembers['parent_ptr_id'] = ['int', null];
    }

    // Model class members (objects manager)
    modelClassMembers['objects'] = ['manager', labels[i]];
    if (rand() < 0.3) {
      modelClassMembers['all_objects'] = ['manager', labels[i]];
    }

    // Manager members
    managerMembers['get_queryset'] = ['queryset', labels[i]];
    managerMembers['all'] = ['queryset', labels[i]];
    managerMembers['filter'] = ['queryset', labels[i]];
    managerMembers['exclude'] = ['queryset', labels[i]];
    managerMembers['create'] = ['instance', labels[i]];

    // Queryset members (captain-style: many custom methods)
    querysetMembers['filter'] = ['queryset', labels[i]];
    querysetMembers['exclude'] = ['queryset', labels[i]];
    querysetMembers['order_by'] = ['queryset', labels[i]];
    querysetMembers['values'] = ['queryset', labels[i]];
    querysetMembers['values_list'] = ['queryset', labels[i]];
    querysetMembers['annotate'] = ['queryset', labels[i]];
    querysetMembers['aggregate'] = ['queryset', labels[i]];
    querysetMembers['first'] = ['instance', labels[i]];
    querysetMembers['get'] = ['instance', labels[i]];
    querysetMembers['select_related'] = ['queryset', labels[i]];
    querysetMembers['prefetch_related'] = ['queryset', labels[i]];
    // Captain-style custom queryset methods
    if (rand() < 0.6) querysetMembers['exclude_deleted'] = ['queryset', labels[i]];
    if (rand() < 0.4) querysetMembers['valid'] = ['queryset', labels[i]];
    if (rand() < 0.3) querysetMembers['search'] = ['queryset', labels[i]];
    if (rand() < 0.3) querysetMembers['annotate_status_at'] = ['queryset', labels[i]];
    if (rand() < 0.2) querysetMembers['annotate_name'] = ['queryset', labels[i]];
    if (rand() < 0.2) querysetMembers['active'] = ['queryset', labels[i]];
    if (rand() < 0.15) querysetMembers['exclude_confidential'] = ['queryset', labels[i]];
    if (rand() < 0.1) querysetMembers['annotate_is_assigned'] = ['queryset', labels[i]];

    index[labels[i]] = {
      instance: instanceMembers,
      model_class: modelClassMembers,
      manager: managerMembers,
      queryset: querysetMembers,
    };
  }

  return index;
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
// Stress test runner
// ---------------------------------------------------------------------------

function runStressTest(modelCount: number): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  STRESS TEST: ${modelCount.toLocaleString()} models`);
  console.log(`${'='.repeat(70)}\n`);

  const memBefore = process.memoryUsage();

  // --- 1. Generate ---
  const t0 = performance.now();
  const surfaceIndex = generateStressSurfaceIndex(modelCount);
  const genMs = performance.now() - t0;
  const modelNames = Object.keys(surfaceIndex).map(l => l.split('.').pop()!);
  console.log(`Generate: ${formatMs(genMs)} (${Object.keys(surfaceIndex).length} models)`);

  // --- 2. Build workspace index ---
  const t1 = performance.now();
  const index = buildWorkspaceIndex(surfaceIndex, modelNames);
  const buildMs = performance.now() - t1;
  console.log(`buildWorkspaceIndex: ${formatMs(buildMs)}`);

  // --- 3. Diff no-op ---
  const fingerprints = new Map<string, string>();
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t2 = performance.now();
  diffSurfaceIndex(surfaceIndex, surfaceIndex, fingerprints);
  const diffMs = performance.now() - t2;
  console.log(`diffSurfaceIndex (no-op): ${formatMs(diffMs)}`);

  // --- 4. Incremental update (10 models changed) ---
  const modified = { ...surfaceIndex };
  const changedLabels = Object.keys(surfaceIndex).slice(0, 10);
  for (const label of changedLabels) {
    modified[label] = {
      ...surfaceIndex[label],
      instance: { ...surfaceIndex[label].instance, stress_new_field: ['str', null] },
    };
  }
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t3 = performance.now();
  const diff10 = diffSurfaceIndex(surfaceIndex, modified, fingerprints);
  updateWorkspaceIndexIncremental(index, modified, diff10);
  const incrMs = performance.now() - t3;
  console.log(`incrementalUpdate (10 changed): ${formatMs(incrMs)}`);

  // --- 5. Lazy trie build (sample 200) ---
  const allLabels = Object.keys(surfaceIndex);
  const trieSample = 200;
  const trieTimings: number[] = [];
  for (let i = 0; i < trieSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
    const tt = performance.now();
    getOrBuildFieldTrie(index, label);
    trieTimings.push(performance.now() - tt);
  }
  trieTimings.sort((a, b) => a - b);
  console.log(
    `getOrBuildFieldTrie (${trieSample} random): ` +
    `p50=${formatMs(percentile(trieTimings, 0.5))} ` +
    `p95=${formatMs(percentile(trieTimings, 0.95))} ` +
    `max=${formatMs(trieTimings[trieTimings.length - 1])}`
  );

  // --- 6. Completion: field prefix ---
  const completionSample = 200;
  const completionTimings: number[] = [];
  for (let i = 0; i < completionSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
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
    `completion (field prefix, ${completionSample}): ` +
    `p50=${formatMs(percentile(completionTimings, 0.5))} ` +
    `p95=${formatMs(percentile(completionTimings, 0.95))} ` +
    `max=${formatMs(completionTimings[completionTimings.length - 1])}`
  );

  // --- 7. Lookup chain resolution (FK traversal) ---
  const chainSample = 200;
  const chainTimings: number[] = [];
  let chainResolved = 0;
  for (let i = 0; i < chainSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
    const ct = performance.now();
    const result = parseLookupChain('fk_0__field_0', label, index);
    chainTimings.push(performance.now() - ct);
    if (result.state !== 'error') chainResolved++;
  }
  chainTimings.sort((a, b) => a - b);
  console.log(
    `parseLookupChain (fk_0__field_0, ${chainSample}): ` +
    `p50=${formatMs(percentile(chainTimings, 0.5))} ` +
    `p95=${formatMs(percentile(chainTimings, 0.95))} ` +
    `resolved=${chainResolved}/${chainSample}`
  );

  // --- 8. Deep chain resolution (3-hop FK) ---
  const deepChainTimings: number[] = [];
  let deepResolved = 0;
  for (let i = 0; i < chainSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
    const ct = performance.now();
    const result = parseLookupChain('fk_0__fk_0__fk_0__field_0', label, index);
    deepChainTimings.push(performance.now() - ct);
    if (result.state !== 'error') deepResolved++;
  }
  deepChainTimings.sort((a, b) => a - b);
  console.log(
    `parseLookupChain (3-hop FK, ${chainSample}): ` +
    `p50=${formatMs(percentile(deepChainTimings, 0.5))} ` +
    `p95=${formatMs(percentile(deepChainTimings, 0.95))} ` +
    `resolved=${deepResolved}/${chainSample}`
  );

  // --- 9. Captain-style queryset chain (filter → exclude_deleted → values) ---
  const chainQsSample = 200;
  const chainQsTimings: number[] = [];
  for (let i = 0; i < chainQsSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
    // Simulate: Model.objects.filter(field_0=...) → completion on next segment
    const parsed: ParsedLookup = {
      segments: ['field_0__icontains'],
      resolvedPath: [],
      state: 'partial',
      startModel: label,
    };
    const ct = performance.now();
    getCompletionCandidates(parsed, 'icontains', index);
    chainQsTimings.push(performance.now() - ct);
  }
  chainQsTimings.sort((a, b) => a - b);
  console.log(
    `completion (field__lookup, ${chainQsSample}): ` +
    `p50=${formatMs(percentile(chainQsTimings, 0.5))} ` +
    `p95=${formatMs(percentile(chainQsTimings, 0.95))}`
  );

  // --- 10. Reverse relation completion ---
  const reverseSample = 200;
  const reverseTimings: number[] = [];
  for (let i = 0; i < reverseSample; i++) {
    const label = allLabels[Math.floor(Math.random() * allLabels.length)];
    const parsed: ParsedLookup = {
      segments: ['reverse_'],
      resolvedPath: [],
      state: 'partial',
      startModel: label,
    };
    const ct = performance.now();
    getCompletionCandidates(parsed, 'reverse_', index);
    reverseTimings.push(performance.now() - ct);
  }
  reverseTimings.sort((a, b) => a - b);
  console.log(
    `completion (reverse_, ${reverseSample}): ` +
    `p50=${formatMs(percentile(reverseTimings, 0.5))} ` +
    `p95=${formatMs(percentile(reverseTimings, 0.95))}`
  );

  // --- 10. Memory ---
  const memAfter = process.memoryUsage();
  const heapMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
  const rssMB = (memAfter.rss - memBefore.rss) / 1024 / 1024;
  console.log(`\nMemory: heap=${heapMB.toFixed(0)}MB rss=${rssMB.toFixed(0)}MB total_heap=${(memAfter.heapUsed / 1024 / 1024).toFixed(0)}MB`);

  // --- Summary ---
  console.log(`\n${'─'.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Models:          ${modelCount.toLocaleString()}`);
  console.log(`  Build:           ${formatMs(buildMs)}`);
  console.log(`  Diff (no-op):    ${formatMs(diffMs)}`);
  console.log(`  Incr (10 mod):   ${formatMs(incrMs)}`);
  console.log(`  Trie p95:        ${formatMs(percentile(trieTimings, 0.95))}`);
  console.log(`  Completion p95:  ${formatMs(percentile(completionTimings, 0.95))}`);
  console.log(`  FK chain p95:    ${formatMs(percentile(chainTimings, 0.95))}`);
  console.log(`  Deep chain p95:  ${formatMs(percentile(deepChainTimings, 0.95))}`);
  console.log(`  Reverse p95:     ${formatMs(percentile(reverseTimings, 0.95))}`);
  console.log(`  Heap delta:      ${heapMB.toFixed(0)}MB`);
  console.log(`${'─'.repeat(70)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const count = parseInt(args.find(a => !a.startsWith('--')) || '100000', 10);
runStressTest(count);
