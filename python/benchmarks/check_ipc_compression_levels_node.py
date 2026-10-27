"""Exact compiled Node codec output and cost at each candidate gzip level."""
import json
import subprocess
import tempfile
from pathlib import Path

from benchmarks.ipc_compression_level_candidate import encode_level


root = Path(__file__).resolve().parents[2]
script_text = '''
const fs = require('node:fs'), assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {decompressIpcEnvelope} = require(process.argv[2]);
const expected = JSON.parse(fs.readFileSync(process.argv[3]));
const modes = process.argv.slice(4).map(path => ({path, envelope: JSON.parse(fs.readFileSync(path))}));
const samples = modes.map(() => []);
for (let round = -1; round < 9; round++) {
  for (let offset = 0; offset < modes.length; offset++) {
    const index = (round+1+offset)%modes.length;
    global.gc();
    const baseline = process.memoryUsage();
    const cpu = process.cpuUsage(), start = performance.now();
    let value = decompressIpcEnvelope(modes[index].envelope.data);
    const elapsedMs = performance.now()-start, usage=process.cpuUsage(cpu);
    const after = process.memoryUsage();
    assert.deepStrictEqual(value,expected);
    if(round>=0) samples[index].push({elapsedMs, cpuMs:(usage.user+usage.system)/1000,
      checkpointHeapBytes:after.heapUsed-baseline.heapUsed,
      checkpointExternalBytes:after.external-baseline.external, completeValuesEqual:true});
    value=null;
  }
}
process.stdout.write(JSON.stringify({modes:modes.map((row,index)=>({path:row.path,samples:samples[index]}))}));
'''
rows = []
with tempfile.TemporaryDirectory(prefix='djls-ipc-level-node-') as temporary:
    folder = Path(temporary)
    script = folder / 'decode.cjs'
    script.write_text(script_text)
    for count in [1000, 5000, 10000]:
        payload_path = Path(f'/private/tmp/djls-current446-lsp-{count}.json')
        payload = {'event': 'surfaceIndexChanged', 'params': json.loads(payload_path.read_bytes())}
        expected = folder / f'{count}-expected.json'
        expected.write_text(json.dumps(payload, sort_keys=True))
        paths = []
        for level in [6, 3, 1]:
            line, _, _, _ = encode_level(payload, 256, level)
            encoded = folder / f'{count}-level{level}.json'
            encoded.write_text(line)
            paths.append(encoded)
        result = json.loads(subprocess.check_output(['node', '--expose-gc', str(script),
            str(root / 'out/client/daemon/ipcCompression.js'), str(expected), *map(str, paths)], text=True))
        rows.append({'pythonFiles': count, 'payloadPath': str(payload_path), 'levels': [
            {'level': level, 'wireBytes': encoded.stat().st_size, 'samples': row['samples']}
            for level, encoded, row in zip([6, 3, 1], paths, result['modes'])]})
print(json.dumps({'date': '2026-10-10', 'productionApplied': False, 'rows': rows,
    'scope': 'Nine rotating actual compiled Node codec decodes/level/tier afterwarmup; completeJSONdeep-equality eachcall. Level-specific envelope/decodeCPU/checkpointheap/external cost only, not truepeak/actualeditor/IPCpipe/nativeprocess-tree proof.'}, indent=2))
