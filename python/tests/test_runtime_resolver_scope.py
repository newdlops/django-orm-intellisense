"""Shared capture contexts must publish one coherent source-path cache."""
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members


class RuntimeResolverScopeTests(unittest.TestCase):
    def test_copied_contexts_keep_first_resolved_path_until_the_shared_build_finishes(self):
        with tempfile.TemporaryDirectory(prefix='djls-resolver-context-') as temporary:
            root = Path(temporary).resolve()
            text = 'class Owner:\n    def value(self) -> int:\n        return 1\n'
            first, second, alias = root / 'first.py', root / 'second.py', root / 'alias.py'
            first.write_text(text)
            second.write_text(text)
            alias.symlink_to(first)
            namespace = {}
            exec(compile(text, str(alias), 'exec', dont_inherit=True), namespace)
            files = frozenset((str(first), str(second)))
            constructor_barrier, first_finished = threading.Barrier(2), threading.Event()
            roles = threading.local()
            original = orm_members._RuntimeSourcePathResolver

            class InterleavedResolver(original):
                __slots__ = ()

                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    constructor_barrier.wait(timeout=5)
                    if roles.name == 'second':
                        if not first_finished.wait(5):
                            raise AssertionError('First source capture did not finish')

            def items():
                return orm_members._runtime_callable_member_items(owner_classes=[namespace['Owner']],
                    workspace_files=files, receiver_kind='instance', model_label='blog.Post',
                    manager_name=None, default_return_kind='unknown')

            def run(context, name):
                roles.name = name
                try:
                    return context.run(items)
                finally:
                    if name == 'first':
                        alias.unlink()
                        alias.symlink_to(second)
                        first_finished.set()

            @orm_members._with_runtime_source_paths
            def build():
                # Context copies intentionally share this build's cache dict.
                # Both constructors enter before either can publish/resolve.
                first_context, second_context = copy_context(), copy_context()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    a = pool.submit(run, first_context, 'first')
                    b = pool.submit(run, second_context, 'second')
                    return a.result(10), b.result(10)

            with mock.patch.object(orm_members, '_RuntimeSourcePathResolver', InterleavedResolver):
                a, b = build()
            self.assertEqual([item.file_path for item in a], [str(first)])
            self.assertEqual(a, b)
            self.assertIsNone(orm_members._runtime_source_paths.get())
            self.assertIsNone(orm_members._runtime_callable_candidates.get())
            # A subsequent build observes the current retargeted source.
            self.assertEqual([item.file_path for item in items()], [str(second)])


if __name__ == '__main__':
    unittest.main()
