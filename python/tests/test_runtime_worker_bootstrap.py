import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from django_orm_intellisense.server.worker_lifetime import ParentExitPipe


_HELD_APP = '''import importlib.abc
import importlib.machinery
import json
import os
import sys
import threading
from pathlib import Path

class HeldApp(importlib.abc.Loader):
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        parent = sys.modules.get('django_orm_intellisense._worker_parent')
        Path(os.environ['DJLS_TEST_IMPORT_MARKER']).write_text(json.dumps({
            'pid': os.getpid(), 'path0': sys.path[0],
            'watcherCount': sum(t.name == 'djls-parent-lifetime' for t in threading.enumerate()),
            'readerInheritable': [os.get_inheritable(fd) for fd in parent._pipe_fds] if parent else None,
            'stateModuleLoaded': 'django_orm_intellisense.server.worker_state' in sys.modules,
            'membersModuleLoaded': 'django_orm_intellisense.server.runtime_members' in sys.modules}))
        threading.Event().wait()

class Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'django_orm_intellisense.server.app':
            return importlib.machinery.ModuleSpec(fullname, HeldApp())

sys.meta_path.insert(0, Finder())
'''


_FORK_OWNERSHIP = '''import json
import os
import sys
import threading
import warnings
from pathlib import Path
from django_orm_intellisense import _worker_parent as parent

parent.watch_inherited_parent_pipe(sys.argv[-2], sys.argv[-1])
from django_orm_intellisense import server
from django_orm_intellisense.server import worker_lifetime as lifetime

assert lifetime.watch_inherited_parent_pipe is parent.watch_inherited_parent_pipe
assert lifetime._start_watch is parent._start_watch
assert lifetime._pipe_fds is parent._pipe_fds
assert vars(server)['DaemonServer'] is server.app.DaemonServer
assert lifetime.ParentExitPipe.__module__ == 'django_orm_intellisense.server.worker_lifetime'
assert lifetime._SurfaceWorkerStatePath.__module__ == 'django_orm_intellisense.server.worker_lifetime'
assert sum(t.name == 'djls-parent-lifetime' for t in threading.enumerate()) == 1

with lifetime.ParentExitPipe() as sibling_channel:
    fds = tuple(parent._pipe_fds)
    assert len(fds) == 3
    # This test deliberately forks beside the watchdog to check fd ownership.
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        pid = os.fork()
    if pid == 0:
        try:
            assert not parent._pipe_fds
            assert lifetime._pipe_fds is parent._pipe_fds
            assert parent._watch_thread is None
            for fd in fds:
                try:
                    os.fstat(fd)
                except OSError:
                    pass
                else:
                    raise AssertionError('Forked sibling retained a parent channel fd')
            with lifetime.ParentExitPipe() as own_channel:
                assert parent._pipe_fds == {own_channel.reader, own_channel.writer}
        except BaseException:
            import traceback
            traceback.print_exc()
            os._exit(1)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0
    assert all(os.fstat(fd) for fd in fds)

Path(sys.argv[1]).write_text(json.dumps({'pid': os.getpid(), 'forkChild': pid,
    'watcherCount': sum(t.name == 'djls-parent-lifetime' for t in threading.enumerate()),
    'remainingReaderCount': len(parent._pipe_fds)}))
threading.Event().wait()
'''


class RuntimeWorkerBootstrapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-worker-bootstrap-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.marker = self.root / 'entered.json'
        self.stderr = self.root / 'stderr.log'
        self.processes = []
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def environment(self):
        environment = dict(os.environ)
        package_root = str(Path(__file__).resolve().parents[1])
        declared = environment.get('PYTHONPATH')
        environment['PYTHONPATH'] = package_root if declared is None else package_root + os.pathsep + declared
        return environment

    def start(self, arguments, environment, channel, errors):
        flags, options = channel.spawn_parameters()
        process = subprocess.Popen([sys.executable, '-B', *arguments, *flags],
            cwd=self.root, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=errors, **options)
        self.processes.append(process)
        channel.child_spawned()
        deadline = time.monotonic() + 10
        while not self.marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.marker.exists(), self.stderr.read_text())
        marker = json.loads(self.marker.read_text())
        self.assertEqual(marker['pid'], process.pid)
        return process, marker

    def test_real_entry_watches_parent_before_server_package_import_and_state_load(self):
        hook = self.root / 'hook'
        hook.mkdir()
        (hook / 'sitecustomize.py').write_text(_HELD_APP)
        environment = self.environment()
        environment['PYTHONPATH'] += os.pathsep + str(hook)
        environment['DJLS_TEST_IMPORT_MARKER'] = str(self.marker)
        input_path, result_path = self.root / 'input.pickle', self.root / 'result.pickle'
        input_path.write_bytes(b'Invalid input must remain unread while app import is held')
        with self.stderr.open('w') as errors:
            with ParentExitPipe() as channel:
                process, marker = self.start(['-m', 'django_orm_intellisense._runtime_member_worker',
                    str(input_path), str(result_path), str(self.root)], environment, channel, errors)
                self.assertEqual(marker['path0'], str(self.root))
                self.assertEqual(marker['watcherCount'], 1)
                self.assertEqual(marker['readerInheritable'], [False])
                self.assertFalse(marker['stateModuleLoaded'])
                self.assertFalse(marker['membersModuleLoaded'])
            started = time.monotonic()
            self.assertEqual(process.wait(timeout=3), 0)
            print(json.dumps({'event': 'owned_worker_bootstrap_eof', 'pid': process.pid,
                'exitCode': process.returncode, 'elapsedSeconds': time.monotonic() - started}), file=sys.stderr)
        self.assertFalse(result_path.exists())
        self.assertEqual(self.stderr.read_text(), '')
        print(json.dumps({'event': 'owned_worker_bootstrap_import_marker', **marker}), file=sys.stderr)

    @unittest.skipUnless(hasattr(os, 'fork'), 'Requires POSIX fork')
    def test_server_import_shares_watcher_and_fork_closes_only_inherited_channels(self):
        with self.stderr.open('w') as errors:
            with ParentExitPipe() as channel:
                process, marker = self.start(['-c', _FORK_OWNERSHIP, str(self.marker)],
                    self.environment(), channel, errors)
                self.assertEqual(marker['watcherCount'], 1)
                self.assertEqual(marker['remainingReaderCount'], 1)
            self.assertEqual(process.wait(timeout=3), 0)
        self.assertEqual(self.stderr.read_text(), '')
        print(json.dumps({'event': 'owned_worker_bootstrap_shared_fork', **marker}), file=sys.stderr)


if __name__ == '__main__':
    unittest.main()
