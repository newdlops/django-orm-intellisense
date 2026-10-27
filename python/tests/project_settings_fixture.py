"""Fresh real-Django payload for the client/LSP integration contract."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile

from django_orm_intellisense.server.project_daemon import ProjectDaemonServer


def main():
    output = sys.stdout
    with tempfile.TemporaryDirectory(prefix='djls-project-contract-') as directory:
        root = Path(directory)
        for name, kind in (('one', 'CharField(max_length=40)'), ('two', 'DateField()')):
            folder = root / name
            for package in ('config', 'inventory'):
                (folder / package).mkdir(parents=True)
                (folder / package / '__init__.py').write_text('')
            (folder / 'manage.py').write_text("import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')\n")
            (folder / 'config/settings.py').write_text(
                "SECRET_KEY='contract'\nINSTALLED_APPS=['inventory']\n"
                "DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n"
                "DEFAULT_AUTO_FIELD='django.db.models.AutoField'\n")
            (folder / 'inventory/models.py').write_text(
                'from django.db import models\nclass Item(models.Model):\n'
                f'    score = models.{kind}\n    only_{name} = models.IntegerField()\n')
        server = ProjectDaemonServer(root)
        try:
            result = server._initialize({'workspaceRoot': str(root)})
        finally:
            server._stopping.set()
            server._close_projects()
            sys.stdout = output
        output.write(json.dumps(result))


if __name__ == '__main__':
    main()
