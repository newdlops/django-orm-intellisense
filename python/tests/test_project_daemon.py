from __future__ import annotations

import sys
import time
import unittest
import os
import json
import queue
import subprocess
import tempfile
import threading
from pathlib import Path

import test_project_runtime_isolation as fixtures
from django_orm_intellisense.server.project_daemon import ProjectDaemonServer


class ProjectDaemonTest(unittest.TestCase):
    setUp = fixtures.IndependentProjectRuntimeTest.setUp
    project = fixtures.IndependentProjectRuntimeTest.project

    def server(self):
        output = sys.stdout
        try:
            server = ProjectDaemonServer(self.root)
        finally:
            sys.stdout = output
        messages = []
        server._write_notification = lambda event, params, **kwargs: messages.append((event, params))
        def close():
            server._stopping.set()
            server._close_projects()
            if server._projects_thread is not None:
                server._projects_thread.join(timeout=3)
        self.addCleanup(close)
        return server, messages

    def test_real_initialize_and_scoped_requests_include_both_registries(self):
        one = self.project('one', 'first_only')
        two = self.project('two', 'second_only')
        server, _ = self.server()
        result = server._initialize({'workspaceRoot': str(self.root)})
        self.assertEqual(result['health']['runtime']['modelCount'], 2)
        self.assertEqual(result['health']['runtime']['readyProjectCount'], 2)
        self.assertEqual(len(result['projectContexts']), 2)
        for root, own, other in ((one, 'first_only', 'second_only'), (two, 'second_only', 'first_only')):
            target = server._resolve_relation_target({'value': 'inventory.Item', '_sourceFile': str(root / 'view.py')})
            self.assertTrue(target['resolved'])
            self.assertIn(own, target['target']['fieldNames'])
            self.assertNotIn(other, target['target']['fieldNames'])
            self.assertEqual(target['target']['djangoLabel'], 'inventory.Item')
        self.assertFalse(server._resolve_relation_target({'value': 'inventory.Item'})['resolved'])

    def test_deferred_initialization_and_save_refresh_preserve_other_project(self):
        one = self.project('one', 'first_only')
        self.project('two', 'second_only')
        server, messages = self.server()
        result = server._initialize({'workspaceRoot': str(self.root), 'deferRuntime': True})
        self.assertTrue(result['runtimeMembersPending'])
        deadline = time.monotonic() + 15
        while (not messages or messages[-1][1]['health']['runtime']['readyProjectCount'] != 2) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(messages)
        self.assertEqual(messages[-1][1]['health']['runtime']['readyProjectCount'], 2)
        before = messages[-1][1]
        second = next(context for context in before['projectContexts'] if context['root'].endswith('/two'))
        second_label = next(iter(second['models']))
        source = one / 'inventory/models.py'
        source.write_text(source.read_text().replace('    objects =', '    added = models.IntegerField(default=0)\n    objects ='))
        response = server._reindex_file({'filePath': str(source)})
        self.assertNotIn('error', response)
        self.assertTrue(response['surfaceIndexDelta'])
        last_count = len(messages)
        deadline = time.monotonic() + 15
        while len(messages) == last_count and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreater(len(messages), last_count)
        after = messages[-1][1]
        self.assertEqual(after['surfaceIndex'][second_label], before['surfaceIndex'][second_label])
        first = next(context for context in after['projectContexts'] if context['root'].endswith('/one'))
        self.assertIn('added', after['surfaceIndex'][next(iter(first['models']))]['instance'])

    def test_directory_reconciliation_discovers_new_independent_project(self):
        self.project('one', 'first_only')
        self.project('two', 'second_only')
        server, messages = self.server()
        server._initialize({'workspaceRoot': str(self.root)})
        self.project('three', 'third_only')
        response = server._reindex_source_directory({'filePath': str(self.root)})
        self.assertTrue(response['runtimeMembersPending'])
        deadline = time.monotonic() + 15
        while (not messages or messages[-1][1]['health']['runtime']['readyProjectCount'] != 3) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(messages[-1][1]['health']['runtime']['modelCount'], 3)

    def test_settings_file_creation_replans_the_project_roster(self):
        self.project('one', 'first_only')
        self.project('two', 'second_only')
        server, messages = self.server()
        server._initialize({'workspaceRoot': str(self.root)})
        three = self.project('three', 'third_only')
        response = server._reindex_file({'filePath': str(three / 'config/settings.py')})
        self.assertTrue(response['runtimeMembersPending'])
        self.assertEqual(len(server._projects.projects), 3)
        self.assertEqual(len(messages[-1][1]['projectContexts']), 3)

    def test_actual_stdio_entrypoint_unions_settings_and_keeps_partial_failure_visible(self):
        one = self.project('one', 'first_only')
        two = self.project('two', 'second_only')
        self.project('broken', 'broken_only', 'raise RuntimeError("fixture settings failure")\n')
        environment = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
        environment.pop('DJANGO_SETTINGS_MODULE', None)
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen([sys.executable, '-B', '-m', 'django_orm_intellisense', '--stdio',
                '--workspace', str(self.root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=errors, text=True, env=environment)
            replies = queue.Queue()
            reader = threading.Thread(target=lambda: [replies.put(json.loads(line)) for line in child.stdout], daemon=True)
            reader.start()
            def request(identifier, method, params):
                child.stdin.write(json.dumps({'id': identifier, 'method': method, 'params': params}) + '\n')
                child.stdin.flush()
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    message = replies.get(timeout=max(0.01, deadline - time.monotonic()))
                    if message.get('id') == identifier:
                        self.assertNotIn('error', message, message)
                        return message['result']
                self.fail('Daemon stdio request timed out')
            try:
                initialized = request('init', 'initialize', {'workspaceRoot': str(self.root)})
                self.assertEqual(initialized['health']['runtime']['readyProjectCount'], 2)
                self.assertEqual(len(initialized['projectContexts']), 3)
                failed = next(context for context in initialized['projectContexts'] if context['root'].endswith('/broken'))
                self.assertEqual(failed['runtime']['bootstrapStatus'], 'setup_failed')
                self.assertIn('fixture settings failure', failed['runtime']['bootstrapError'])
                for index, root, field in ((1, one, 'first_only'), (2, two, 'second_only')):
                    answer = request(str(index), 'resolveRelationTarget', {'value': 'inventory.Item', '_sourceFile': str(root / 'views.py')})
                    self.assertTrue(answer['resolved'], answer)
                    self.assertIn(field, answer['target']['fieldNames'])
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
                reader.join(timeout=2)
                child.stdout.close()
            self.assertEqual(child.returncode, 0)


if __name__ == '__main__':
    unittest.main()
