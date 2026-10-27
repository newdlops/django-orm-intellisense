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
  type SurfaceMemberTuple,
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

const FIELD_TYPES = [
  'CharField', 'IntegerField', 'BooleanField', 'DateTimeField',
  'FloatField', 'DecimalField', 'UUIDField', 'DateField',
  'TextField', 'JSONField', 'BinaryField', 'EmailField',
];

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
    const instanceMembers: Record<string, SurfaceMemberTuple> = {};
    const modelClassMembers: Record<string, [string, string | null]> = {};
    const managerMembers: Record<string, [string, string | null]> = {};
    const querysetMembers: Record<string, [string, string | null]> = {};

    // Scalar fields: random count 5~40
    const fieldCount = randInt(5, 40);
    for (let f = 0; f < fieldCount; f++) {
      const ft = pick(FIELD_TYPES);
      instanceMembers[`field_${f}`] = ['scalar', null, 'field', ft];
    }

    // Forward FK relations: 1~5
    const fkCount = randInt(1, 5);
    for (let r = 0; r < fkCount; r++) {
      const targetIdx = randInt(0, modelCount - 1);
      instanceMembers[`fk_${r}`] = ['instance', labels[targetIdx], 'relation', 'ForeignKey'];
      instanceMembers[`fk_${r}_id`] = ['scalar', null, 'field', 'IntegerField'];
    }

    // M2M relations: 0~2
    const m2mCount = randInt(0, 2);
    for (let m = 0; m < m2mCount; m++) {
      const targetIdx = randInt(0, modelCount - 1);
      instanceMembers[`m2m_${m}`] = ['related_manager', labels[targetIdx], 'relation', 'ManyToManyField'];
    }

    // Reverse FK relations: 0~8 (simulating reverse_*_set)
    const reverseCount = randInt(0, 8);
    for (let rv = 0; rv < reverseCount; rv++) {
      const sourceIdx = randInt(0, modelCount - 1);
      instanceMembers[`reverse_${rv}_set`] = ['related_manager', labels[sourceIdx], 'reverse_relation', 'reverse_ForeignKey'];
    }

    // Inherited fields from parent
    if (baseOf.has(i)) {
      const parentIdx = baseOf.get(i)!;
      instanceMembers['parent_ptr'] = ['instance', labels[parentIdx], 'relation', 'OneToOneField'];
      instanceMembers['parent_ptr_id'] = ['scalar', null, 'field', 'IntegerField'];
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

function runStressTest(modelCount: number) {
  const sampleRandom = mulberry32(20261008);
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
  const fieldKinds = new Set<string>();
  let forwardRelations = 0;
  let reverseRelations = 0;
  for (const model of index.models.values()) {
    for (const [name, tuple] of Object.entries(surfaceIndex[model.label].instance ?? {})) {
      const field = model.fields.get(name);
      if (!field || field.fieldKind !== tuple[3]) throw new Error(`Incorrect stress field: ${model.label}.${name}`);
      fieldKinds.add(field.fieldKind);
      if (tuple[2] === 'relation' && !model.relations.has(name)) throw new Error(`Missing forward relation: ${name}`);
      if (tuple[2] === 'reverse_relation' && !model.reverseRelations.has(name)) throw new Error(`Missing reverse relation: ${name}`);
    }
    forwardRelations += model.relations.size;
    reverseRelations += model.reverseRelations.size;
    for (const relation of [...model.relations.values(), ...model.reverseRelations.values()]) {
      if (!index.models.has(relation.targetModelLabel)) throw new Error(`Missing stress target: ${relation.targetModelLabel}`);
    }
  }
  console.log(`buildWorkspaceIndex: ${formatMs(buildMs)}`);

  // --- 3. Diff no-op ---
  const fingerprints = new Map<string, string>();
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const t2 = performance.now();
  const wireFingerprints = Object.fromEntries(fingerprints);
  const noopDiff = diffSurfaceIndex(surfaceIndex, surfaceIndex, fingerprints, wireFingerprints);
  if (noopDiff.added.length || noopDiff.changed.length || noopDiff.removed.length) throw new Error('No-op stress diff changed models');
  const diffMs = performance.now() - t2;
  console.log(`diffSurfaceIndex (no-op): ${formatMs(diffMs)}`);

  // --- 4. Incremental update (10 models changed) ---
  const modified = { ...surfaceIndex };
  const changedLabels = Object.keys(surfaceIndex).slice(0, 10);
  for (const label of changedLabels) {
    modified[label] = {
      ...surfaceIndex[label],
      instance: { ...surfaceIndex[label].instance, stress_new_field: ['scalar', null, 'field', 'CharField'] },
    };
  }
  for (const label of Object.keys(surfaceIndex)) {
    fingerprints.set(label, JSON.stringify(surfaceIndex[label]));
  }
  const modifiedFingerprints = { ...wireFingerprints };
  for (const label of changedLabels) modifiedFingerprints[label] = JSON.stringify(modified[label]);
  const t3 = performance.now();
  const diff10 = diffSurfaceIndex(surfaceIndex, modified, fingerprints, modifiedFingerprints);
  const diff10Ms = performance.now() - t3;
  if (diff10.changed.length !== changedLabels.length) throw new Error('Stress diff missed changed models');
  const tUpdate = performance.now();
  updateWorkspaceIndexIncremental(index, modified, diff10);
  const incrMs = performance.now() - tUpdate;
  for (const label of changedLabels) {
    if (!index.models.get(label)?.fields.has('stress_new_field')) throw new Error(`Stress update missed ${label}`);
  }
  console.log(`diffSurfaceIndex (10 changed): ${formatMs(diff10Ms)}`);
  console.log(`incrementalUpdate (10 changed): ${formatMs(incrMs)}`);

  // --- 5. Lazy trie build (sample 200) ---
  const allLabels = Object.keys(surfaceIndex);
  const trieSample = 200;
  const trieTimings: number[] = [];
  for (let i = 0; i < trieSample; i++) {
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
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
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
    const parsed: ParsedLookup = {
      segments: ['field_'],
      resolvedPath: [],
      state: 'partial',
      startModel: label,
    };
    const ct = performance.now();
    if (getCompletionCandidates(parsed, 'field_', index).length === 0) throw new Error('Missing stress field completions');
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
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
    const ct = performance.now();
    const result = parseLookupChain('fk_0__field_0', label, index);
    chainTimings.push(performance.now() - ct);
    if (result.state !== 'error' && result.resolvedPath.length === 2) chainResolved++;
  }
  chainTimings.sort((a, b) => a - b);
  if (chainResolved !== chainSample) throw new Error(`Stress FK traversal only resolved ${chainResolved}/${chainSample}`);
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
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
    const ct = performance.now();
    const result = parseLookupChain('fk_0__fk_0__fk_0__field_0', label, index);
    deepChainTimings.push(performance.now() - ct);
    if (result.state !== 'error' && result.resolvedPath.length === 4) deepResolved++;
  }
  deepChainTimings.sort((a, b) => a - b);
  if (deepResolved !== chainSample) throw new Error(`Stress deep traversal only resolved ${deepResolved}/${chainSample}`);
  console.log(
    `parseLookupChain (3-hop FK, ${chainSample}): ` +
    `p50=${formatMs(percentile(deepChainTimings, 0.5))} ` +
    `p95=${formatMs(percentile(deepChainTimings, 0.95))} ` +
    `resolved=${deepResolved}/${chainSample}`
  );

  // --- 9. Completion after a fully resolved scalar field ---
  const chainQsSample = 200;
  const chainQsTimings: number[] = [];
  for (let i = 0; i < chainQsSample; i++) {
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
    const ct = performance.now();
    const parsed = parseLookupChain('field_0__', label, index);
    if (parsed.resolvedPath.length !== 1 || getCompletionCandidates(parsed, 'e', index).length === 0) {
      throw new Error('Missing stress scalar lookup completions');
    }
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
    const label = allLabels[Math.floor(sampleRandom() * allLabels.length)];
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
  return {
    timestamp: new Date().toISOString(), node: process.version, modelCount, seed: 42, samplingSeed: 20261008,
    correctness: { changedModels: diff10.changed.length, forwardRelations, reverseRelations,
      fieldKinds: [...fieldKinds].sort(), fkResolved: chainResolved, deepResolved, samples: chainSample },
    metrics: { generateMs: genMs, buildMs, diffNoOpMs: diffMs, diff10Ms, incremental10Ms: incrMs,
      trieP95Ms: percentile(trieTimings, 0.95), completionP95Ms: percentile(completionTimings, 0.95),
      fkP95Ms: percentile(chainTimings, 0.95), deepP95Ms: percentile(deepChainTimings, 0.95),
      scalarLookupP95Ms: percentile(chainQsTimings, 0.95), reverseP95Ms: percentile(reverseTimings, 0.95),
      heapDeltaMB: heapMB, rssDeltaMB: rssMB, totalHeapMB: memAfter.heapUsed / 1024 / 1024 },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const count = parseInt(args.find(a => !a.startsWith('--')) || '100000', 10);
if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Model count must be a positive integer');
const jsonMode = args.includes('--json');
if (jsonMode) console.log = () => {};
const result = runStressTest(count);
if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
