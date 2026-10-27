"""Bound source caches by current owners rather than historical revisions."""
from collections import OrderedDict, namedtuple
from functools import wraps
from threading import RLock

_CacheInfo = namedtuple('CacheInfo', 'hits misses maxsize currsize')


def latest_source_cache(*, maxsize, stamp_index):
    def decorate(function):
        cache = OrderedDict()
        pending = {}
        lock = RLock()
        hits = misses = 0

        @wraps(function)
        def cached(*args, **kwargs):
            nonlocal hits, misses
            if kwargs:
                from inspect import signature
                args = signature(function).bind(*args, **kwargs).args
            key = args[:stamp_index] + args[stamp_index + 1:]
            stamp = args[stamp_index]
            with lock:
                entry = cache.get(key)
                if entry is not None and entry[0] == stamp:
                    hits += 1
                    cache.move_to_end(key)
                    return entry[1]
                misses += 1
                cache.pop(key, None)
                token = object()
                pending[key] = token
            try:
                value = function(*args)
            except BaseException:
                with lock:
                    if pending.get(key) is token:
                        pending.pop(key)
                raise
            with lock:
                # A later request or explicit clear owns this key now.
                # Return the caller's snapshot without adopting stale work.
                if pending.get(key) is token:
                    pending.pop(key)
                    cache[key] = (stamp, value)
                    if len(cache) > maxsize:
                        cache.popitem(last=False)
            return value

        def cache_clear():
            nonlocal hits, misses
            with lock:
                cache.clear()
                pending.clear()
                hits = misses = 0

        def cache_info():
            with lock:
                return _CacheInfo(hits, misses, maxsize, len(cache))

        def cache_discard(*key):
            with lock:
                cache.pop(key, None)
                pending.pop(key, None)

        cached.cache_clear = cache_clear
        cached.cache_info = cache_info
        cached.cache_discard = cache_discard
        return cached
    return decorate
