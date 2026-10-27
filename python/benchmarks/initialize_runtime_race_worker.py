"""Inject one real file edit immediately after configured Django inspection."""
import os
from pathlib import Path

from django_orm_intellisense.__main__ import main
from django_orm_intellisense.server import app

inspect = app.inspect_runtime


def inspect_and_edit(settings):
    result = inspect(settings)
    assert result.bootstrap_status == 'ready'
    source = Path(os.environ['DJLS_BENCH_RUNTIME_RACE_SOURCE'])
    stamp = source.stat()
    original = source.read_text()
    assert 'max_length=255' in original
    source.write_text(original.replace('max_length=255', 'max_length=10 '))
    os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    return result


app.inspect_runtime = inspect_and_edit
if __name__ == '__main__':
    main()
