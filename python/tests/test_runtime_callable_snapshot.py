"""A candidate cache must describe the namespace version it actually scanned."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members


class RuntimeCallableSnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-callable-snapshot-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = self.root / 'workspace.py'
        self.dependency = self.root / 'dependency.py'
        text = 'def value(self) -> int:\n    return 1\n'
        for path in (self.workspace, self.dependency):
            path.write_text(text)
        self.files = frozenset((str(self.workspace),))

    def function(self, path):
        namespace = {}
        exec(compile(path.read_text(), str(path), 'exec', dont_inherit=True), namespace)
        return namespace['value']

    def capture(self, owner):
        return orm_members._runtime_callable_member_items(owner_classes=[owner],
            workspace_files=self.files, receiver_kind='instance', model_label='blog.Post',
            manager_name=None, default_return_kind='unknown')

    def check_namespace_change(self, *, add_name):
        class Owner:
            pass

        Owner.value = self.function(self.dependency)
        current = self.function(self.workspace)
        original_resolve = Path.resolve
        changed = []

        def resolve(path, *args, **kwargs):
            result = original_resolve(path, *args, **kwargs)
            if path == self.dependency and not changed:
                # Model a class mutation while native source resolution yields.
                # Keep the real filesystem lookup and complete capture path.
                setattr(Owner, 'added' if add_name else 'value', current)
                changed.append(True)
            return result

        @orm_members._with_runtime_source_paths
        def build():
            with mock.patch.object(Path, 'resolve', resolve):
                first = self.capture(Owner)
            return first, self.capture(Owner)

        try:
            first, second = build()
        finally:
            self.assertIsNone(orm_members._runtime_source_paths.get())
            self.assertIsNone(orm_members._runtime_callable_candidates.get())
        self.assertEqual(changed, [True])
        self.assertEqual(first, [])
        # The first scan may see the old namespace; the next stable capture
        # must discover the current workspace method without leaving the build.
        expected = self.capture(Owner)
        self.assertEqual([(item.name, item.file_path) for item in expected],
            [('added' if add_name else 'value', str(self.workspace))])
        self.assertEqual(second, expected)

    def test_replaced_namespace_value_cannot_validate_candidates_from_the_old_value(self):
        self.check_namespace_change(add_name=False)

    def test_namespace_growth_during_source_resolution_does_not_break_the_scan(self):
        self.check_namespace_change(add_name=True)


if __name__ == '__main__':
    unittest.main()
