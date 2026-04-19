// Smoke test for the native loader. Not wired into vscode-test; invoked
// manually via: node out/client/native/loader.test.js
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

function main(): void {
  const n = loadNative();
  const greeting = n.hello('django');
  assert(greeting === 'hello, django', `unexpected greeting: ${greeting}`);
  const version = n.nativeVersion();
  assert(/^\d+\.\d+\.\d+/.test(version), `unexpected version: ${version}`);
  console.log(`native loader OK (version=${version})`);
}

main();
