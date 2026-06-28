"""P1.3 — per-project DJANGO_SETTINGS_MODULE inference from manage.py.

In a monorepo / base-dev-prod layout, simple candidate-counting yields no
default (>1 candidate). The project's own manage.py declares the authoritative
default via `os.environ.setdefault('DJANGO_SETTINGS_MODULE', ...)`; discovery
must honor it.

Run:
    PYTHONPATH=python .e2e-django5/bin/python3 -m unittest tests.test_discovery_settings_inference -v
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from django_orm_intellisense.discovery.workspace import discover_workspace

_MANAGE_PY = (
    "#!/usr/bin/env python\n"
    "import os\n"
    "import sys\n"
    "def main():\n"
    "    os.environ.setdefault('DJANGO_SETTINGS_MODULE', {default!r})\n"
    "    from django.core.management import execute_from_command_line\n"
    "    execute_from_command_line(sys.argv)\n"
    "if __name__ == '__main__':\n"
    "    main()\n"
)


def _make_project(root: Path, default: str, settings_files: list[str]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / 'manage.py').write_text(_MANAGE_PY.format(default=default), encoding='utf-8')
    for rel in settings_files:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('SECRET_KEY = "x"\n', encoding='utf-8')
        # Make settings/ a package.
        init = path.parent / '__init__.py'
        if path.parent.name == 'settings' and not init.exists():
            init.write_text('', encoding='utf-8')


class ManagePyInferenceTest(unittest.TestCase):
    def test_setdefault_wins_over_multiple_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_project(
                root,
                default='proj.settings.dev',
                settings_files=[
                    'proj/settings/base.py',
                    'proj/settings/dev.py',
                    'proj/settings/prod.py',
                ],
            )
            profile = discover_workspace(root)
            # Multiple candidates exist, so candidate-counting alone gives None.
            self.assertGreater(len(profile.settings_candidates), 1)
            # manage.py's declared default is honored.
            self.assertEqual(profile.settings_module, 'proj.settings.dev')

    def test_declared_default_added_to_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Declared default lives in a non-standard place discovery misses.
            _make_project(root, default='config.production', settings_files=[])
            profile = discover_workspace(root)
            self.assertEqual(profile.settings_module, 'config.production')
            self.assertIn('config.production', profile.settings_candidates)

    def test_explicit_override_beats_manage_py(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_project(root, default='proj.settings.dev', settings_files=['proj/settings.py'])
            profile = discover_workspace(root, settings_override='proj.settings.prod')
            self.assertEqual(profile.settings_module, 'proj.settings.prod')

    def test_single_candidate_still_inferred_without_manage_py_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # manage.py with NO setdefault, single settings candidate.
            (root / 'manage.py').write_text('import sys\n', encoding='utf-8')
            (root / 'proj').mkdir()
            (root / 'proj' / 'settings.py').write_text('SECRET_KEY="x"\n', encoding='utf-8')
            profile = discover_workspace(root)
            self.assertEqual(profile.settings_module, 'proj.settings')


class MonorepoNestedManagePyTest(unittest.TestCase):
    """A monorepo root has no manage.py; each service lives in a subdirectory
    with its own manage.py + settings. Candidate discovery must still run so the
    settings modules surface (for the picker / single-candidate inference)."""

    def test_nested_service_surfaces_settings_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # No root manage.py — only a nested service has one.
            _make_project(
                root / 'services' / 'payroll',
                default='core.settings',
                settings_files=['core/settings.py'],
            )
            profile = discover_workspace(root)
            self.assertIsNone(profile.manage_py_path)
            # The nested settings module is surfaced (root-relative) instead of
            # being silently dropped.
            self.assertIn(
                'services.payroll.core.settings', profile.settings_candidates
            )
            # Exactly one candidate => inferred automatically.
            self.assertEqual(
                profile.settings_module, 'services.payroll.core.settings'
            )

    def test_multiple_nested_services_offer_all_without_auto_pick(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_project(
                root / 'services' / 'payroll',
                default='core.settings',
                settings_files=['core/settings.py'],
            )
            _make_project(
                root / 'services' / 'billing',
                default='core.settings',
                settings_files=['core/settings.py'],
            )
            profile = discover_workspace(root)
            self.assertIn(
                'services.payroll.core.settings', profile.settings_candidates
            )
            self.assertIn(
                'services.billing.core.settings', profile.settings_candidates
            )
            # Ambiguous => no auto-pick; the user selects via the picker.
            self.assertIsNone(profile.settings_module)

    def test_plain_directory_without_django_stays_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'pkg').mkdir()
            (root / 'pkg' / 'utils.py').write_text('x = 1\n', encoding='utf-8')
            profile = discover_workspace(root)
            self.assertEqual(profile.settings_candidates, [])
            self.assertIsNone(profile.settings_module)


if __name__ == '__main__':
    unittest.main()
