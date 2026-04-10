// ============================================================================
// Django ORM Intellisense — Performance Tracker
// ============================================================================

const RING_SIZE = 1000;

interface TimingSeries {
  values: Float64Array;
  head: number;
  count: number;
}

interface PerfStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

const timings = new Map<string, TimingSeries>();
const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function getOrCreateSeries(metric: string): TimingSeries {
  let series = timings.get(metric);
  if (!series) {
    series = { values: new Float64Array(RING_SIZE), head: 0, count: 0 };
    timings.set(metric, series);
  }
  return series;
}

export function recordTiming(metric: string, durationMs: number): void {
  const s = getOrCreateSeries(metric);
  s.values[s.head] = durationMs;
  s.head = (s.head + 1) % RING_SIZE;
  if (s.count < RING_SIZE) {
    s.count++;
  }
}

export function incrementCounter(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function getCounter(name: string): number {
  return counters.get(name) ?? 0;
}

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function getAllGauges(): Record<string, number> {
  return Object.fromEntries(gauges);
}

export function getStats(metric: string): PerfStats | undefined {
  const s = timings.get(metric);
  if (!s || s.count === 0) {
    return undefined;
  }

  const n = s.count;
  const sorted = new Float64Array(n);
  const start = n < RING_SIZE ? 0 : s.head;
  for (let i = 0; i < n; i++) {
    sorted[i] = s.values[(start + i) % RING_SIZE];
  }
  sorted.sort();

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i];
  }

  return {
    count: n,
    mean: sum / n,
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

export function getAllStats(): Record<string, PerfStats> {
  const result: Record<string, PerfStats> = {};
  for (const metric of timings.keys()) {
    const s = getStats(metric);
    if (s) {
      result[metric] = s;
    }
  }
  return result;
}

export function getAllCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function reset(): void {
  timings.clear();
  counters.clear();
  gauges.clear();
}
