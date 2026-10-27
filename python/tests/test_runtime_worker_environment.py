import dataclasses
import os
import pickle
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index


class RuntimeWorkerEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-worker-environment-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'blog').mkdir()
        (self.root / 'blog/__init__.py').write_text('')
        (self.root / 'blog/models.py').write_text(
            'import django\nfrom django.db import models\nclass Post(models.Model):\n'
            '    value=models.CharField(max_length=20)\n'
            '    if django.VERSION[0] == 5:\n'
            '        def native_five(self) -> str:\n            return "five"\n'
            '    else:\n'
            '        def native_six(self) -> str:\n            return "six"\n')
        (self.root / 'fixture_settings.py').write_text(
            'SECRET_KEY="test"\nINSTALLED_APPS=["blog"]\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n'
            'DEFAULT_AUTO_FIELD="django.db.models.AutoField"\n')
        self.static = build_static_index(self.root)
        self.runtime = dataclasses.replace(create_pending_runtime_inspection('fixture_settings'), bootstrap_status='ready')
        self.graph = build_model_graph(self.static, self.runtime)
        self.package_root = str(Path(runtime_members.__file__).resolve().parents[2])

    def refresh(self):
        return runtime_members.refresh_in_process(self.static, self.runtime, self.graph,
            self.root, (), lambda: True, threading.Event())

    def test_explicit_pythonpath_is_preserved_without_implicit_parent_libraries(self):
        foreign = str(self.root / 'parent-python/stdlib')
        cases = [(None, self.package_root), ('', self.package_root + os.pathsep),
                 ('declared', self.package_root + os.pathsep + 'declared'),
                 ('first' + os.pathsep + '', self.package_root + os.pathsep + 'first' + os.pathsep),
                 (self.package_root, self.package_root),
                 (self.package_root + os.pathsep + 'tail', self.package_root + os.pathsep + 'tail'),
                 ('한 글' + os.pathsep + '한 글' + os.pathsep,
                  self.package_root + os.pathsep + '한 글' + os.pathsep + '한 글' + os.pathsep)]
        for declared, expected in cases:
            with self.subTest(declared=declared):
                environment = {'KEEP_ME': 'fixture-value'}
                if declared is not None:
                    environment['PYTHONPATH'] = declared
                observed = []
                def start(argv, **kwargs):
                    observed.append((argv, kwargs))
                    with Path(argv[4]).open('wb') as stream:
                        pickle.dump({'complete': True}, stream)
                    return mock.Mock(returncode=0, poll=mock.Mock(return_value=0))
                with mock.patch.dict(os.environ, environment, clear=True), \
                        mock.patch.object(runtime_members, 'sys', types.SimpleNamespace(path=[foreign]), create=True), \
                        mock.patch.object(runtime_members.subprocess, 'Popen', start):
                    self.assertEqual(self.refresh(), {'complete': True})
                    self.assertEqual(dict(os.environ), environment)
                argv, options = observed[0]
                self.assertEqual(argv[0], self.runtime.python_executable)
                self.assertEqual(options['env'], {**environment, 'PYTHONPATH': expected})

    def test_actual_worker_uses_native_django_instead_of_implicit_parent_venv(self):
        foreign = self.root / 'parent-venv/site-packages'
        (foreign / 'django').mkdir(parents=True)
        (foreign / 'django/__init__.py').write_text('raise RuntimeError("Implicit parent venv path was replayed")\n')
        with mock.patch.object(runtime_members, 'sys', types.SimpleNamespace(path=[str(foreign)]), create=True):
            result = self.refresh()
        self.assertEqual(result.runtime_metadata['modelCount'], 1)
        self.assertEqual(result.surface['blog.Post']['instance']['value'],
            ('scalar', 'blog.Post', 'field', 'CharField'))

    def test_actual_worker_honors_declared_search_path_order(self):
        first, second = self.root / 'first', self.root / 'second'
        first.mkdir()
        second.mkdir()
        (first / 'declared_token.py').write_text('VALUE="first"\n')
        (second / 'declared_token.py').write_text('VALUE="second"\n')
        settings = self.root / 'fixture_settings.py'
        settings.write_text('from declared_token import VALUE\n' + settings.read_text())
        models = self.root / 'blog/models.py'
        models.write_text('from declared_token import VALUE\n' + models.read_text()
            + '    if VALUE == "first":\n'
              '        def declared_first(self) -> str:\n            return VALUE\n'
              '    else:\n'
              '        def declared_second(self) -> str:\n            return VALUE\n')
        self.static = build_static_index(self.root)
        self.graph = build_model_graph(self.static, self.runtime)
        declared = str(first) + os.pathsep + str(second) + os.pathsep
        with mock.patch.dict(os.environ, {'PYTHONPATH': declared}):
            result = self.refresh()
            self.assertEqual(os.environ['PYTHONPATH'], declared)
        names = {item.name for item in result.snapshot.items[('blog.Post', 'instance', None)]}
        self.assertIn('declared_first', names)
        self.assertNotIn('declared_second', names)


if __name__ == '__main__':
    unittest.main()
