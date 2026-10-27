"""Measure fresh-process initialization and edit RPCs including serialization."""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.discovery.workspace import resolve_venv_info


class Client:
    def __init__(self, root: Path, cache: Path, profile: Path | None = None,
                 request_timeout_seconds: float = 30,
                 worker_module: str = 'django_orm_intellisense',
                 keep_log: bool = False,
                 worker_environment: dict[str, str] | None = None):
        env = {**os.environ, 'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(cache),
               'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
        if worker_environment:
            env.update(worker_environment)
        self.started = time.perf_counter()
        self.log = tempfile.NamedTemporaryFile(mode='w+', prefix='djls-daemon-log-', delete=False)
        command = [sys.executable]
        if profile:
            command += ['-m', 'cProfile', '-o', str(profile)]
        command += ['-m', worker_module, '--stdio', '--workspace', str(root)]
        self.process = subprocess.Popen(command,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, env=env, cwd=root)
        self.messages = queue.Queue()
        self.serial = 0
        self.notifications = []
        self.failed_request: dict[str, object] | None = None
        self.keep_log = keep_log
        self.request_timeout_seconds = request_timeout_seconds
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            message = json.loads(line)
            if message.get('_enc') == 'gzip+b64':
                message = json.loads(gzip.decompress(base64.b64decode(message['data'])))
            self.messages.put(message)
        self.messages.put(None)

    def request(self, method: str, params: dict):
        self.serial += 1
        request_id = self.serial
        started = time.perf_counter()
        self.process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.perf_counter() + self.request_timeout_seconds
        while True:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.perf_counter()))
            except queue.Empty as error:
                self.failed_request = {'method': method, 'id': request_id}
                raise TimeoutError(f'{method} did not reply within {self.request_timeout_seconds:g}s; daemon log: {self.log.name}') from error
            if message is None:
                raise RuntimeError('Daemon exited before replying')
            if message.get('event'):
                self.notifications.append(message)
            if message.get('id') != request_id:
                continue
            if 'error' in message:
                raise RuntimeError(message['error'])
            return message['result'], (time.perf_counter() - started) * 1000

    def wait_for_verification(self):
        deadline = time.perf_counter() + 30
        while time.perf_counter() < deadline:
            # Use a separate descriptor so reads do not seek the daemon's log.
            log = Path(self.log.name).read_text()
            if ('verify_cached_source_snapshot status=unchanged' in log
                    or 'verify_source_snapshot_before_initialize' in log
                    or 'refresh_cached_source_snapshot applied' in log):
                return log
            time.sleep(0.05)
        raise TimeoutError('Cached source verification did not finish')

    def wait_for_notification(self, event, accept, timeout_seconds=30):
        for notification in self.notifications:
            if notification.get('event') == event and accept(notification['params']):
                return notification['params']
        deadline = time.perf_counter() + timeout_seconds
        while time.perf_counter() < deadline:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.perf_counter()))
            except queue.Empty:
                break
            if message is None:
                raise RuntimeError('Daemon exited while awaiting notification')
            if message.get('event'):
                self.notifications.append(message)
                if message['event'] == event and accept(message['params']):
                    return message['params']
        self.failed_request = {'method': 'notification:' + event}
        raise TimeoutError(f'Current {event} did not arrive; daemon log: {self.log.name}')

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=3)
        self.log.close()
        if self.failed_request is None and not self.keep_log:
            Path(self.log.name).unlink(missing_ok=True)
        elif self.failed_request is not None:
            print(f'[benchmark] failed request log retained: {self.log.name}', file=sys.stderr)


def run(count: int, profile_dir: Path | None = None, file_count: int | None = None):
    with tempfile.TemporaryDirectory(prefix='djls-lifecycle-') as temp:
        folder = Path(temp)
        root = folder / 'project'
        root.mkdir()
        cache = folder / 'cache'
        files = generate_synthetic_project(root, count)
        generated_count = len(list(root.rglob('*.py')))
        if file_count:
            assert file_count >= generated_count
            padding = root / 'bench_helpers'
            padding.mkdir()
            for number in range(file_count - generated_count):
                (padding / f'helper_{number}.py').write_text(f'value = {number}\n')
        total_files = len(list(root.rglob('*.py')))
        measurements = []
        for name in ('cold', 'cached'):
            client = Client(root, cache, profile_dir / f'{name}.prof' if profile_dir else None)
            try:
                result, initialize_ms = client.request('initialize', {'workspaceRoot': str(root), 'deferRuntime': True})
                assert len(result['modelNames']) == count
                measurements.append({'phase': name, 'initializeRpcMs': initialize_ms,
                    'processToReadyMs': (time.perf_counter() - client.started) * 1000,
                    'models': len(result['modelNames']), 'fallbackModels': len(result.get('staticFallback') or {})})
                if name == 'cached':
                    edits = {}
                    fallback = dict(result.get('staticFallback') or {})
                    surface = dict(result.get('surfaceIndex') or {})
                    path = files[0]
                    original = path.read_text()
                    for kind, text in (
                        ('scalar_add', original + '\n    extra = models.TextField()\n'),
                        ('scalar_type', original.replace('models.CharField(max_length=255)', 'models.TextField()')),
                        ('fk_retarget', original.replace("'app0.Model1'", "'app0.Model2'")),
                        ('restore', original),
                    ):
                        path.write_text(text)
                        reply, elapsed = client.request('reindexFile', {'filePath': str(path)})
                        assert reply.get('surfaceIndexDelta')
                        assert 'staticFallback' not in reply, 'Edit RPC must not resend the full fallback'
                        for label in reply.get('removedStaticFallbackLabels', []):
                            fallback.pop(label, None)
                        fallback.update(reply.get('staticFallbackDelta') or {})
                        for label in reply.get('removedLabels', []):
                            surface.pop(label, None)
                        surface.update(reply['surfaceIndexDelta'])
                        assert len(set(fallback) | set(surface)) == count, 'Delta lost model coverage'
                        edits[kind] = {'rpcMs': elapsed, 'changedModels': len(reply.get('changedLabels') or []),
                                       'payloadBytes': len(json.dumps(reply))}
                    measurements[-1]['edits'] = edits
                    helper = root / 'bench_helper.py'
                    extra_model = root / 'bench_extra.py'
                    file_events = {}
                    for event, event_path, text in (
                        ('helper_create', helper, 'def helper():\n    pass\n'),
                        ('helper_delete', helper, None),
                        ('model_create', extra_model, 'from django.db import models\nclass NewEntry(models.Model):\n    body = models.TextField()\n    class Meta:\n        app_label = "bench_extra"\n'),
                        ('model_delete', extra_model, None),
                    ):
                        if text is None:
                            event_path.unlink()
                        else:
                            event_path.write_text(text)
                        reply, elapsed = client.request('reindexFile', {'filePath': str(event_path)})
                        if event.startswith('helper_'):
                            assert reply.get('unchanged') is True
                        elif event == 'model_create':
                            assert 'bench_extra.NewEntry' in reply['addedLabels']
                        else:
                            assert 'bench_extra.NewEntry' in reply['removedLabels']
                        file_events[event] = {'rpcMs': elapsed, 'payloadBytes': len(json.dumps(reply))}
                    measurements[-1]['fileEvents'] = file_events
                    # Leave a real change in place while initial verification
                    # completes. An older cache refresh must not erase it.
                    path.write_text(original + '\n    verified_extra = models.TextField()\n')
                    reply, save_ms = client.request('reindexFile', {'filePath': str(path)})
                    assert 'verified_extra' in reply['surfaceIndexDelta']['app0.Model0']['instance']
                    notification_offset = len(client.notifications)
                    verification_log = client.wait_for_verification()
                    lookup, lookup_ms = client.request('resolveLookupPath', {
                        'baseModelLabel': 'app0.Model0', 'value': 'verified_extra__icontains', 'method': 'filter'})
                    assert lookup['resolved'], lookup
                    verified_notifications = [message['params'] for message in client.notifications[notification_offset:]
                        if message.get('event') == 'surfaceIndexChanged']
                    for notification in verified_notifications:
                        assert len(notification['modelNames']) == count
                        members = (notification.get('surfaceIndex') or {}).get('app0.Model0', {}).get('instance') or {}
                        fallback_fields = (notification.get('staticFallback') or {}).get('app0.Model0', {}).get('fields') or []
                        assert 'verified_extra' in members or 'verified_extra' in fallback_fields
                    measurements[-1]['verificationFollowup'] = {
                        'saveRpcMs': save_ms, 'lookupRpcMs': lookup_ms, 'editedLookupResolved': True,
                        'refreshedNotifications': len(verified_notifications),
                        'processFallbackUsed': 'verify_source_snapshot_process unavailable=' in verification_log}
                measurements[-1]['serverTimings'] = [line.strip() for line in Path(client.log.name).read_text().splitlines()
                    if line.startswith(('[initialize]', '[PERF] reindexFile'))]
            finally:
                client.close()
        return {'timestamp': __import__('datetime').datetime.now().isoformat(), 'models': count, 'pythonFiles': total_files,
                'python': sys.version, 'measurements': measurements}


def run_tiers():
    tiers = []
    for models, files, cold_budget, cached_budget in ((100, 1000, 1000, 200), (500, 5000, 3000, 500), (1000, 10000, 5000, 1000)):
        result = run(models, file_count=files)
        cold, cached = result['measurements']
        values = [('coldInitialize', cold['initializeRpcMs'], cold_budget),
                  ('cachedInitialize', cached['initializeRpcMs'], cached_budget)]
        values += [(f'reindex.{name}', measurement['rpcMs'], 20) for name, measurement in cached['edits'].items()]
        values += [(f'fileEvent.{name}', measurement['rpcMs'], 20) for name, measurement in cached['fileEvents'].items()]
        result['planBudgetChecks'] = [{'metric': name, 'actualMs': actual, 'budgetMs': budget, 'pass': actual < budget}
                                      for name, actual, budget in values]
        tiers.append(result)
    venv = []
    with tempfile.TemporaryDirectory(prefix='djls-venv-bench-') as temporary:
        root = Path(temporary)
        env_root = root / '.venv'
        env_root.mkdir()
        (env_root / 'pyvenv.cfg').write_text('version = 3.12.13\ninclude-system-site-packages = false\n')
        packages = env_root / 'lib' / 'python3.12' / 'site-packages'
        packages.mkdir(parents=True)
        for package_count in (0, 500, 2000):
            for number in range(package_count):
                (packages / f'dependency_{number}-1.0.dist-info').mkdir(exist_ok=True)
            samples = []
            for _ in range(7):
                start = time.perf_counter()
                info = resolve_venv_info(root)
                samples.append((time.perf_counter() - start) * 1000)
                assert info.site_packages == str(packages)
            samples.sort()
            venv.append({'installedMetadataDirectories': package_count, 'medianMs': samples[3], 'maxMs': samples[-1],
                         'budgetMs': 5, 'pass': samples[-1] < 5})
    return {'timestamp': __import__('datetime').datetime.now().isoformat(),
            'profile': '10 percent model files; 15 scalar fields and 2 FKs per model; remaining files are helpers',
            'tiers': tiers, 'venvDiscovery': venv,
            'allPlanBudgetsPassed': all(check['pass'] for tier in tiers for check in tier['planBudgetChecks']) and all(row['pass'] for row in venv)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--profile-dir', type=Path)
    parser.add_argument('--files', type=int)
    parser.add_argument('--tiers', action='store_true')
    args = parser.parse_args()
    if args.profile_dir:
        args.profile_dir.mkdir(parents=True, exist_ok=True)
    print(json.dumps(run_tiers() if args.tiers else run(args.models, args.profile_dir, args.files), indent=2))
