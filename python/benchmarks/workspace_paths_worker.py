"""Control worker for the prior foreground workspace path construction."""
import os
from pathlib import Path

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main

if os.environ.get('DJLS_BENCH_WORKSPACE_PATH_MODE') == 'previous':
    orm_members._canonical_workspace_source_path = lambda value: str(Path(value).resolve())
    app.prebuild_runtime_workspace_paths = lambda static_index, runtime: None

if __name__ == '__main__':
    main()
