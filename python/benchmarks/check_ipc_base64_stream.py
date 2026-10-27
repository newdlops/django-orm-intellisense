"""Candidate base64 carry preserves exact bytes across arbitrary boundaries."""
import base64
import json
import random

from benchmarks.ipc_base64_stream_candidate import StreamBase64Sink, encode_candidate
from django_orm_intellisense.server.ipc_encoding import encode_ipc_message


class Flush:
    def __init__(self, data):
        self.data = data

    def flush(self):
        return self.data


random_source = random.Random(20261010)
cases = 0
for count in [0, 1, 2, 3, 4, 5, 31, 32, 33, 255, 256, 257, 65535, 65536, 65537]:
    data = random_source.randbytes(count)
    for width in [1, 2, 3, 4, 7, 64, 1024]:
        sink = StreamBase64Sink(1, False)
        for start in range(0, count, width):
            sink._append_compressed(data[start:start+width])
            sink._append_compressed(b'')
            assert len(sink.base64_tail) <= 2
        sink.compressor = Flush(b'')
        line, kind = sink.finish()
        assert kind == 'gzip+b64'
        assert json.loads(line)['data'] == base64.b64encode(data).decode('ascii')
        assert sink.base64_tail == b'' and not sink.base64_parts
        cases += 1
for payload in [{'value': 'x'*count} for count in [0, 1000, 1024, 1025, 65536]] + [
        {'unicode': '한글 🐍\n"\\'*10000, 'future': {'__proto__': [None, True, 1, {'nested': 'value'}]}}]:
    for threshold in [-1, 0, 1, 256]:
        expected = encode_ipc_message(payload, threshold)[:3]
        for mode in ['release', 'stream']:
            assert encode_candidate(payload, threshold, mode)[:3] == expected
            cases += 1
print(json.dumps({'candidateOnly': True, 'cases': cases, 'passed': True,
    'scope': '105exact binarybase64 boundary/emptychunk/2bytecarry cases and48completeJSONthreshold/unicode/future-message wire comparisons. Candidateonly; no concurrency/pipeline/globalmemory claim.'}))
