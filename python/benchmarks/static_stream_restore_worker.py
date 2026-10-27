"""Actual daemon with an optional source-locked previous static read control."""
import os

from benchmarks.static_stream_restore_candidate import previous_reader
from django_orm_intellisense.cache import store
from django_orm_intellisense.__main__ import main


if os.environ.get('DJLS_BENCH_STATIC_LEGACY_RESTORE') == '1':
    store._read_cache_payload = previous_reader

if __name__ == '__main__':
    main()
