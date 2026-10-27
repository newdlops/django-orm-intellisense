'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reuse the sealed ordinary IPC reader and complete payload oracle. The sole
// oracle extension selects the expected custom-transform kind after a save.
const inherited = fs.readFileSync(path.join(__dirname, 'probe-cached-initialize-surface.cjs'), 'utf8');
const boundary = inherited.indexOf('\nconst probes =');
assert.ok(boundary > 0);
const old = "assert.equal(catalog.types[field.transforms.field_size].fieldKind, 'CharField');";
let definitions = inherited.slice(0, boundary);
assert.equal(definitions.split(old).length, 2);
definitions = definitions.replace(old, "assert.equal(catalog.types[field.transforms.field_size].fieldKind, fixture.customKind || 'CharField');");
const { Client, assertSurface, assertInitial } = new Function('require', definitions
  + '\nreturn { Client, assertSurface, assertInitial };')(require);
const pairs = [['instance', 'attached_instance'], ['instance', 'attached_class'],
  ['model_class', 'attached_class'], ['model_class', 'attached_instance'],
  ['manager', 'attached_query'], ['queryset', 'attached_query'], ['related_manager', 'attached_query']];
const archive = (folder, name, value) => {
  const target = path.join(folder, name + '.json.gz');
  fs.writeFileSync(target, zlib.gzipSync(Buffer.from(JSON.stringify(value))));
  return target;
};
function currentFull(client, after, kind) {
  return client.notifications.find(note => {
    if (note.event !== 'surfaceIndexChanged' || note.decodedMs < after) return false;
    const value = note.params, target = value.surfaceIndex?.['app0.Model0'], catalog = value.lookupCatalog;
    if (!target || !catalog || !pairs.every(([receiver, name]) => target[receiver]?.[name]?.[1] === 'app0.Model0')
        || !target.model_class.special) return false;
    const field = catalog.types[catalog.fields['app0.Model0'].field_0];
    return catalog.types[field.transforms.field_size].fieldKind === kind;
  });
}
async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.argv[2])), folder = path.resolve(process.argv[3]);
  const client = new Client(fixture, folder, 'save');
  const result = { fixture, sourceEdits: [], snapshots: [], nodeVersion: process.version };
  let failure;
  try {
    const initialized = await client.request('initialize', { workspaceRoot: fixture.root,
      settingsModule: 'bench_settings', deferRuntime: true, surfaceSnapshotTransport: fixture.transportVersion });
    assertInitial(initialized.result, fixture);
    const initialFull = await client.until(() => client.full(fixture.models));
    assertSurface(initialFull.params, fixture);
    result.snapshots.push(archive(folder, 'initial', initialized.result), archive(folder, 'startup-full', initialFull.params));
    const source = path.join(fixture.root, 'app0/model_0.py');
    for (const [phase, from, to, kind] of [['date', '255', '10 ', 'DateField'], ['char', '10 ', '255', 'CharField']]) {
      const stamp = fs.statSync(source, { bigint: true }), before = fs.readFileSync(source, 'utf8');
      const after = before.replace(`field_0 = models.CharField(max_length=${from})`, `field_0 = models.CharField(max_length=${to})`);
      assert.notEqual(after, before);
      assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
      fs.writeFileSync(source, after);
      execFileSync(fixture.python, ['-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]),int(sys.argv[3])))',
        source, stamp.atimeNs.toString(), stamp.mtimeNs.toString()]);
      const changed = fs.statSync(source, { bigint: true });
      assert.equal(changed.mtimeNs, stamp.mtimeNs);
      const row = { phase, before, after, previousMtimeNs: stamp.mtimeNs.toString(),
        currentMtimeNs: changed.mtimeNs.toString(), requestedMs: performance.now() - client.started,
        stderrOffset: client.stderr.length, requests: [], members: [] };
      row.requests.push(await client.request('reindexFile', { filePath: source }));
      assert.notEqual(row.requests[0].result.unchanged, true);
      for (const delay of [0, 300, 300]) {
        if (delay) await sleep(delay);
        row.requests.push(await client.request('reindexFile', { filePath: source }));
      }
      const full = await client.until(() => currentFull(client, row.requestedMs, kind));
      row.fullDecodedMs = full.decodedMs;
      row.fullReadyFromRequestMs = full.decodedMs - row.requestedMs;
      assertSurface(full.params, { ...fixture, customKind: kind });
      for (const [receiverKind, name] of pairs) {
        const reply = await client.request('resolveOrmMember', { modelLabel: 'app0.Model0', receiverKind, name });
        assert.equal(reply.result.resolved, true);
        assert.equal(reply.result.item.returnModelLabel, 'app0.Model0');
        row.members.push({ receiverKind, name, ...reply });
      }
      row.lookup = await client.request('resolveLookupPath', { baseModelLabel: 'app0.Model0',
        value: 'field_0__field_size', method: 'filter' });
      assert.equal(row.lookup.result.terminalType.outputFieldKind, kind);
      row.snapshot = archive(folder, phase + '-full', full.params);
      result.snapshots.push(row.snapshot);
      row.refreshLog = client.stderr.slice(row.stderrOffset);
      result.sourceEdits.push(row);
    }
  } catch (error) {
    failure = error;
    result.failure = error.stack || String(error);
  } finally {
    result.daemonExit = await client.close();
    result.daemonLog = client.logPath;
    result.decodes = client.decodes;
    fs.writeFileSync(path.join(folder, 'probe-result.json'), JSON.stringify(result, null, 2));
    assert.equal(result.daemonExit.code, 0, JSON.stringify(result.daemonExit));
  }
  if (failure) throw failure;
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
