'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const current = require(path.resolve(process.argv[2]));
const previous = require(path.resolve(process.argv[3]));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-native-cache-chunks-'));
  try {
    const oldPath = path.join(root, 'old.bin'), newPath = path.join(root, 'new.bin');
    for (const length of [0, 1, 250, 251, 255, 256, 65535, 65536, 131079]) {
      const metadata = Buffer.from('한글 😀 metadata\0');
      const backing = Buffer.alloc(length+14);
      for (let index = 0; index < backing.length; index++) backing[index] = index % 256;
      const payload = backing.subarray(7, 7+length);
      previous.saveCacheBlob(oldPath, metadata, payload);
      const expected = fs.readFileSync(oldPath);
      current.saveCacheBlob(newPath, metadata, payload);
      assert.deepEqual(fs.readFileSync(newPath), expected);
      const chunks = [Buffer.alloc(0)];
      for (let start = 0; start < payload.length; start += 17) chunks.push(payload.subarray(start, start+17));
      chunks.push(Buffer.alloc(0));
      await current.saveCacheBlobChunksAsync(newPath, metadata, chunks);
      assert.deepEqual(fs.readFileSync(newPath), expected);
      for (const reader of [previous, current]) {
        const hit = reader.loadCacheBlob(newPath);
        assert.deepEqual(hit.metadata, metadata);
        assert.deepEqual(hit.payload, payload);
      }
    }
    const target = path.join(root, 'shared.bin');
    const unrelated = `${target}.tmp`;
    fs.writeFileSync(unrelated, 'another writer owns this');
    const payloads = [Buffer.alloc(1024*1024, 1), Buffer.alloc(1024*1024, 2)];
    await current.saveCacheBlobChunksAsync(target, Buffer.from([0]), [Buffer.alloc(1024, 0)]);
    let observations = 0, observe = true;
    const observeTarget = (async () => {
      while (observe) {
        const hit = current.loadCacheBlob(target);
        assert.ok(hit);
        const tag = hit.metadata[0];
        assert.ok([0,1,2].includes(tag));
        assert.equal(hit.payload.length, tag === 0 ? 1024 : 1024*1024);
        assert.ok(hit.payload.every(value => value === tag));
        observations++;
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    try {
      for (let round = 0; round < 10; round++) {
        await Promise.all(payloads.map((payload, index) => current.saveCacheBlobChunksAsync(
          target, Buffer.from([index+1]), [payload.subarray(0, 111), payload.subarray(111)])));
      }
    } finally { observe = false; await observeTarget; }
    assert.ok(observations > 0);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'another writer owns this');
    const failedPath = path.join(root, 'not-a-file');
    fs.mkdirSync(failedPath);
    fs.writeFileSync(path.join(failedPath, 'retained'), 'previous owner');
    await assert.rejects(current.saveCacheBlobChunksAsync(failedPath, Buffer.from('meta'), [Buffer.from('new')]));
    assert.equal(fs.readFileSync(path.join(failedPath, 'retained'), 'utf8'), 'previous owner');
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.dorm-cache-')), 'Owned cache temporary files leaked');
    console.log(JSON.stringify({ lengthsChecked: 9, syncAndAsyncOldEnvelopeEqual: true,
      oldAndNewReadersEqual: true, emptyAndOffsetChunks: true, concurrentWrites: 20,
      completeReaderObservations: observations, failurePreservesOwner: true,
      unrelatedTemporaryUntouched: true, ownedTemporaryCleanup: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
