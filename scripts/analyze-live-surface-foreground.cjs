'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const methodName = method => typeof method === 'string' ? method : method?.method ?? String(method);
function describe(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, medianMs: n ? n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null,
    p95Ms: n ? sorted[Math.ceil(n * .95) - 1] : null, maxMs: sorted.at(-1) ?? null,
    above20Ms: values.filter(value => value >= 20).length, above50Ms: values.filter(value => value >= 50).length };
}
function profileSummary(file) {
  const encoded = fs.readFileSync(path.resolve(root, file));
  const profile = JSON.parse(encoded);
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  function ancestors(id) {
    const frames = [];
    while (parent.has(id) && frames.length < 10) {
      id = parent.get(id); frames.push(nodes.get(id).callFrame);
    }
    return frames;
  }
  const chainCache = new Map();
  function chain(id) {
    if (!chainCache.has(id)) {
      const frames = [nodes.get(id).callFrame];
      let current = id;
      while (parent.has(current)) { current = parent.get(current); frames.push(nodes.get(current).callFrame); }
      chainCache.set(id, frames);
    }
    return chainCache.get(id);
  }
  const extensionOf = frame => /[\\/]\.vscode[\\/]extensions[\\/]([^\\/]+)/.exec(frame.url)?.[1];
  const self = new Map(), groups = new Map(), extensionAncestry = new Map(), synchronousProcesses = new Map();
  function accumulate(map, key, deltaMs) {
    const row = map.get(key) ?? { samples: 0, weightedSampleMs: 0, cappedSampleMs: 0 };
    row.samples++; row.weightedSampleMs += deltaMs; row.cappedSampleMs += Math.min(deltaMs, 10); map.set(key, row);
  }
  const deltas = profile.timeDeltas ?? [];
  assert.equal(profile.samples.length, deltas.length);
  function group(frame) {
    if (frame.functionName.startsWith('(')) return frame.functionName;
    if (frame.url.includes(root + '/out/')) return 'django-orm-intellisense';
    const extension = /[\\/]\.vscode[\\/]extensions[\\/]([^\\/]+)/.exec(frame.url);
    if (extension) return extension[1];
    if (frame.url.startsWith('node:')) return 'node';
    return frame.url.includes('extensionHost') || frame.url.includes('bootstrap-fork') ? 'vscode-extension-host' : frame.url || '(no url)';
  }
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], deltaMs = deltas[i] / 1000;
    const node = nodes.get(id); assert.ok(node);
    const own = self.get(id) ?? { node: id, frame: node.callFrame, samples: 0, weightedSampleMs: 0, cappedSampleMs: 0 };
    own.samples++; own.weightedSampleMs += deltaMs; own.cappedSampleMs += Math.min(deltaMs, 10); self.set(id, own);
    const key = group(node.callFrame);
    const aggregate = groups.get(key) ?? { samples: 0, weightedSampleMs: 0, cappedSampleMs: 0 };
    aggregate.samples++; aggregate.weightedSampleMs += deltaMs; aggregate.cappedSampleMs += Math.min(deltaMs, 10); groups.set(key, aggregate);
    const frames = chain(id);
    const extensions = [...new Set(frames.map(extensionOf).filter(Boolean))];
    for (const extension of extensions) accumulate(extensionAncestry, extension, deltaMs);
    if (frames.some(frame => ['spawnSync', 'execFileSync', 'execSync'].includes(frame.functionName))) {
      accumulate(synchronousProcesses, extensions[0] ?? '(no extension URL in stack)', deltaMs);
    }
  }
  return { artifact: file, sha256: hash(encoded), sampleCount: profile.samples.length,
    durationMs: (profile.endTime - profile.startTime) / 1000,
    samplingGapSummary: describe(deltas.map(value => value / 1000)),
    samplesWithGapAbove20Ms: deltas.filter(value => value > 20000).length,
    groups: [...groups].map(([name, summary]) => ({ name, ...summary })).sort((a, b) => b.weightedSampleMs - a.weightedSampleMs),
    sampledExtensionAncestry: [...extensionAncestry].map(([name, summary]) => ({ name, ...summary }))
      .sort((a, b) => b.samples - a.samples),
    sampledSynchronousChildProcessAncestry: [...synchronousProcesses].map(([name, summary]) => ({ name, ...summary }))
      .sort((a, b) => b.samples - a.samples),
    topSelf: [...self.values()].sort((a, b) => b.weightedSampleMs - a.weightedSampleMs).slice(0, 25)
      .map(row => ({ ...row, ancestors: ancestors(row.node) })),
    scope: 'V8 statistical samples in the extension-host process only. Time-delta weights include idle and scheduling gaps; weighted or capped sample times are not measured per-function CPU durations. Long gaps and raw sample counts are retained; group/self locations and full sampled ancestry can guide attribution, not establish causality alone. Extension ancestry counts may overlap across extensions. Synchronous child-process attribution uses the nearest extension URL on the sampled stack.' };
}
function main() {
  const logPath = process.argv[2]; assert.ok(logPath, 'Pass the native test log path');
  const logBytes = fs.readFileSync(path.resolve(root, logPath));
  const marker = '[live-surface-foreground] ';
  const lines = logBytes.toString().split('\n').filter(line => line.includes(marker));
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0].split(marker)[1]);
  const encoded = fs.readFileSync(path.resolve(root, receipt.artifact));
  const data = JSON.parse(encoded);
  const summaries = data.windows.map(window => ({
    phase: window.phase, fullReadyAtMs: window.fullReadyAtMs, startedMs: window.startedMs, finishedMs: window.finishedMs,
    durationMs: window.finishedMs === undefined ? undefined : window.finishedMs - window.startedMs,
    saveToFullLspAcknowledgementMs: window.savedAtMs === undefined ? undefined : window.fullLspAcknowledgedAtMs - window.savedAtMs,
    probes: Object.fromEntries([...new Set((window.probes ?? []).map(row => row.method))].map(method => [method,
      describe(window.probes.filter(row => row.method === method).map(row => row.elapsedMs))])),
    ownCompletionProvider: describe((window.probes ?? []).flatMap(row => row.provider ?? [])
      .filter(row => typeof row.startedAt === 'number' && typeof row.finishedAt === 'number')
      .map(row => row.finishedAt - row.startedAt)),
    timerExcess: describe((window.ticks ?? []).map(row => row.excessMs)),
    slowest: [...(window.probes ?? [])].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5),
  }));
  const methods = Object.fromEntries([...new Set(data.requests.map(row => `${row.transport}:${methodName(row.method)}`))].map(key => [key,
    describe(data.requests.filter(row => `${row.transport}:${methodName(row.method)}` === key).map(row => row.elapsedMs))]));
  const nativeMethods = Object.fromEntries([...new Set(data.phases.map(row => row.method))].map(method => [method,
    describe(data.phases.filter(row => row.method === method).map(row => row.elapsedMs))]));
  console.log(JSON.stringify({ observedUtc: new Date().toISOString(), analyzerSha256: hash(fs.readFileSync(__filename)), nativeLog: logPath, nativeLogSha256: hash(logBytes),
    artifact: receipt.artifact, artifactSha256: hash(encoded), failure: data.failure, environment: data.environment, models: data.models,
    pythonFiles: data.pythonFiles, scope: data.scope, windows: summaries, methods, nativeMethods,
    longestSynchronousPhases: data.phases.filter(row => !row.method.endsWith('.settled') && !row.method.endsWith('.rejected'))
      .sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 25),
    longTicks: data.windows.flatMap(window => (window.ticks ?? []).filter(row => row.excessMs >= 50)
      .map(tick => ({ phase: window.phase, ...tick,
        overlappingSynchronousPhases: data.phases.filter(row => !row.method.endsWith('.settled') && !row.method.endsWith('.rejected')
          && row.startedMs < tick.atMs && row.startedMs + row.elapsedMs >= tick.atMs - tick.excessMs - 10),
      }))),
    profiles: (data.cpuProfiles ?? []).map(row => ({ phase: row.phase, ...profileSummary(row.artifact) })),
    snapshots: data.snapshots.map(file => ({ artifact: file, sha256: hash(fs.readFileSync(path.resolve(root, file))) })),
  }));
}
main();
