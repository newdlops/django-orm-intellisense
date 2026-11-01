"""Bounded before/after workload. No forced GC or global runtime tuning."""
import contextlib
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import statistics
import sys
import tempfile
import time
from unittest import mock

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture', type=Path, required=True, help='Owned synthetic fixture directory, reused unchanged across runs')
parser.add_argument('--cache', type=Path, required=True, help='Owned cache directory; reuse it for a restart comparison')
parser.add_argument('--output', type=Path, required=True, help='JSON observation receipt')
parser.add_argument('--variant', default='current')
parser.add_argument('--python-source', type=Path, help='Alternate package source root, e.g. an extracted baseline git archive')
args = parser.parse_args()
sys.path.insert(0, str(args.python_source.resolve() if args.python_source else Path(__file__).resolve().parents[1] / 'python'))
from django_orm_intellisense.server.project_daemon import ProjectDaemonServer
from django_orm_intellisense.server.workspace_projects import ProjectWire
from django_orm_intellisense.runtime import projects as runtime_projects

receipt = args.variant
workspace = args.fixture.resolve()
workspace.mkdir(parents=True, exist_ok=True)
def write(relative, text):
    path = workspace / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(text)
write('manage.py', "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.profile0')\n")
write('config/__init__.py', '')
write('config/settings/__init__.py', '')
write('inventory/__init__.py', '')
write('config/settings/base.py', "SECRET_KEY='fixture'\nINSTALLED_APPS=['inventory']\nDEFAULT_AUTO_FIELD='django.db.models.AutoField'\nDATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n")
for profile in range(7):
    write(f'config/settings/profile{profile}.py', f'from .base import *\nPROFILE={profile}\n')
write('inventory/models.py', 'from django.db import models\n' + '\n'.join(
    f'class Item{index}(models.Model):\n' + ''.join(f'    field{field} = models.CharField(max_length=20)\n' for field in range(12))
    for index in range(100)))
for index in range(2000):
    write(f'helpers/helper{index}.py', f'VALUE={index}\n')
source_digest = hashlib.sha256()
for file in sorted(workspace.rglob('*.py')):
    source_digest.update(str(file.relative_to(workspace)).encode() + b'\0' + file.read_bytes())
cache = args.cache.resolve()
cache.mkdir(parents=True, exist_ok=True)
os.environ['DJANGO_ORM_INTELLISENSE_CACHE_DIR'] = str(cache)
transfers, conversions, workers = [], [], []
original_spawn = runtime_projects.subprocess.Popen
def spawn(arguments, *args, **kwargs):
    if 'django_orm_intellisense._project_runtime_worker' in arguments:
        workers.append(True)
    return original_spawn(arguments, *args, **kwargs)
original_state = runtime_projects._private_state_file
original_catalog = ProjectWire.catalog
@contextlib.contextmanager
def state_file(value, prefix):
    with original_state(value, prefix) as path:
        transfers.append(Path(path).stat().st_size)
        yield path
def catalog(self, value):
    conversions.append(self.project.namespace)
    return original_catalog(self, value)
output = sys.stdout
try:
    server = ProjectDaemonServer(workspace)
finally:
    sys.stdout = output
server._write_notification = lambda *_args, **_kwargs: None
try:
    with mock.patch.object(runtime_projects, '_private_state_file', side_effect=state_file), mock.patch.object(ProjectWire, 'catalog', catalog), mock.patch.object(runtime_projects.subprocess, 'Popen', spawn):
        started = time.perf_counter()
        initialized = server._initialize({'workspaceRoot': str(workspace)})
        cold_ms = (time.perf_counter() - started) * 1000
        before = len(conversions)
        durations = []
        for _ in range(8):
            started = time.perf_counter()
            server._projects.payload()
            durations.append((time.perf_counter() - started) * 1000)
        publications = len(conversions) - before
    assert initialized['health']['runtime']['readySettingsCount'] == 7
    assert initialized['health']['runtime']['modelCount'] == 100
    record = {'variant': receipt, 'sourceSha256': source_digest.hexdigest(), 'sourceFiles': 2012,
        'settings': 7, 'models': 100, 'coldInitializeMs': round(cold_ms, 3),
        'unchangedPublicationMedianMs': round(statistics.median(durations), 3),
        'unchangedPublicationSamplesMs': [round(value, 3) for value in durations],
        'unchangedCatalogConversions': publications, 'workerStateFiles': len(transfers),
        'registryWorkers': len(workers),
        'workerStateBytes': sum(transfers), 'maxRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
        'rssScope': 'Per-process RSS high-water observation; no shared-page physical-memory or instantaneous system peak claim'}
    states = tuple(server._projects.states.values())
    record['uniqueGraphFieldRecords'] = len({id(field) for state in states
        for row in state.engine.model_graph.fields_by_model_label.values() for field in row.values()})
    record['uniqueRuntimeFieldRecords'] = len({id(field) for state in states
        for model in state.engine.runtime_inspection.model_catalog for field in model.fields})
    record['uniquePublishedReturnRows'] = len({id(row) for model in initialized['surfaceIndex'].values()
        for members in model.values() for row in members.values()})
    record['cacheBytes'] = sum(path.stat().st_size for path in cache.rglob('*') if path.is_file())
    record['analysisCodeRoot'] = str(Path(runtime_projects.__file__).resolve().parents[1])
    code_digest = hashlib.sha256()
    root = Path(record['analysisCodeRoot'])
    for source in sorted(root.rglob('*.py')):
        code_digest.update(source.relative_to(root).as_posix().encode() + b'\0' + source.read_bytes() + b'\0')
    record['analysisCodeSha256'] = code_digest.hexdigest()
    record['benchmarkScriptSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))
finally:
    server._stopping.set()
    server._close_projects()
