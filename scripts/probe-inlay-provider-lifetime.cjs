'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fixture, Token } = require('../out/client/providers/providerRequestLifecycle.test.js');
const sourcePath = process.argv[2] || 'out/client/providers/pythonProviders.js';
const source = fs.readFileSync(sourcePath, 'utf8');
const expectedPreserved = process.argv[3] !== 'before';
const drain = async () => { for (let tick = 0; tick < 24; tick++) await Promise.resolve(); };

async function main() {
  const queued = fixture(source, false, true);
  queued.setReady(true);
  let queuedResult;
  try {
    const dispatch = queued.queueProvider('inlay', new Token());
    for (let promotion = 0; promotion < 4; promotion++) queued.promote();
    queuedResult = Array.isArray(await dispatch());
    assert.equal(queuedResult, expectedPreserved);
    assert.equal(queued.adapterCount, 5);
  } finally { queued.dispose(); }
  assert.equal(queued.adapterCount, 0);
  const rows = [];
  for (const stage of ['startup', 'resolution']) {
    for (const ending of ['cancel', 'dispose']) {
      const test = fixture(source, false, true), token = new Token();
      test.setReady(true);
      let release;
      let calls = 0;
      test.setText('Post.objects.filter(title__icontains="draft")');
      test.setBody(() => {
        if (stage === 'resolution' && ++calls === 1) return Promise.resolve(undefined);
        return new Promise(resolve => { release = resolve; });
      });
      let settled = false;
      const pending = test.invoke('inlay', token).then(value => { settled = true; return value; });
      try {
        await drain();
        assert.ok(release, 'The controlled request must reach the selected held stage');
        const busyBeforeEnding = test.providers.isAnyInteractiveRequestInFlight();
        if (ending === 'cancel') token.cancel();
        else test.dispose();
        await drain();
        const daemonSignalAborted = test.signals.at(-1)?.aborted === true;
        assert.equal(busyBeforeEnding, expectedPreserved);
        assert.equal(settled, expectedPreserved);
        assert.equal(daemonSignalAborted, expectedPreserved);
        rows.push({ stage, ending, busyBeforeEnding, settledBeforeBodyRelease: settled,
          daemonSignalAborted, tokenListenersAfterEnding: token.listeners.size,
          retainedTimers: test.timers.size });
      } finally {
        token.cancel();
        release?.(undefined);
        await pending;
        test.dispose();
        assert.equal(test.adapterCount, 0);
        assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
      }
    }
  }
  console.log(JSON.stringify({ sourcePath,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    expectedPreserved, queuedResultPreserved: queuedResult, rows }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
