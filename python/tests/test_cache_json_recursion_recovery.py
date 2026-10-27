import contextlib
import dataclasses
import gc
import json
import sys
import tempfile
import unittest
import weakref
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


class CacheJsonRecursionRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-cache-recursion-test-')
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name).resolve()
        self.root,self.cache = folder/'project',folder/'cache'
        self.root.mkdir()
        (self.root/'models.py').write_text('from django.db import models\nclass Post(models.Model):\n'
            '    key=models.UUIDField(primary_key=True)\n    title=models.CharField()\n'
            '    parent=models.ForeignKey("self",on_delete=models.CASCADE,related_name="children")\n')
        (self.root/'helper.py').write_text('from models import Post\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root,python_files=self.snapshot.files)
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(mock.patch.object(store,'_workspace_cache_dir',return_value=self.cache))
        patches.enter_context(mock.patch.multiple(store,_STATIC_MODULE_STREAM_MIN_BYTES=0,_GRAPH_FIELDS_STREAM_MIN_BYTES=0))
        store.save_static_index(self.root,self.snapshot,self.index)
        # Python 3.12's C decoder can exceed sys.getrecursionlimit(). Use a
        # bounded fixture that actually exceeds both supported decoders.
        self.deep = '{"metadata":{},"payload":{"future":'+'['*10000+'0'+']'*10000+'}}'
        with self.assertRaises(RecursionError):
            json.loads(self.deep)

    def recovered(self,call):
        try:
            return call()
        except (RecursionError,ValueError):
            self.fail('Rejected JSON escaped the invalid-cache recovery path.')

    def assert_static_equal(self,value):
        self.assertEqual(value.to_cache_dict(),self.index.to_cache_dict())
        self.assertEqual(value.fields,self.index.fields)
        for name in ('_fields_by_model_label','_fields_by_model_and_name','_relation_sources_by_target'):
            self.assertEqual(getattr(value,name),getattr(self.index,name))

    def test_overdeep_json_is_removed_as_a_miss_in_every_decoder_branch(self):
        for name,options in (('ordinary.json',{}),(store.MODEL_GRAPH_CACHE_NAME,{}),
                ('static-stream.json',{'restore_static_modules':True}),
                ('graph-stream.json',{'restore_graph_fields':True}),
                ('surface-stream.json',{'compact_surface_models':True})):
            with self.subTest(name=name):
                path = self.cache/name
                path.write_text(self.deep)
                self.assertIsNone(self.recovered(lambda:store._read_cache_payload(path,**options)))
                self.assertFalse(path.exists())

    def test_public_loaders_accept_a_valid_replacement_after_the_miss(self):
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            django_importable=True,django_version='test',bootstrap_status='ready')
        graph = build_model_graph(self.index,runtime)
        surface = {'sample.Post':{'instance':{'pk':('field',None,None,'UUIDField')},
            'model_class':{},'manager':{},'queryset':{}}}
        cases = (
            (store.SOURCE_SNAPSHOT_CACHE_NAME,lambda:store.load_cached_source_snapshot(self.root),
                lambda:store.save_source_snapshot(self.root,self.snapshot),lambda value:value.to_cache_dict(),self.snapshot.to_cache_dict()),
            (store.RUNTIME_CACHE_NAME,lambda:store.load_cached_runtime_inspection(self.root,'source',None),
                lambda:store.save_runtime_inspection(self.root,'source',None,runtime),lambda value:value.to_dict(),runtime.to_dict()),
            (store.MODEL_GRAPH_CACHE_NAME,lambda:store.load_cached_model_graph(self.root,
                source_fingerprint='source',runtime_fingerprint='runtime',static_index=self.index,runtime_inspection=runtime),
                lambda:store.save_model_graph(self.root,'source','runtime',graph),store._model_graph_to_cache_dict,store._model_graph_to_cache_dict(graph)),
            (store.SURFACE_INDEX_CACHE_NAME,lambda:store.load_cached_surface_index(self.root,'source','runtime'),
                lambda:store.save_surface_index(self.root,'source','runtime',surface),lambda value:value,surface),
        )
        for name,load,save,serialize,expected in cases:
            with self.subTest(name=name):
                path = self.cache/name
                path.write_text(self.deep)
                self.assertIsNone(self.recovered(load))
                self.assertFalse(path.exists())
                save()
                restored = load()
                self.assertIsNotNone(restored)
                self.assertEqual(serialize(restored),expected)

    def test_integer_conversion_limit_is_recovered_in_every_decoder_branch(self):
        get_limit = getattr(sys,'get_int_max_str_digits',None)
        limit = get_limit() if get_limit is not None else 0
        if not limit:
            self.skipTest('Integer conversion limits are unavailable or disabled in this interpreter.')
        for sign in ('','-'):
            raw = '{"metadata":{},"payload":{"future":'+sign+'9'*(limit+64)+'}}'
            with self.assertRaises(ValueError):
                json.loads(raw)
            for name,options in (('ordinary.json',{}),(store.MODEL_GRAPH_CACHE_NAME,{}),
                    ('static-stream.json',{'restore_static_modules':True}),
                    ('graph-stream.json',{'restore_graph_fields':True}),
                    ('surface-stream.json',{'compact_surface_models':True})):
                with self.subTest(sign=sign,name=name):
                    path = self.cache/name
                    path.write_text(raw)
                    self.assertIsNone(self.recovered(lambda:store._read_cache_payload(path,**options)))
                    self.assertFalse(path.exists())

    def test_full_static_cache_falls_back_to_complete_partial_metadata(self):
        path = self.cache/store.STATIC_INDEX_FULL_CACHE_NAME
        path.write_text(self.deep)
        restored,hit = self.recovered(lambda:store.load_cached_static_index(self.root,self.snapshot))
        self.assertEqual(hit,'partial')
        self.assert_static_equal(restored)
        self.assertFalse(path.exists())
        self.assertTrue((self.cache/store.STATIC_INDEX_CACHE_NAME).exists())
        self.assertEqual(snapshot_python_sources(self.root).fingerprint,self.snapshot.fingerprint)

    def test_deep_full_and_partial_caches_can_be_rebuilt_and_reloaded(self):
        for name in (store.STATIC_INDEX_FULL_CACHE_NAME,store.STATIC_INDEX_CACHE_NAME):
            (self.cache/name).write_text(self.deep)
        self.assertEqual(self.recovered(lambda:store.load_cached_static_index(self.root,self.snapshot)),(None,'miss'))
        rebuilt = build_static_index(self.root,python_files=self.snapshot.files)
        store.save_static_index(self.root,self.snapshot,rebuilt)
        restored,hit = store.load_cached_static_index(self.root,self.snapshot)
        self.assertEqual(hit,'full')
        self.assert_static_equal(restored)

    def test_failed_streams_release_their_owners_with_cyclic_gc_disabled(self):
        original_open = Path.open
        references = []
        def opened(path,*args,**kwargs):
            stream = original_open(path,*args,**kwargs)
            references.append(weakref.ref(stream))
            return stream
        for options in ({'restore_static_modules':True},{'restore_graph_fields':True},{'compact_surface_models':True}):
            with self.subTest(options=options):
                path = self.cache/'stream.json'
                path.write_text(self.deep)
                enabled = gc.isenabled()
                gc.disable()
                try:
                    with mock.patch.object(Path,'open',new=opened):
                        self.assertIsNone(self.recovered(lambda:store._read_cache_payload(path,**options)))
                    self.assertTrue(all(reference() is None for reference in references))
                finally:
                    if enabled:
                        gc.enable()
