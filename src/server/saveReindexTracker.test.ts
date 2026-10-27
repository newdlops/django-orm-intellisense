import * as assert from 'node:assert/strict';
import { SaveReindexTracker } from './saveReindexTracker';

const tracker = new SaveReindexTracker();
const uris = Array.from({ length: 100 }, (_, i) => `file:///model_${i}.py`);
for (const uri of uris) { tracker.opened(uri); tracker.changed(uri); }
for (const uri of uris) assert.equal(tracker.saved(uri), false, 'initial content must not schedule reindex');
for (const uri of uris) tracker.changed(uri);
for (const uri of uris) assert.equal(tracker.saved(uri), true, 'all burst edits must reindex');
for (const uri of uris) assert.equal(tracker.saved(uri), false, 'unchanged saves must not reindex again');
tracker.changed(uris[0]);
tracker.closed(uris[0]);
assert.equal(tracker.saved(uris[0]), false);
tracker.opened(uris[0]); tracker.changed(uris[0]); tracker.changed(uris[0]);
assert.equal(tracker.saved(uris[0]), true, 'reopened document edits must not be suppressed');
console.log('PASS: initial sync, 100-document edit burst, unchanged saves and close/reopen');
