"""Rotating actual stdio comparison of complete and delta model transport."""
import argparse
import gzip
import json
from pathlib import Path

from benchmarks.bench_runtime_refresh_foreground import run as run_foreground
from benchmarks.bench_runtime_refresh_selective import normalize


def full(row):
    with gzip.open(row['payload'],'rt') as stream:
        value=json.load(stream)
    root=value['health']['workspaceRoot']
    value['health'].pop('startedAt')
    return normalize(value,root)


def run(models,files,repetitions,output_dir):
    output_dir.mkdir(parents=True,exist_ok=True)
    pairs=[]
    for repetition in range(repetitions):
        pair={}
        for name in (('full','delta') if repetition%2==0 else ('delta','full')):
            pair[name]=run_foreground(models,files,output_dir/f'{repetition}-{name}',1,
                'django_orm_intellisense',1 if name=='delta' else 0)
            print(f'[runtime-transport] pair={repetition} mode={name} daemons=2 exit0',file=__import__('sys').stderr,flush=True)
        left=[row for row in pair['full']['nodeRuns'][0]['rows'] if 'payload' in row]
        right=[row for row in pair['delta']['nodeRuns'][0]['rows'] if 'payload' in row]
        assert [row['phase'] for row in left]==[row['phase'] for row in right]
        for first,second in zip(left,right):
            assert full(first)==full(second),first['phase']
        pairs.append(pair)
    return {'models':models,'pythonFiles':files,'repetitions':repetitions,'pairs':pairs,
        'everyFullPacketEqualExceptFixtureRootAndStartedAt':True,
        'scope':'Sequential rotating opt-in model delta versus full notification transport in the same '
            'production daemon, with the actual compiled extension decoder in a separate Node CLI. '
            'All reconstructed full fields and fingerprints compared; all five receivers, named chains, '
            'parameterized transforms, unchanged fields/relations and retained stale pyc checked. '
            'RPC/timer/parse/reconstruction measurements during refresh. No actual editor/adoption or '
            'stableSLO/aggregate-memory assertion; first cold/full frame still transports all models.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--models',type=int,default=500)
    parser.add_argument('--files',type=int,default=5000)
    parser.add_argument('--repetitions',type=int,default=3)
    parser.add_argument('--output-dir',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(run(args.models,args.files,args.repetitions,args.output_dir.resolve()),indent=2))
