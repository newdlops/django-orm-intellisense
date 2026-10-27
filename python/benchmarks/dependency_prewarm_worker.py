"""Control with path prewarm retained but dependency prewarm disabled."""
import os
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main

if os.environ.get('DJLS_BENCH_DEPENDENCY_PREWARM') == 'previous':
    def previous_warm(index, runtime):
        if runtime.bootstrap_status == 'ready' and index.model_candidates:
            orm_members._workspace_files(index)
    app.prebuild_runtime_workspace_paths = previous_warm

if __name__ == '__main__':
    main()
