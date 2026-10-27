"""Previous complete-string cache writer, retained only for paired evidence."""
import json

from django_orm_intellisense.cache import store
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default


def previous_write_cache_payload(cache_path, payload):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_suffix(cache_path.suffix + '.tmp')
    try:
        temporary_path.write_text(json.dumps(payload, sort_keys=True,
            default=lookup_catalog_json_default), encoding='utf-8')
        temporary_path.replace(cache_path)
    except OSError:
        store._unlink_quietly(temporary_path)
