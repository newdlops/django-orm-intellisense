"""Actual daemon with symmetric current/previous helper source controls."""
import __future__
import ast
import os
from pathlib import Path

from benchmarks.builtin_surface_construct_candidate import previous_source
from django_orm_intellisense.features import orm_members


current, previous = Path(orm_members.__file__).read_text(), previous_source()
legacy = os.environ.get('DJLS_BENCH_BUILTIN_LEGACY_CONSTRUCT') == '1'
source = previous if legacy else current
helpers = [ast.get_source_segment(source, node) for node in ast.parse(source).body
           if isinstance(node, ast.FunctionDef)
           and node.name in ('_builtin_method_items', '_builtin_instance_method_items')]
assert len(helpers) == 2
exec(compile('\n\n'.join(helpers), str(orm_members.__file__) + ':builtin_helper_control',
             'exec', flags=__future__.annotations.compiler_flag), orm_members.__dict__)
if legacy:
    orm_members._compact_member_surface = orm_members._member_surface

from django_orm_intellisense.__main__ import main

if __name__ == '__main__':
    main()
