"""Count transient bound builtin records during an actual complete prebuild."""
import json
import tempfile
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.builtin_surface_construct_candidate import candidate_module
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


rows = []
with tempfile.TemporaryDirectory(prefix='djls-builtin-construct-counts-') as temporary:
    root = Path(temporary).resolve()
    generate_synthetic_project(root, 500)
    static = build_static_index(root)
    runtime = create_pending_runtime_inspection(None)
    graph = build_model_graph(static, runtime)
    expected = None
    for name, owner in [('previous', candidate_module(previous=True)), ('current', orm_members)]:
        counts = {'allRecords': 0, 'boundBuiltinMethods': 0, 'sharedBuiltinTemplates': 0}
        original_init = owner.OrmMemberItem.__init__
        def counted(item, *args, **kwargs):
            original_init(item, *args, **kwargs)
            counts['allRecords'] += 1
            if item.source == 'builtin':
                if item.model_label and item.member_kind == 'method':
                    counts['boundBuiltinMethods'] += 1
                elif not item.model_label:
                    counts['sharedBuiltinTemplates'] += 1
        owner._builtin_member_template.cache_clear()
        owner._parse_class_nodes_cached.cache_clear()
        cache = owner._MemberSurfaceCache()
        with mock.patch.object(owner, '_surface_cache', cache), \
                mock.patch.object(owner.OrmMemberItem, '__init__', counted):
            surface = owner.prebuild_member_surface_cache(static, runtime, graph)
        if expected is None:
            expected = surface
        else:
            assert surface == expected
        rows.append({'mode': name, **counts, 'receiverSurfaces': len(cache._list_cache)})
print(json.dumps({'constructorRows': rows}), file=__import__('sys').stderr)
assert rows[0]['boundBuiltinMethods'] > 0 and rows[1]['boundBuiltinMethods'] == 0
assert rows[0]['allRecords'] - rows[1]['allRecords'] == rows[0]['boundBuiltinMethods']
assert rows[0]['sharedBuiltinTemplates'] == rows[1]['sharedBuiltinTemplates']
print(json.dumps({'productionApplied': True, 'models': 500, 'rows': rows,
    'completeSurfaceEqual': True, 'scope': 'Constructor counts during whole fresh receiver cache/surface '
    'prebuild, pending runtime, with counting wrapper only for this check. Not latency/RSS/editor proof.'}))
