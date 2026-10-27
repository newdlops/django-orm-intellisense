"""Control daemon using the preceding late-hit catalogue implementation."""
import os
from benchmarks.bench_lookup_fast_hit import previous_module
from django_orm_intellisense.runtime import lookup_catalog
from django_orm_intellisense.__main__ import main

if os.environ.get('DJLS_BENCH_LOOKUP_FAST_HIT') == 'previous':
    lookup_catalog.collect_lookup_catalog = previous_module().collect_lookup_catalog

if __name__ == '__main__':
    main()
