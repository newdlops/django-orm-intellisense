"""Pass current compact state through an actual spawned worker process."""
import multiprocessing
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def roundtrip(snapshot, index, runtime, graph):
    assert not hasattr(index.fields[0], '__dict__')
    return snapshot.to_cache_dict(), index.to_cache_dict(), index.fields, store._model_graph_to_cache_dict(graph)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='djls-record-process-') as temporary:
        root = Path(temporary).resolve()
        app = root / 'blog'
        app.mkdir()
        (app / '__init__.py').write_text('')
        (app / 'models.py').write_text('from django.db import models\n'
            'class Author(models.Model):\n    name=models.CharField(max_length=20)\n'
            'class Post(models.Model):\n    author=models.ForeignKey("blog.Author", on_delete=models.CASCADE)\n')
        snapshot = snapshot_python_sources(root)
        index = build_static_index(root, snapshot.files)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn')) as pool:
            result = pool.submit(roundtrip, snapshot, index, runtime, graph).result(timeout=30)
        assert result == (snapshot.to_cache_dict(), index.to_cache_dict(), index.fields,
                          store._model_graph_to_cache_dict(graph))
    print('Actualspawned worker snapshot/index/runtime/graph pickle transport and complete values passed; production worker path unchanged.')
