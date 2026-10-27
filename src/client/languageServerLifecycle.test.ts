import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessageConnection, IPCMessageWriter, type Message, type MessageReader, type MessageWriter } from 'vscode-jsonrpc/node';
import { LanguageServerLifecycle, OwnedIpcServerTransport, type OwnedServerTransport } from './languageServerLifecycle';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 2000;
  while (!check()) { assert.ok(performance.now() < end, 'lifecycle condition deadline'); await delay(2); }
}

function harness(initializeTimeoutMs = 30) {
  const records: { transport: OwnedServerTransport; fault: (error: unknown) => void;
    initialize: ReturnType<typeof deferred<void>>; retired: boolean; invalid: boolean }[] = [];
  const errors: unknown[] = [];
  let running = false, live = 0, maximumLive = 0, rejectRetirement = false;
  let retirementGate: Promise<void> | undefined;
  const lifecycle = new LanguageServerLifecycle({
    open: fault => {
      const initialize = deferred();
      const record = { fault, initialize, retired: false, invalid: false, transport: undefined as unknown as OwnedServerTransport };
      record.transport = {
        reader: {} as MessageReader, writer: {} as MessageWriter,
        invalidate: () => { record.invalid = true; running = false; initialize.reject(new Error('transport retired')); },
        retire: async () => {
          record.transport.invalidate();
          if (retirementGate) await retirementGate;
          if (rejectRetirement) throw new Error('owned process has not exited');
          if (!record.retired) { record.retired = true; live--; }
        },
      };
      records.push(record); live++; maximumLive = Math.max(live, maximumLive);
      return record.transport;
    },
    start: () => {
      lifecycle.open();
      const record = records.at(-1)!;
      return record.initialize.promise.then(() => { if (!record.invalid) running = true; });
    },
    stop: async () => { running = false; }, isRunning: () => running,
    report: error => errors.push(error), initializeTimeoutMs, retryDelayMs: 5, maxRetryDelayMs: 10,
  });
  return { lifecycle, records, errors, live: () => live, maximumLive: () => maximumLive,
    running: () => running, blockRetirement: (gate?: Promise<void>) => { retirementGate = gate; },
    rejectRetirement: (reject: boolean) => { rejectRetirement = reject; } };
}

async function main(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let cases = 0;
  try {
    {
      const h = harness();
      const first = h.lifecycle.start(), same = h.lifecycle.start();
      assert.equal(first, same); await until(() => h.records.length === 1);
      h.records[0].initialize.resolve(); await first;
      await h.lifecycle.start(); assert.equal(h.records.length, 1);
      await h.lifecycle.stop(); assert.equal(h.live(), 0); cases++;
    }
    {
      const h = harness(15), gate = deferred(); h.blockRetirement(gate.promise);
      const first = h.lifecycle.start(); const failed = assert.rejects(first, /transport retired|timed out/);
      await until(() => h.records[0]?.invalid === true);
      await delay(30); assert.equal(h.records.length, 1); assert.equal(h.live(), 1);
      h.blockRetirement(); gate.resolve(); await failed;
      await until(() => h.records.length === 2); h.records[1].initialize.resolve();
      await h.lifecycle.start(); assert.equal(h.maximumLive(), 1);
      await h.lifecycle.stop(); cases++;
    }
    {
      const h = harness(10); await assert.rejects(h.lifecycle.start());
      await until(() => h.records.length >= 3);
      await h.lifecycle.stop(); const count = h.records.length;
      await delay(35); assert.equal(h.records.length, count);
      assert.equal(h.live(), 0); assert.equal(h.maximumLive(), 1); cases++;
    }
    {
      const h = harness(); const start = h.lifecycle.start();
      const failed = assert.rejects(start, /cancelled|transport retired/);
      await until(() => h.records.length === 1);
      h.lifecycle.deactivate(); await failed; await h.lifecycle.stop();
      h.records[0].initialize.resolve(); h.records[0].fault(new Error('late close'));
      await delay(35); assert.equal(h.records.length, 1); assert.equal(h.live(), 0);
      await assert.rejects(h.lifecycle.start(), /disposed/); cases++;
    }
    {
      const h = harness(); const start = h.lifecycle.start();
      await until(() => h.records.length === 1); h.records[0].initialize.resolve(); await start;
      h.rejectRetirement(true); h.records[0].fault(new Error('closed'));
      await until(() => h.errors.length >= 2); await delay(25);
      assert.equal(h.records.length, 1); assert.equal(h.live(), 1);
      h.rejectRetirement(false); await until(() => h.records.length === 2);
      h.records[1].initialize.resolve(); await h.lifecycle.start();
      h.records[0].fault(new Error('late old close')); await delay(15);
      assert.equal(h.records.length, 2); assert.equal(h.running(), true);
      assert.equal(h.maximumLive(), 1); await h.lifecycle.stop(); cases++;
    }
    {
      const h = harness();
      await assert.rejects(h.lifecycle.start()); await h.lifecycle.stop();
      const count = h.records.length; await delay(30); assert.equal(h.records.length, count); cases++;
    }
    {
      const h = harness();
      const start = h.lifecycle.start(), failed = assert.rejects(start, /cancelled/);
      h.lifecycle.deactivate(); await failed; await h.lifecycle.stop();
      assert.equal(h.records.length, 0); cases++;
    }
    {
      const h = harness(), gate = deferred();
      const initial = h.lifecycle.start(); await until(() => h.records.length === 1);
      h.records[0].initialize.resolve(); await initial;
      h.blockRetirement(gate.promise);
      const stop = h.lifecycle.stop();
      const queued = assert.rejects(h.lifecycle.start(), /cancelled/);
      const finalStop = h.lifecycle.stop();
      h.blockRetirement(); gate.resolve(); await Promise.all([stop, finalStop, queued]);
      await delay(25); assert.equal(h.records.length, 1); assert.equal(h.live(), 0); cases++;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-owned-ipc-test-'));
    try {
      const module = path.join(temporary, 'server.cjs');
      fs.writeFileSync(module, `process.on('message', m => {
        if (m.method === 'echo') process.send({jsonrpc:'2.0', id:m.id, result:m.params});
      });`);
      const faults: unknown[] = [];
      const transport = new OwnedIpcServerTransport(module, temporary, () => {}, error => faults.push(error));
      const connection = createMessageConnection(transport.reader, transport.writer);
      connection.listen();
      try {
        assert.deepEqual(await connection.sendRequest('echo', { owner: 'first' }), { owner: 'first' });
        const originalWrite = IPCMessageWriter.prototype.write;
        IPCMessageWriter.prototype.write = function (message: Message): Promise<void> {
          if ('method' in message && message.method === 'failed-write') return Promise.reject(new Error('injected IPC write failure'));
          return originalWrite.call(this, message);
        };
        try { await assert.rejects(connection.sendRequest('failed-write'), /transport retired/); cases++; }
        finally { IPCMessageWriter.prototype.write = originalWrite; }
        const pending = connection.sendRequest('withheld');
        const rejected = assert.rejects(pending, /transport retired/);
        const initialization = deferred();
        transport.invalidate(initialization.promise); await rejected;
        await assert.rejects(connection.sendRequest('echo', { owner: 'late' }), /transport retired/);
        initialization.resolve(); await transport.retire();
        await transport.writer.write({ jsonrpc: '2.0' });
        assert.equal(faults.length, 1); cases++;
      } finally { await transport.retire(); connection.dispose(); }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    await delay(20); assert.deepEqual(unhandled, []);
    console.log(`languageServerLifecycle.test: ${cases} lifecycle and actual IPC ownership cases passed`);
  } finally { process.off('unhandledRejection', onUnhandled); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
