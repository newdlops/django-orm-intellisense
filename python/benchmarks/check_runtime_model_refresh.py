"""New-model lifecycle in initially empty, custom-labelled and nested apps."""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.check_runtime_health_refresh import assert_catalogue_matches


def added_source(prefix, manager):
    return f'''from django.db import models
class Sized(models.Transform):
    lookup_name = "alias_size"
    output_field = models.IntegerField()
class Queries(models.QuerySet):
    pass
def {prefix}_query(self) -> models.QuerySet:
    return self
Queries.{prefix}_query = {prefix}_query
class Manager(models.Manager.from_queryset(Queries)):
    pass
class Base(models.Model):
    class Meta:
        abstract = True
        app_label = "late_custom"
class Added(Base):
    code = models.UUIDField(primary_key=True)
    value = models.CharField(max_length=20)
    owner = models.ForeignKey("coreapp.Post", on_delete=models.CASCADE, related_name="added_rows", related_query_name="added_query")
    objects = Manager()
    {manager} = Manager()
    def {prefix}_instance(self) -> "Added":
        return self
    @classmethod
    def {prefix}_class(cls) -> "Added":
        return cls()
class Explicit(models.Model):
    number = models.IntegerField()
    class Meta:
        app_label = "plainapp"
Added._meta.get_field("value").register_lookup(Sized)
'''


def run(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-empty-app-models-') as temporary:
        root = Path(temporary).resolve() / 'project'
        for package in ('coreapp', 'lateapp', 'plainapp', 'outer', 'outer/inner'):
            (root / package).mkdir(parents=True, exist_ok=True)
            (root / package / '__init__.py').write_text('')
        for module, label in (('lateapp', 'late_custom'), ('outer.inner', 'nested_custom')):
            package = root.joinpath(*module.split('.'))
            (package / 'apps.py').write_text('from django.apps import AppConfig\n'
                f'class Config(AppConfig):\n    name={module!r}\n    label={label!r}\n')
        (root / 'health_settings.py').write_text('INSTALLED_APPS=["coreapp", "lateapp", "plainapp", "outer.inner"]\n'
            'SECRET_KEY="model-refresh"\nDEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        (root / 'coreapp/models.py').write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField(max_length=20)\n')
        source, nested = root / 'lateapp/models.py', root / 'outer/inner/models.py'
        source.write_text('')
        nested.write_text('')
        client = Client(root, root.parent / 'cache', keep_log=True)
        try:
            initial, _ = client.request('initialize', {'workspaceRoot': str(root), 'settingsModule': 'health_settings', 'deferRuntime': False})
            full = initial if initial.get('surfaceIndex') else client.wait_for_notification('surfaceIndexChanged', lambda value: bool(value.get('surfaceIndex')))
            for phase in ('initial', 'added', 'edited', 'deleted', 'recreated'):
                present = phase in ('added', 'edited', 'recreated')
                prefix, manager = ('changed', 'revised') if phase == 'edited' else ('current', 'archive')
                started = time.perf_counter()
                if phase != 'initial':
                    client.notifications.clear()
                    source.write_text(added_source(prefix, manager) if present else '')
                    nested.write_text('from django.db import models\nclass Nested(models.Model):\n    value=models.DateField()\n' if present else '')
                    for path in (source, nested):
                        reply, _ = client.request('reindexFile', {'filePath': str(path)})
                        assert reply['runtimeMembersPending'], reply
                    full = client.wait_for_notification('surfaceIndexChanged', lambda value:
                        value.get('runtimeMembersPending') is False
                        and len(value.get('surfaceIndex') or {}) == (4 if present else 1)
                        and (not present or prefix + '_instance' in value['surfaceIndex'].get('late_custom.Added', {}).get('instance', {})))
                payload = output_dir / (phase + '-payload.json')
                payload.write_text(json.dumps(full, sort_keys=True) + '\n')
                sources = output_dir / (phase + '-sources.json')
                sources.write_text(json.dumps({str(path.relative_to(root)): path.read_text() for path in sorted(root.rglob('*.py'))}, sort_keys=True) + '\n')
                expected_path = output_dir / (phase + '-oracle.json')
                check = subprocess.run([sys.executable, '-m', 'benchmarks.check_runtime_health_refresh', '--oracle',
                    '--check-surface', '--root', str(root), '--output-dir', str(expected_path)], capture_output=True, text=True, timeout=30)
                assert check.returncode == 0, check.stderr
                expected = json.loads(expected_path.read_text())
                assert full['surfaceIndex'] == expected['surface'], (phase, 'whole surface')
                assert full['health']['runtime'] == expected['runtime'], (phase, 'whole diagnostics')
                count = assert_catalogue_matches(full['lookupCatalog'], expected['coldInspection']['lookupCatalog'], expected['surface'])
                targets, _ = client.request('relationTargets', {})
                assert targets['items'] == expected['relationTargets'], (phase, 'whole relation targets', targets)
                assert all(item['appLabel'] == item['label'].rsplit('.', 1)[0] for item in targets['items'])
                checks = []
                if present:
                    label = 'late_custom.Added'
                    entry = full['surfaceIndex'][label]
                    assert entry['instance']['pk'][3] == 'UUIDField'
                    assert 'id' not in entry['instance']
                    assert entry['instance']['owner_id'][3] == 'BigAutoField'
                    for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                        name = prefix + ('_instance' if kind in ('instance', 'model_class') else '_query')
                        result, elapsed = client.request('resolveOrmMember', {'modelLabel': label, 'receiverKind': kind, 'name': name})
                        assert result['resolved'], result
                        checks.append({'receiverKind': kind, 'rpcMs': elapsed})
                    for kind in ('manager', 'queryset', 'related_manager'):
                        result, _ = client.request('resolveOrmMemberChain', {'modelLabel': label, 'receiverKind': kind,
                            'managerName': manager, 'chain': [prefix + '_query']})
                        assert result['resolved'] and result['receiverKind'] == 'queryset', result
                    for base, value in ((label, 'value__alias_size__gte'), (label, 'pk__exact'),
                            (label, 'owner_id__gte'), ('coreapp.Post', 'added_query__value__alias_size__gte')):
                        result, _ = client.request('resolveLookupPath', {'baseModelLabel': base, 'value': value, 'method': 'filter'})
                        assert result['resolved'], (phase, value, result)
                else:
                    assert not {'late_custom.Added', 'plainapp.Explicit', 'nested_custom.Nested'} & full['lookupCatalog']['fields'].keys()
                    assert 'added_query' not in full['surfaceIndex']['coreapp.Post']['instance']
                rows.append({'phase': phase, 'models': len(expected['surface']), 'wholeSurfaceAndHealthEqual': True,
                    'reachableCatalogueEqual': True, 'descriptorPairs': count, 'allFiveAndNamedReceiverQueries': checks,
                    'elapsedMsIncludingFreshOracle': (time.perf_counter() - started) * 1000,
                    'payload': str(payload), 'oracle': str(expected_path), 'sources': str(sources)})
        finally:
            client.close()
            (output_dir / 'daemon.log').write_bytes(Path(client.log.name).read_bytes())
        assert client.process.returncode == 0
    return {'rows': rows, 'daemonExitCode': 0,
        'scope': 'Same daemon; initially empty AppConfig and nested apps, explicit Meta.app_label, abstract inheritance, '
            'UUID PK, FK attname/reverse query aliases, per-instance transform, all five/named receivers, edits/delete/recreate. '
            'Whole surfaces/health and reachable lookup descriptors checked with independent fresh Django. No latency SLO proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir), indent=2))
