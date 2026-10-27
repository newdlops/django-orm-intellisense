'use strict';
// Controlled pre-callback dispatch through the real compiled providers. This
// checks adapter lifetime only; actual editor tests own the priority oracle.
const assert = require('node:assert/strict');
const { fixture, Token } = require('../out/client/providers/providerRequestLifecycle.test.js');

async function main() {
  const rows = [];
  for (const stable of [false, true]) {
    for (const kind of ['hover', 'completion', 'definition', 'signature']) {
      const test = fixture(undefined, false, stable);
      const token = new Token();
      const result = { kind };
      test.setBody(() => Promise.resolve(result));
      try {
        const dispatch = test.queueProvider(kind, token);
        assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false,
          'Workbench selection happens before any in-callback activity guard');
        for (let promotion = 0; promotion < 4; promotion++) test.promote();
        test.fireTimers();
        const actual = await dispatch();
        assert.equal(actual, stable ? result : undefined,
          'Only the retained adapter can receive a request selected before replacement');
        assert.equal(test.sourceCalls, stable ? 1 : 0);
        assert.equal(test.adapterCount, 5, 'Neither route may accumulate language-feature adapters');
        assert.equal(test.timers.size, 0);
        assert.equal(token.listeners.size, 0);
        rows.push({ kind, strategy: stable ? 'persistentAdapter' : 'replaceAndDispose',
          selectedBeforeCallback: true, promotionsBeforeDispatch: 4,
          callbackReached: test.sourceCalls === 1, resultPreserved: actual === result,
          adaptersBeforeFinalDisposal: test.adapterCount });
      } finally {
        test.dispose();
        assert.equal(test.adapterCount, 0);
        assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
      }
    }
  }
  console.log(JSON.stringify({ status: 'lifetime_boundary_verified_priority_fix_still_open', rows }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
