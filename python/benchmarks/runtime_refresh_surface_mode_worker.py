"""Benchmark-only full-surface control; production uses selective refresh."""
import os
from django_orm_intellisense.server import app

if os.environ.get('DJLS_BENCH_FORCE_FULL_REFRESH') == '1':
    original = app.refresh_in_process
    def full_refresh(*args, **kwargs):
        args = list(args)
        if len(args) > 7:
            args[7] = None
        else:
            kwargs['surface_keys'] = None
        return original(*args, **kwargs)
    app.refresh_in_process = full_refresh

if __name__ == '__main__':
    from django_orm_intellisense.__main__ import main
    main()
