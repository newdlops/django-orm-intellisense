import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-python-compatibility-'));
const executable = path.join(root, 'python');
fs.writeFileSync(executable, 'control executable');
const filename = path.join(__dirname, 'runtimeCompatibility.js');
const realRequire = createRequire(filename);
let calls = 0;
let output = '3.9.6\n';
let failure: Error | undefined;
const ownedModule = { exports: {} as any };
const wrapper = vm.runInThisContext(`(function(exports, require, module) { ${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
wrapper(ownedModule.exports, (id: string) => id === 'node:child_process' ? {
  execFile(command: string, args: string[], options: any, callback: (error: Error | undefined, stdout: string) => void) {
    calls++;
    assert.equal(command, executable);
    assert.deepEqual(args.slice(0, 3), ['-I', '-S', '-B'], 'Version inspection must not run site/application initialization');
    assert.equal(options.cwd, root);
    assert.equal(options.timeout, 1500);
    assert.equal(options.maxBuffer, 4096);
    const error = failure, text = output;
    setImmediate(() => callback(error, text));
  },
} : realRequire(id), ownedModule);

async function run(): Promise<void> {
  const compatibility = new ownedModule.exports.PythonRuntimeCompatibility();
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => compatibility.check(executable, root)));
  assert.ok(results.every(result => result.status === 'rejected' && /Python 3.10.*3.9.6/.test(String(result.reason))));
  assert.equal(calls, 1, 'Repeated unsupported starts share the cached diagnosis and launch no daemon');
  await assert.rejects(compatibility.check(executable, root), /3.9.6/);
  assert.equal(calls, 1);

  fs.writeFileSync(executable, 'replacement compatible executable'); output = '3.11.15\n';
  await compatibility.check(executable, root);
  assert.equal(calls, 2, 'Replacing the interpreter invalidates the unsupported result');
  await compatibility.check(executable, root); assert.equal(calls, 2);

  fs.writeFileSync(path.join(root, '.tool-versions'), 'python 3.12.13\n'); output = '3.12.13\n';
  await compatibility.check(executable, root); assert.equal(calls, 3, 'Workspace version pins invalidate cached shim results');

  const transient = new ownedModule.exports.PythonRuntimeCompatibility();
  failure = new Error('Timed out');
  await assert.rejects(transient.check(executable, root), /Cannot run.*Timed out/);
  failure = undefined;
  await transient.check(executable, root); assert.equal(calls, 5, 'Transient execution errors may recover on the next request');

  const malformed = new ownedModule.exports.PythonRuntimeCompatibility(); output = 'not a version';
  await assert.rejects(malformed.check(executable, root), /unknown version|not a version/);
  output = '3.10.16\n'; await malformed.check(executable, root); assert.equal(calls, 7);
  console.log('runtime-compatibility: unsupported interpreter, shared probe, executable replacement, version pins, transient failure and malformed output recovery passed');
}
run().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
