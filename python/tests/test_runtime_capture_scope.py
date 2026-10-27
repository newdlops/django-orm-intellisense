"""Failed runtime capture scopes must release ownership before the next build."""
import contextlib
import json
import sys
import tempfile
import unittest
from contextvars import ContextVar
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members


_CACHES = ('_runtime_source_paths', '_static_manager_bindings',
    '_runtime_callable_candidates', '_runtime_model_catalogs')
_SCOPES = (*_CACHES, '_runtime_capture_labels')


class _FailedContextOperation:
    def __init__(self, variable, *, set_error=None, reset_error=None, events=None):
        self.variable = variable
        self.set_error, self.reset_error, self.events = set_error, reset_error, events

    def get(self):
        return self.variable.get()

    def set(self, value):
        if self.set_error is not None:
            error, self.set_error = self.set_error, None
            raise error
        return self.variable.set(value)

    def reset(self, token):
        self.variable.reset(token)
        if self.events is not None:
            self.events.append(self.variable.name)
        if self.reset_error is not None:
            raise self.reset_error


class RuntimeCaptureScopeTests(unittest.TestCase):
    def setUp(self):
        # Isolate injected failures from unrelated test/controller contexts.
        self.variables = {name: ContextVar('owned-test-' + name, default=None) for name in _SCOPES}
        patches = mock.patch.multiple(orm_members, **self.variables)
        patches.start()
        self.addCleanup(patches.stop)
        self.tokens = [(variable, variable.set(None)) for variable in self.variables.values()]
        self.addCleanup(self.restore_contexts)

    def restore_contexts(self):
        for variable, token in reversed(self.tokens):
            variable.reset(token)

    @contextlib.contextmanager
    def empty_scope(self):
        tokens = [(variable, variable.set(None)) for variable in self.variables.values()]
        try:
            yield
        finally:
            for variable, token in reversed(tokens):
                variable.reset(token)

    def assert_empty(self):
        self.assertEqual({name: variable.get() for name, variable in self.variables.items()},
            dict.fromkeys(_SCOPES))

    def test_each_setup_failure_restores_the_callers_complete_context(self):
        @orm_members._with_runtime_source_paths
        def build():
            self.fail('Failed context activation ran the capture body')

        for name in _SCOPES:
            with self.subTest(operation=name), self.empty_scope():
                failure = MemoryError('owned allocation failure at ' + name)
                proxy = _FailedContextOperation(self.variables[name], set_error=failure)
                with mock.patch.object(orm_members, name, proxy), self.assertRaises(MemoryError) as raised:
                    build()
                self.assertIs(raised.exception, failure)
                self.assert_empty()

    def test_source_retarget_is_current_after_recovering_from_partial_setup_failure(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-capture-scope-retarget-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        source = 'class Owner:\n    def value(self) -> int:\n        return 1\n'
        first, second, alias = root / 'first.py', root / 'second.py', root / 'alias.py'
        first.write_text(source)
        second.write_text(source)
        alias.symlink_to(first)
        namespace = {}
        exec(compile(source, str(alias), 'exec', dont_inherit=True), namespace)
        files = frozenset((str(first), str(second)))

        @orm_members._with_runtime_source_paths
        def build():
            return orm_members._runtime_callable_member_items(owner_classes=[namespace['Owner']],
                workspace_files=files, receiver_kind='instance', model_label='blog.Post',
                manager_name=None, default_return_kind='unknown')

        failure = MemoryError('owned manager-scope allocation failure')
        proxy = _FailedContextOperation(self.variables['_static_manager_bindings'], set_error=failure)
        with mock.patch.object(orm_members, '_static_manager_bindings', proxy), self.assertRaises(MemoryError):
            build()
        before = build()
        alias.unlink()
        alias.symlink_to(second)
        after = build()
        print(json.dumps({'event': 'owned_capture_scope_retarget',
            'beforePaths': [item.file_path for item in before],
            'afterPaths': [item.file_path for item in after], 'expectedAfter': str(second)}), file=sys.stderr)
        self.assertEqual([item.file_path for item in before], [str(first)])
        self.assertEqual([item.file_path for item in after], [str(second)])
        self.assert_empty()

    def test_each_reset_error_still_releases_the_other_owned_scopes(self):
        @orm_members._with_runtime_source_paths
        def build():
            return 'complete'

        for name in _SCOPES:
            with self.subTest(operation=name), self.empty_scope():
                failure = MemoryError('owned cleanup failure at ' + name)
                proxy = _FailedContextOperation(self.variables[name], reset_error=failure)
                with mock.patch.object(orm_members, name, proxy), self.assertRaises(MemoryError) as raised:
                    build()
                self.assertIs(raised.exception, failure)
                self.assert_empty()

    def test_body_and_all_cleanup_failures_preserve_every_error_and_release_scopes(self):
        body_error = ValueError('owned failed capture')
        errors = {name: MemoryError('owned reset failed ' + name) for name in _SCOPES}
        events = []

        @orm_members._with_runtime_source_paths
        def build():
            raise body_error

        proxies = {name: _FailedContextOperation(variable, reset_error=errors[name], events=events)
            for name, variable in self.variables.items()}
        with mock.patch.multiple(orm_members, **proxies), self.assertRaises(MemoryError) as raised:
            build()
        chain, error = [], raised.exception
        while error is not None and all(error is not item for item in chain):
            chain.append(error)
            error = error.__context__
        print(json.dumps({'event': 'owned_capture_scope_cleanup', 'resetAttempts': events,
            'exceptionChain': [str(error) for error in chain]}), file=sys.stderr)
        self.assertEqual(set(events), {variable.name for variable in self.variables.values()})
        self.assertEqual({id(error) for error in chain}, {id(body_error), *(id(e) for e in errors.values())})
        self.assert_empty()

    def test_nested_scope_keeps_callers_cache_ownership_and_restores_label_scope(self):
        sentinels = {name: {} for name in _SCOPES}
        for name, variable in self.variables.items():
            variable.set(sentinels[name])

        @orm_members._with_runtime_source_paths
        def build():
            for name in _CACHES:
                self.assertIs(self.variables[name].get(), sentinels[name])
            raise ValueError('owned nested build failure')

        with self.assertRaisesRegex(ValueError, 'nested build'):
            build()
        for name, variable in self.variables.items():
            self.assertIs(variable.get(), sentinels[name])


if __name__ == '__main__':
    unittest.main()
