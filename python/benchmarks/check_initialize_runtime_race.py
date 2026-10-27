"""Verify real runtime source-race rejection and a current-source fresh restart."""
import argparse
import json
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client

parser = argparse.ArgumentParser()
parser.add_argument('--log-prefix', default='bench/initialize-source-stability-runtime')
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix='djls-runtime-race-') as temporary:
    base = Path(temporary).resolve()
    root = base / 'workspace'
    root.mkdir()
    blog = root / 'blog'
    blog.mkdir()
    (blog / '__init__.py').write_text('')
    source = blog / 'models.py'
    source.write_text('from django.db import models\n'
        'class FieldSize(models.Transform):\n    lookup_name="field_size"\n'
        '    @property\n    def output_field(self):\n'
        '        return models.DateField() if self.lhs.output_field.max_length==10 else models.CharField()\n'
        'class Post(models.Model):\n    title=models.CharField(max_length=255)\n'
        'Post._meta.get_field("title").register_lookup(FieldSize)\n')
    (root / 'settings.py').write_text('INSTALLED_APPS=["blog"]\nSECRET_KEY="race"\n'
        'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
    cache = base / 'cache'
    client = Client(root, cache, worker_module='benchmarks.initialize_runtime_race_worker', keep_log=True,
        worker_environment={'DJLS_BENCH_RUNTIME_RACE_SOURCE': str(source)})
    error = None
    try:
        try:
            client.request('initialize', {'workspaceRoot': str(root), 'settingsModule': 'settings', 'deferRuntime': False})
        except RuntimeError as caught:
            error = str(caught)
        assert error and 'changed during runtime' in error
    finally:
        client.close()
    rejected_log = args.log_prefix + '-rejected-daemon.log'
    Path(rejected_log).write_bytes(Path(client.log.name).read_bytes())
    written = [str(path.relative_to(cache)) for path in cache.rglob('*.json')]
    assert not written, written
    assert 'max_length=10 ' in source.read_text()
    restarted = Client(root, cache, keep_log=True)
    try:
        result, elapsed = restarted.request('initialize', {'workspaceRoot': str(root),
            'settingsModule': 'settings', 'deferRuntime': False})
        assert result['health']['runtime']['bootstrapStatus'] == 'ready'
        catalog = result['lookupCatalog']
        field_type = catalog['types'][catalog['fields']['blog.Post']['title']]
        output_kind = catalog['types'][field_type['transforms']['field_size']]['fieldKind']
        assert output_kind == 'DateField', output_kind
    finally:
        restarted.close()
    restarted_log = args.log_prefix + '-restarted-daemon.log'
    Path(restarted_log).write_bytes(Path(restarted.log.name).read_bytes())
    print(json.dumps({'runtimeWasReadyBeforeEdit': True, 'raceRejected': True,
        'mismatchedCachesWritten': written, 'freshRestartOutputKind': output_kind,
        'freshRestartInitializeMs': elapsed, 'rejectedLog': rejected_log, 'restartedLog': restarted_log,
        'scope': 'Actual configured Django in fresh daemon; same-size max_length edit/restoredmtime after completed runtime inspection. Reject without cache writes, then manually fresh ordinary daemon confirms current parameterized DateField output. Does not prove automatic client restart or all race points/platform/atomicity.'}, indent=2))
