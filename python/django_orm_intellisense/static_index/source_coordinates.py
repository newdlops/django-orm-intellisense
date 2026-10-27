"""Attach protocol columns without changing Python's AST byte offsets."""
import ast
from bisect import bisect_right

SOURCE_COORDINATES_VERSION = 'utf16-1based-v1'


def prepare_source_columns(tree: ast.Module, text: str | None) -> None:
    if text is None or getattr(tree, '_orm_utf16_columns_prepared', False):
        return
    tree._orm_utf16_columns_prepared = True
    if text.isascii():
        return
    # Python's parser counts CR/CRLF as newlines, but not Unicode separators
    # embedded inside string literals. Keep its line convention exactly.
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    corrections = {}
    for number, line in enumerate(lines, 1):
        if line.isascii():
            continue
        ends, shifts = [], []
        byte_offset = shift = 0
        for character in line:
            value = ord(character)
            byte_size = 1 if value < 128 else 2 if value < 0x800 else 3 if value <= 0xffff else 4
            byte_offset += byte_size
            if value >= 128:
                shift += byte_size - (2 if value > 0xffff else 1)
                ends.append(byte_offset)
                shifts.append(shift)
        corrections[number] = ends, shifts
    for node in ast.walk(tree):
        correction = corrections.get(getattr(node, 'lineno', None))
        offset = getattr(node, 'col_offset', None)
        if correction is None or offset is None:
            continue
        index = bisect_right(correction[0], offset)
        if index:
            node._orm_utf16_column = offset + 1 - correction[1][index - 1]
    # Only integer annotations survive. Source lines and correction maps have
    # parse-local ownership; no source text or extra AST cache is retained.


def source_column(node: ast.AST) -> int:
    return getattr(node, '_orm_utf16_column', node.col_offset + 1)
