// Actual NAPI AST builds on a fixed source tree. Run each variant in a fresh
// Node process; two warmups, then six measured iterations. All oracles and
// fixture hashing run outside the timed calls. No forced GC or editor claim.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

async function main() {
  const [rootArg, snapshotArg, addonArg, variant, outputArg] = process.argv.slice(2);
  assert(rootArg && snapshotArg && addonArg && variant && outputArg, 'root snapshot addon variant output');
  const root = path.resolve(rootArg), addon = path.resolve(addonArg), output = path.resolve(outputArg);
  assert(!fs.existsSync(output), 'Keep prior benchmark artifacts immutable');
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const files = [];
  const skip = new Set(['node_modules', 'venv', '__pycache__', 'build', 'dist', 'out']);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name)) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push(full);
    }
  }
  walk(root); files.sort();
  assert.equal(files.length, 5000);
  const sourceHash = crypto.createHash('sha256');
  for (const file of files) sourceHash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotArg)));
  const surface = Buffer.from(JSON.stringify(payload.surfaceIndex));
  assert.equal(Object.keys(payload.surfaceIndex).length, 500);
  const n = require(addon);
  assert(n.nativeInitFromSurfaceAsync && n.nativeDropAsync);
  const decode = buffer => { assert(buffer); return JSON.parse(buffer.toString('utf8')); };
  const cheapOracle = () => {
    assert(decode(n.nativeResolveModule('app0.models')).resolved);
    assert.equal(decode(n.nativeResolveExportOrigin('app0.models', 'Model1')).originSymbol, 'Model1');
    assert.equal(decode(n.nativeResolveOrmMember('app0.Model1', 'instance', 'field_14', null)).fieldKind, 'UUIDField');
  };
  const completeOracle = () => {
    const kinds = ['CharField', 'IntegerField', 'BooleanField', 'DateTimeField', 'FloatField', 'DecimalField', 'UUIDField', 'DateField'];
    const hash = crypto.createHash('sha256');
    for (let model = 0; model < 500; model++) {
      const label = `app${Math.floor(model / 50)}.Model${model}`;
      for (let field = 0; field < 15; field++) {
        const result = decode(n.nativeResolveOrmMember(label, 'instance', `field_${field}`, null));
        assert.equal(result.fieldKind, kinds[field % 8]);
        hash.update(JSON.stringify(result));
      }
      for (let relation = 0; relation < 2; relation++) {
        const target = (model + relation + 1) % 500;
        const result = decode(n.nativeResolveOrmMember(label, 'instance', `fk_${relation}`, null));
        assert.equal(result.returnModelLabel, `app${Math.floor(target / 50)}.Model${target}`);
        hash.update(JSON.stringify(result));
      }
    }
    return { scalarTypes: 7500, relationTargets: 1000, sha256: hash.digest('hex') };
  };
  async function measure(operation) {
    const cpu = process.cpuUsage(), before = performance.now();
    const value = await operation();
    const wallMs = performance.now() - before, consumed = process.cpuUsage(cpu);
    return { value, wallMs, cpuMs: (consumed.user + consumed.system) / 1000 };
  }
  const rows = [], oracleHashes = {};
  const initialMemory = process.memoryUsage();
  for (let iteration = 0; iteration < 8; iteration++) {
    await n.nativeDropAsync();
    const init = await measure(() => n.nativeInit(root, true));
    assert.equal(init.value.parsedFileCount, 5000);
    assert.equal(init.value.parseFailureCount, 0);
    cheapOracle();
    if (iteration === 7) oracleHashes.astInit = completeOracle();
    const hydrated = await n.nativeInitFromSurfaceAsync(root, surface);
    assert(hydrated && hydrated.modelCount === 500);
    const ensure = await measure(() => n.nativeEnsureAstModules(root));
    assert.equal(ensure.value, true);
    cheapOracle();
    if (iteration === 7) oracleHashes.surfaceEnsure = completeOracle();
    rows.push({ iteration, warmup: iteration < 2,
      init: { wallMs: init.wallMs, cpuMs: init.cpuMs, stats: init.value },
      ensure: { wallMs: ensure.wallMs, cpuMs: ensure.cpuMs }, memoryAfterEnsure: process.memoryUsage() });
  }
  await n.nativeDropAsync();
  const result = { variant, observedUtc: new Date().toISOString(), nodeVersion: process.version,
    addon, addonSha256: sha(fs.readFileSync(addon)), benchmarkSha256: sha(fs.readFileSync(__filename)),
    root, pythonFiles: files.length, sourceTreeSha256: sourceHash.digest('hex'),
    surfacePayloadSha256: sha(surface), snapshot: snapshotArg, rows, oracleHashes,
    initialMemory, afterDropMemory: process.memoryUsage(), resourceUsage: process.resourceUsage(),
    scope: 'Actual compiled NAPI calls in a fresh Node process. Fixed500-model/5000-file fixture, source hashing and two warmups before six measured forced AST init and surface+AST ensure calls. Source/module/export/current field metadata oracles outside timing. CPU includes process threads. Memory snapshots/maxRSS describe this worker only, not GC-controlled retention or Python/renderer/editor aggregate peaks. Uncontrolled host and warm filesystem; not cold editor startup or an SLO.' };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ artifact: outputArg, variant, sourceTreeSha256: result.sourceTreeSha256,
    addonSha256: result.addonSha256, measuredIterations: 6, oracleHashes }) + '\n');
}

main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
