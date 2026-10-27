"""Optional checked CODE cache for ordinary dependency source loaders.

The original loader reads the source and validates the checked-hash header.
Workspace loaders and existing adjacent bytecode retain their normal paths.
"""
import _imp
import builtins
import hashlib
import importlib.machinery
import importlib.util
import _io as io
import marshal
import os
import sys
import tempfile
import types
import weakref
from functools import lru_cache
from pathlib import Path

_LOADER = importlib.machinery.SourceFileLoader
_METHODS = {name: getattr(_LOADER, name) for name in (
    'get_code', 'get_data', 'get_filename', 'path_stats', 'source_to_code', 'exec_module')}
_COMPILE = builtins.compile
_STANDARD = (isinstance(_COMPILE, types.BuiltinFunctionType)
    and _COMPILE.__module__ == 'builtins' and _COMPILE.__name__ == 'compile'
    and all(isinstance(method, types.FunctionType)
        and method.__module__ == '_frozen_importlib_external'
        and method.__code__.co_filename == '<frozen importlib._bootstrap_external>'
        for method in _METHODS.values()))


def _ordinary(loader):
    return (_STANDARD and type(loader) is _LOADER and set(vars(loader)) == {'name', 'path'}
        and builtins.compile is _COMPILE
        and all(getattr(_LOADER, name) is method for name, method in _METHODS.items())
        and sys.dont_write_bytecode and sys.pycache_prefix is None
        and _imp.check_hash_based_pycs != 'never')


@lru_cache(maxsize=4)
def _directory(override, executable, prefix, base_prefix, version, optimize, cache_tag):
    root = Path(override).expanduser() if override else Path(tempfile.gettempdir()) / 'django-orm-intellisense'
    identity = '\0'.join((executable, prefix, base_prefix, version, str(optimize), cache_tag or '', str(marshal.version)))
    namespace = hashlib.sha256(identity.encode('utf-8', 'surrogatepass') + importlib.util.MAGIC_NUMBER).hexdigest()
    return root / 'dependency-code-v1' / namespace


def _cache_path(source):
    directory = _directory(os.environ.get('DJANGO_ORM_INTELLISENSE_CACHE_DIR'), sys.executable,
        sys.prefix, sys.base_prefix, sys.version, sys.flags.optimize, sys.implementation.cache_tag)
    key = hashlib.sha256(os.fsencode(source)).hexdigest()
    return directory / key[:2] / (key + '.pyc')


def _read(path):
    try:
        with io.open_code(str(path)) as stream:
            chunks = []
            while block := stream.read(262144):
                chunks.append(block)
        data = b''.join(chunks)
    except OSError:
        return None
    if len(data) < 49:
        return None
    payload = memoryview(data)[:-32]
    if (payload[:4] != importlib.util.MAGIC_NUMBER or payload[4:8] != b'\x03\x00\x00\x00'
            or hashlib.sha256(payload).digest() != data[-32:]):
        return None
    try:
        valid = isinstance(marshal.loads(payload[16:]), types.CodeType)
    except (EOFError, ValueError, TypeError):
        return None
    return payload if valid else None


def _write(source, data, code):
    temporary = None
    try:
        path = _cache_path(source)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = (importlib.util.MAGIC_NUMBER + b'\x03\x00\x00\x00'
            + importlib.util.source_hash(data) + marshal.dumps(code))
        with tempfile.NamedTemporaryFile(prefix='.code-', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(payload); stream.write(hashlib.sha256(payload).digest())
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def cache_dependency_code(loader, fullname):
    """Add a one-use interceptor without changing the loader type or spec."""
    name = fullname.partition('.')[0]
    if (name in getattr(sys, 'stdlib_module_names', ())
            or name in {'django_orm_intellisense', 'benchmarks'} or not _ordinary(loader)
            or not isinstance(loader.path, str) or not os.path.isabs(loader.path)):
        return
    reference = weakref.ref(loader)

    def get_code(fullname):
        current = reference()
        if current is None:
            raise ImportError('Dependency loader is no longer available', name=fullname)
        if vars(current).get('get_code') is get_code:
            del current.get_code
        if not _ordinary(current):
            return current.get_code(fullname)
        source = current.path
        try:
            bytecode = importlib.util.cache_from_source(source)
        except NotImplementedError:
            return current.get_code(fullname)

        def get_data(path):
            # Resolve the class method at each call so a newly installed user
            # hook still runs. Only a real adjacent-file miss permits backup.
            original = getattr(_LOADER, 'get_data')
            try:
                return original(current, path)
            except FileNotFoundError:
                if path != bytecode or original is not _METHODS['get_data']:
                    raise
                try:
                    cached = _read(_cache_path(source))
                except OSError:
                    cached = None
                if cached is None:
                    raise
                return cached

        def source_to_code(data, path, *, _optimize=-1):
            original = getattr(_LOADER, 'source_to_code')
            standard_compile = builtins.compile is _COMPILE
            code = original(current, data, path, _optimize=_optimize)
            if (original is _METHODS['source_to_code'] and standard_compile
                    and builtins.compile is _COMPILE and isinstance(data, bytes)
                    and isinstance(code, types.CodeType) and path == source and _optimize == -1):
                _write(source, data, code)
            return code

        try:
            current.get_data = get_data
            current.source_to_code = source_to_code
            # SourceLoader performs its usual stat, header, complete source
            # hash validation, bytecode load and filename relocation once.
            return current.get_code(fullname)
        finally:
            if vars(current).get('get_data') is get_data:
                del current.get_data
            if vars(current).get('source_to_code') is source_to_code:
                del current.source_to_code

    loader.get_code = get_code
