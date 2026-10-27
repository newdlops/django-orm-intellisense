"""Differential JSON, surface-shape and chunk-boundary candidate checks."""
import io
import json
import random
import argparse
from contextlib import nullcontext
from functools import partial
from unittest import mock

from benchmarks.cache_stream_candidate import candidate_module, stream_decode
from django_orm_intellisense.cache import store


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def generated(rng, depth=0):
    scalars = [None, True, False, '', '한글\\"\n[}]', 0, -4, 1.25, 1e-30, 1e+30]
    if depth >= 4 or rng.random() < .4:
        return rng.choice(scalars)
    if rng.random() < .5:
        return [generated(rng, depth + 1) for _ in range(rng.randrange(5))]
    return {str(number) + rng.choice(['키', 'name', '']): generated(rng, depth + 1)
            for number in range(rng.randrange(5))}


def run(final=False):
    if final:
        from django_orm_intellisense.cache.json_stream import decode_json_stream
        read = decode_json_stream
    else:
        read = stream_decode
    examples = [None, {}, [], {'a': {'b': {'c': [1, 2]}}},
        {'quote': '"\\{}[]\n', 'utf8': '가🙂' * 1000},
        {'number': 1.234567890123e+200, 'negative': -12345, 'tiny': 1e-250},
        float('nan'), float('inf'), float('-inf')]
    rng = random.Random(20261009)
    examples.extend(generated(rng) for _ in range(120))
    valid = 0
    for value in examples:
        for ascii in [True, False]:
            raw = ' \n' + json.dumps(value, ensure_ascii=ascii) + '\t '
            expected = canonical(json.loads(raw))
            for chunk in [1, 2, 3, 7, 17, 64, 65536]:
                actual = read(io.StringIO(raw), lambda value: value, chunk_size=chunk, object_depth=2)
                assert canonical(actual) == expected
                valid += 1
    invalid = ['', ' ', '{', '{"x":', '{"x":1,}', '{1:2}', '{"x" 1}', '{"x":1 "y":2}',
        '[1,]', '{"x":[1 2]}', '{"x":"unfinished}', '{"x":"\\q"}', '{"x":trueX}',
        '{"x":1e}', '{"x":-}', '{"x":01}', '{} trailing', '{}{}', '\ufeff{}']
    rejected = 0
    for raw in invalid:
        for chunk in [1, 2, 7, 64]:
            try:
                read(io.StringIO(raw), lambda value: value, chunk_size=chunk, object_depth=2)
            except json.JSONDecodeError:
                rejected += 1
            else:
                raise AssertionError(f'Invalid JSON accepted: {raw!r}')
    member = ['scalar', None, 'field', 'CharField']
    model = {receiver: {'value': member, 'duplicate': member}
             for receiver in ['model_class', 'manager', 'queryset', 'instance']}
    expected = {'metadata': {'future': model}, 'payload': {'app.Model': model,
        'partial.Model': {'instance': {'value': member}},
        'future.Model': {'instance': {'value': member, 'unknown': {'nested': model}}}}}
    raw = json.dumps(expected)
    checked = 0
    for chunk in [1, 2, 7, 31, 65536, 262144]:
        module = store if final else candidate_module(chunk_size=chunk, object_depth=2)
        with (mock.patch.object(module, 'decode_json_stream', partial(read, chunk_size=chunk)) if final else nullcontext()):
            actual = module._decode_surface_cache_payload(io.StringIO(raw))
            reference = store._decode_surface_cache_payload(raw)
            assert canonical(actual) == canonical(reference)
            assert isinstance(actual['payload']['app.Model']['instance']['value'], tuple)
            assert isinstance(actual['metadata']['future']['instance']['value'], list)
            assert isinstance(actual['payload']['future.Model']['instance']['unknown']['nested']['instance']['value'], list)
            first, second = module._decode_surface_cache_payload(io.StringIO(raw)), module._decode_surface_cache_payload(io.StringIO(raw))
        key1 = next(key for key in first['payload']['app.Model']['instance'] if key == 'duplicate')
        key2 = next(key for key in first['payload']['app.Model']['manager'] if key == 'duplicate')
        key3 = next(key for key in second['payload']['app.Model']['manager'] if key == 'duplicate')
        assert key1 is key2 and key1 is not key3
        checked += 1
    print(json.dumps({'validOracleComparisons': valid, 'invalidJsonRejections': rejected,
        'surfaceAndOwnershipChunkModes': checked, 'productionApplied': final,
        'scope': 'Deterministic standard JSON oracle values and malformed syntax across tiny boundaries, Unicode/number/literal splits, exact/nested/future surface shapes and independent key pools. Final mode uses the production reader and surface decoder; not OS I/O race/platform/whole-performance proof.'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--final', action='store_true')
    run(parser.parse_args().final)
