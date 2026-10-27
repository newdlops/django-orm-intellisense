"""Configured daemon with symmetric current/previous manager lookup controls."""
import __future__
import ast
import os
from pathlib import Path

from benchmarks.runtime_manager_map_candidate import previous_source
from django_orm_intellisense.features import orm_members


current = Path(orm_members.__file__).read_text()
source = previous_source() if os.environ.get('DJLS_BENCH_RUNTIME_MANAGER_LEGACY_MAP') == '1' else current
helpers = [ast.get_source_segment(source, node) for node in ast.parse(source).body
           if isinstance(node, ast.FunctionDef)
           and node.name in ('_with_runtime_source_paths', '_manager_names')]
assert len(helpers) == 2
exec(compile('\n\n'.join(helpers), str(orm_members.__file__) + ':runtime_manager_helper_control',
             'exec', flags=__future__.annotations.compiler_flag), orm_members.__dict__)
for name in ('build_surface_index', 'rebuild_surface_for_models', 'prebuild_member_surface_cache'):
    function = getattr(orm_members, name)
    setattr(orm_members, name, orm_members._with_runtime_source_paths(function.__wrapped__))

from django_orm_intellisense.__main__ import main

if __name__ == '__main__':
    main()
