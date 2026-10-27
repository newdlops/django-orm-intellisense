"""Decode production Python gzip envelopes with the compiled client codec."""
import gzip
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from django_orm_intellisense.server.ipc_encoding import encode_ipc_message


root = Path(__file__).resolve().parents[2]
archives = ['bench/lsp-memory-1000-payload.json.gz',
            'bench/cache-write-sharded-ready-5000-cached-payload.json.gz',
            'bench/lsp-memory-10000-payload.json.gz']
rows = []
with tempfile.TemporaryDirectory(prefix='djls-ipc-node-codec-') as temporary:
    folder = Path(temporary)
    script = folder / 'decode.cjs'
    script.write_text('const fs=require("node:fs"); const assert=require("node:assert/strict");\n'
        'const {decompressIpcEnvelope,isCompressedEnvelope}=require(process.argv[2]);\n'
        'const expected=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));\n'
        'const envelope=JSON.parse(fs.readFileSync(process.argv[4],"utf8"));\n'
        'assert.ok(isCompressedEnvelope(envelope));\n'
        'const messages=[]; const decoded=decompressIpcEnvelope(envelope.data, message=>messages.push(message));\n'
        'assert.deepStrictEqual(decoded,expected); assert.equal(messages.length,0);\n'
        'process.stdout.write(JSON.stringify({models:Object.keys(decoded.params.surfaceIndex).length,fullCodecEqual:true}));\n')
    for number, archive in enumerate(archives):
        raw = gzip.decompress((root / archive).read_bytes())
        payload = {'event': 'surfaceIndexChanged', 'params': json.loads(raw)}
        line, kind, chars, _ = encode_ipc_message(payload, 256)
        expected = folder / f'{number}-expected.json'
        encoded = folder / f'{number}-envelope.json'
        expected.write_text(json.dumps(payload, sort_keys=True))
        encoded.write_text(line)
        result = json.loads(subprocess.check_output(['node', str(script),
            str(root / 'out/client/daemon/ipcCompression.js'), str(expected), str(encoded)], text=True))
        rows.append({'inputArchive': archive, 'inputSha256': hashlib.sha256(raw).hexdigest(),
                     'encoding': kind, 'rawChars': chars, 'envelopeBytes': len(line), **result})
print(json.dumps({'rows': rows,
    'scope': 'Production Pythonencoder toactualcompiledNodeclient codec on3fullarchivednotifications; allJSON values deep-equal,0codecerrors. Actualcodec integration, noteditor/globalmemory/latency.'}, indent=2))
