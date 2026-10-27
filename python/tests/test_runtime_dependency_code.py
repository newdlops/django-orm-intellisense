"""Checked dependency CODE never substitutes a stale runtime or loader hook."""
import _imp
import _io
import builtins
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import py_compile
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime import dependency_code


@contextlib.contextmanager
def compilation_calls():
    calls = []
    previous = sys.getprofile()
    def observe(frame, event, argument):
        if event == 'c_call' and argument is builtins.compile:
            calls.append(frame.f_code.co_filename)
    sys.setprofile(observe)
    try:
        yield calls
    finally:
        sys.setprofile(previous)


class RuntimeDependencyCodeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-dependency-code-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / 'djls_dependency_control.py'
        self.source.write_text("value='A'\ndef nested(): return value\n")
        self.cache = self.root / 'cache'
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.dict(os.environ, {
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.cache)}))
        stack.enter_context(mock.patch.object(sys, 'dont_write_bytecode', True))
        stack.enter_context(mock.patch.object(sys, 'pycache_prefix', None))
        stack.enter_context(mock.patch.object(_imp, 'check_hash_based_pycs', 'default'))

    def loader(self):
        loader = importlib.machinery.SourceFileLoader('djls_dependency_control', str(self.source))
        dependency_code.cache_dependency_code(loader, loader.name)
        return loader

    def load(self):
        loader = self.loader()
        code = loader.get_code(loader.name)
        namespace = {}
        exec(code, namespace)
        return namespace, code, loader

    def test_second_load_uses_checked_code_and_restores_standard_loader(self):
        with compilation_calls() as first:
            namespace, code, loader = self.load()
        self.assertEqual(len(first), 1)
        self.assertEqual(namespace['nested'](), 'A')
        self.assertIs(type(loader), importlib.machinery.SourceFileLoader)
        self.assertEqual(vars(loader), {'name': loader.name, 'path': str(self.source)})
        self.assertEqual(code.co_filename, str(self.source))
        with compilation_calls() as second:
            namespace, _, loader = self.load()
        self.assertEqual(second, [])
        self.assertEqual(namespace['nested'].__code__.co_filename, str(self.source))
        self.assertEqual(vars(loader), {'name': loader.name, 'path': str(self.source)})
        self.assertFalse(Path(importlib.util.cache_from_source(str(self.source))).exists())

    def test_equal_size_restored_mtime_edit_recompiles_current_source(self):
        self.load()
        stamp = self.source.stat()
        self.source.write_text(self.source.read_text().replace("'A'", "'B'"))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with compilation_calls() as calls:
            namespace, _, _ = self.load()
        self.assertEqual(namespace['nested'](), 'B')
        self.assertEqual(len(calls), 1)
        with compilation_calls() as calls:
            self.assertEqual(self.load()[0]['value'], 'B')
        self.assertEqual(calls, [])

    def test_deleted_source_is_not_revived_from_managed_code(self):
        self.load()
        self.source.unlink()
        loader = self.loader()
        with self.assertRaises(FileNotFoundError):
            loader.get_code(loader.name)
        self.assertEqual(vars(loader), {'name': loader.name, 'path': str(self.source)})

    def test_existing_timestamp_bytecode_keeps_original_precedence(self):
        bytecode = Path(py_compile.compile(str(self.source), doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP))
        encoded, stamp = bytecode.read_bytes(), self.source.stat()
        self.source.write_text(self.source.read_text().replace("'A'", "'B'"))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(self.load()[0]['value'], 'A')
        self.assertEqual(bytecode.read_bytes(), encoded)
        self.assertFalse(self.cache.exists())

    def test_corrupt_managed_code_falls_back_and_repairs(self):
        self.load()
        path = dependency_code._cache_path(str(self.source))
        good = path.read_bytes()
        bad_marshal = good[:16] + b'!'
        cases = [b'', good[:-1], b'BAD!' + good[4:],
            good[:4] + b'\x01\0\0\0' + good[8:], bad_marshal + hashlib.sha256(bad_marshal).digest()]
        for encoded in cases:
            with self.subTest(bytes=len(encoded)):
                path.write_bytes(encoded)
                with compilation_calls() as calls:
                    self.assertEqual(self.load()[0]['value'], 'A')
                self.assertEqual(len(calls), 1)
                self.assertEqual(path.read_bytes(), good)

    def test_custom_get_code_hook_preserves_same_error_object(self):
        sentinel = RuntimeError('custom get_code')
        def custom(loader, fullname):
            raise sentinel
        with mock.patch.object(importlib.machinery.SourceFileLoader, 'get_code', custom):
            loader = self.loader()
            with self.assertRaises(RuntimeError) as caught:
                loader.get_code(loader.name)
        self.assertIs(caught.exception, sentinel)
        self.assertEqual(vars(loader), {'name': loader.name, 'path': str(self.source)})

    def test_custom_get_data_hook_preserves_same_error_object(self):
        sentinel = RuntimeError('custom get_data')
        def custom(loader, path):
            raise sentinel
        with mock.patch.object(importlib.machinery.SourceFileLoader, 'get_data', custom):
            loader = self.loader()
            with self.assertRaises(RuntimeError) as caught:
                loader.get_code(loader.name)
        self.assertIs(caught.exception, sentinel)

    def test_custom_compile_hook_is_not_persisted_or_bypassed(self):
        self.load()
        sentinel = RuntimeError('custom compiler')
        with mock.patch.object(builtins, 'compile', side_effect=sentinel):
            loader = self.loader()
            with self.assertRaises(RuntimeError) as caught:
                loader.get_code(loader.name)
        self.assertIs(caught.exception, sentinel)

    def test_loader_subclass_and_instance_hooks_are_untouched(self):
        class Custom(importlib.machinery.SourceFileLoader):
            pass
        for loader in (Custom('djls_dependency_control', str(self.source)),
                importlib.machinery.SourceFileLoader('djls_dependency_control', str(self.source))):
            if type(loader) is importlib.machinery.SourceFileLoader:
                loader.marker = object()
            before = dict(vars(loader))
            dependency_code.cache_dependency_code(loader, loader.name)
            self.assertEqual(vars(loader), before)

    def test_existing_python_cache_policies_are_honored(self):
        cases = [(sys, 'dont_write_bytecode', False), (sys, 'pycache_prefix', str(self.root / 'standard')),
            (_imp, 'check_hash_based_pycs', 'never')]
        for owner, name, value in cases:
            with self.subTest(name=name), mock.patch.object(owner, name, value):
                loader = self.loader()
                self.assertEqual(vars(loader), {'name': loader.name, 'path': str(self.source)})
                self.assertEqual(self.load()[0]['value'], 'A')
        self.assertFalse(self.cache.exists())

    def test_optional_cache_write_failure_preserves_source_execution(self):
        with mock.patch.object(dependency_code.tempfile, 'NamedTemporaryFile', side_effect=PermissionError('cache')):
            self.assertEqual(self.load()[0]['value'], 'A')
        self.assertFalse(list(self.cache.rglob('*.pyc')))

    def test_cached_code_still_opens_original_source_through_open_code(self):
        self.load()
        original = _io.open_code
        with mock.patch.object(_io, 'open_code', wraps=original) as opened, compilation_calls() as calls:
            self.assertEqual(self.load()[0]['value'], 'A')
        self.assertEqual(calls, [])
        paths = [str(call.args[0]) for call in opened.call_args_list]
        self.assertIn(str(self.source), paths)
        self.assertIn(str(dependency_code._cache_path(str(self.source))), paths)

    def test_concurrent_loaders_publish_complete_atomic_code(self):
        barrier = threading.Barrier(4)
        values, errors = [], []
        def work():
            try:
                barrier.wait(timeout=5)
                values.append(self.load()[0]['value'])
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=work) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(values, ['A'] * 4)
        self.assertFalse(list(self.cache.rglob('.code-*')))
        with compilation_calls() as calls:
            self.assertEqual(self.load()[0]['value'], 'A')
        self.assertEqual(calls, [])

    def test_fresh_process_reuses_only_checked_code_with_default_gc(self):
        script = '''import builtins,gc,importlib.machinery,json,sys
from django_orm_intellisense.runtime.dependency_code import cache_dependency_code
loader=importlib.machinery.SourceFileLoader('djls_dependency_control',sys.argv[1])
cache_dependency_code(loader,loader.name)
calls=[]
def observe(frame,event,arg):
    if event=='c_call' and arg is builtins.compile:calls.append(1)
sys.setprofile(observe)
try:code=loader.get_code(loader.name)
finally:sys.setprofile(None)
namespace={};exec(code,namespace)
print(json.dumps(dict(value=namespace['value'],compiles=len(calls),gc=gc.isenabled(),threshold=gc.get_threshold(),standard=type(loader)is importlib.machinery.SourceFileLoader,attrs=sorted(vars(loader)),filename=code.co_filename)))'''
        environment = {**os.environ, 'PYTHONPATH': str(Path(dependency_code.__file__).resolve().parents[2])}
        rows = []
        for _ in range(2):
            child = subprocess.run([sys.executable, '-B', '-c', script, str(self.source)],
                env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            self.assertEqual(child.returncode, 0, child.stderr)
            rows.append(json.loads(child.stdout))
        self.assertEqual([row['compiles'] for row in rows], [1, 0])
        for row in rows:
            self.assertEqual(row['value'], 'A')
            self.assertTrue(row['gc'] and row['standard'])
            self.assertEqual(row['threshold'], [700, 10, 10])
            self.assertEqual(row['attrs'], ['name', 'path'])
            self.assertEqual(row['filename'], str(self.source))
