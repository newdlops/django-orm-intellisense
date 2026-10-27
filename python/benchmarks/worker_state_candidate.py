"""Benchmark-only private-file state transfer for a one-shot surface worker."""
import contextlib
import pickle
import tempfile
from pathlib import Path

from django_orm_intellisense.server import app


@contextlib.contextmanager
def state_file(static_index, runtime, model_graph):
    with tempfile.TemporaryDirectory(prefix='djls-surface-worker-state-') as directory:
        path = Path(directory) / 'state.pickle'
        with path.open('wb') as stream:
            pickle.dump((static_index, runtime, model_graph), stream, protocol=pickle.HIGHEST_PROTOCOL)
        yield str(path)


def initialize_from_file(path):
    with Path(path).open('rb') as stream:
        static_index, runtime, model_graph = pickle.load(stream)
    app._init_bg_worker(static_index, runtime, model_graph)


def install():
    source = Path(app.__file__).read_text()
    old = '''                    with ProcessPoolExecutor(
                        max_workers=1,
                        initializer=_init_bg_worker,
                        initargs=(static_index, runtime, model_graph),
                    ) as pool:
                        future = pool.submit(_bg_prebuild_surface_index)
                        surface_index = future.result()'''
    assert source.count(old) == 1
    new = '''                    with state_file(static_index, runtime, model_graph) as state_path:
                        with ProcessPoolExecutor(
                            max_workers=1,
                            initializer=initialize_from_file,
                            initargs=(state_path,),
                        ) as pool:
                            future = pool.submit(_bg_prebuild_surface_index)
                            surface_index = future.result()'''
    # Compile only the changed method so the real module/class identities and
    # worker entry points remain exactly those of the production package.
    import ast
    tree = ast.parse(source.replace(old, new))
    method = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'DaemonServer')
    method = next(node for node in method.body if isinstance(node, ast.FunctionDef) and node.name == '_start_surface_index_prebuild')
    module = ast.Module(body=[method], type_ignores=[])
    namespace = dict(app.__dict__)
    namespace.update(state_file=state_file, initialize_from_file=initialize_from_file)
    exec(compile(module, str(app.__file__) + ':worker_state_candidate', 'exec'), namespace)
    app.DaemonServer._start_surface_index_prebuild = namespace['_start_surface_index_prebuild']
