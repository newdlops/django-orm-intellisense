"""Cross-language parity for the field-type tables (P2).

FIELD_KIND_PYTHON_TYPE and FIELD_TRANSFORMS are hand-maintained in three
places (Python / Rust / TypeScript) so each language's fast path can infer
terminal types without the others. This test parses the Rust and TS copies and
asserts they are identical to the Python source of truth, so drift is caught in
CI rather than producing inconsistent hover/diagnostics across resolvers.

Run:
    PYTHONPATH=python .e2e-django5/bin/python3 -m unittest tests.test_field_type_table_parity -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from django_orm_intellisense.features.field_types import (
    FIELD_KIND_PYTHON_TYPE,
    FIELD_TRANSFORMS,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_FIELD_LOOKUPS = _REPO_ROOT / 'src' / 'server' / 'fieldLookups.ts'
_RUST_TYPES = _REPO_ROOT / 'crates' / 'core' / 'src' / 'static_index' / 'types.rs'
_RUST_LOOKUP_PATHS = _REPO_ROOT / 'crates' / 'core' / 'src' / 'features' / 'lookup_paths.rs'


def _block(text: str, start_marker: str, end_marker: str) -> str:
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    return text[start:end]


def _parse_ts_python_type_map(text: str) -> dict[str, str]:
    block = _block(text, 'export const FIELD_KIND_PYTHON_TYPE', '};')
    # `CharField: 'str',`  (unquoted key, single-quoted value that may contain
    # spaces / dots / pipes)
    pairs = re.findall(r"^\s*([A-Za-z_]\w*)\s*:\s*'([^']*)'", block, re.MULTILINE)
    return {k: v for k, v in pairs}


def _parse_rust_python_type_map(text: str) -> dict[str, str]:
    block = _block(text, 'pub const FIELD_KIND_PYTHON_TYPE', '];')
    pairs = re.findall(r'\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)', block)
    return {k: v for k, v in pairs}


def _parse_ts_transforms(text: str) -> dict[str, dict]:
    block = _block(text, 'export const FIELD_TRANSFORMS', '};')
    result: dict[str, dict] = {}
    # `'year': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['A', 'B'] },`
    for m in re.finditer(
        r"'([^']+)'\s*:\s*\{\s*outputFieldKind:\s*'([^']+)'\s*,\s*applicableFieldKinds:\s*\[([^\]]*)\]",
        block,
    ):
        name, output, applicable = m.group(1), m.group(2), m.group(3)
        kinds = re.findall(r"'([^']+)'", applicable)
        result[name] = {'outputFieldKind': output, 'applicableFieldKinds': kinds}
    return result


def _parse_rust_transforms(text: str) -> dict[str, dict]:
    block = _block(text, 'pub const FIELD_TRANSFORMS', '];')
    result: dict[str, dict] = {}
    # `("year", "IntegerField", &["DateField", "DateTimeField"]),`
    for m in re.finditer(
        r'\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*&\[([^\]]*)\]\s*\)',
        block,
    ):
        name, output, applicable = m.group(1), m.group(2), m.group(3)
        kinds = re.findall(r'"([^"]+)"', applicable)
        result[name] = {'outputFieldKind': output, 'applicableFieldKinds': kinds}
    return result


class FieldKindPythonTypeParityTest(unittest.TestCase):
    def test_ts_matches_python(self) -> None:
        ts = _parse_ts_python_type_map(_TS_FIELD_LOOKUPS.read_text(encoding='utf-8'))
        self.assertGreater(len(ts), 20, 'TS table parse looks empty/broken')
        self.assertEqual(ts, dict(FIELD_KIND_PYTHON_TYPE))

    def test_rust_matches_python(self) -> None:
        rust = _parse_rust_python_type_map(_RUST_TYPES.read_text(encoding='utf-8'))
        self.assertGreater(len(rust), 20, 'Rust table parse looks empty/broken')
        self.assertEqual(rust, dict(FIELD_KIND_PYTHON_TYPE))


class FieldTransformParityTest(unittest.TestCase):
    def _normalize(self, table: dict) -> dict:
        # Compare outputFieldKind exactly; applicableFieldKinds as a set so
        # authoring order is not significant.
        return {
            name: (entry['outputFieldKind'], frozenset(entry['applicableFieldKinds']))
            for name, entry in table.items()
        }

    def test_ts_transforms_match_python(self) -> None:
        ts = _parse_ts_transforms(_TS_FIELD_LOOKUPS.read_text(encoding='utf-8'))
        self.assertGreater(len(ts), 10, 'TS transforms parse looks empty/broken')
        self.assertEqual(self._normalize(ts), self._normalize(FIELD_TRANSFORMS))

    def test_rust_transforms_match_python(self) -> None:
        rust = _parse_rust_transforms(_RUST_LOOKUP_PATHS.read_text(encoding='utf-8'))
        self.assertGreater(len(rust), 10, 'Rust transforms parse looks empty/broken')
        self.assertEqual(self._normalize(rust), self._normalize(FIELD_TRANSFORMS))


if __name__ == '__main__':
    unittest.main()
