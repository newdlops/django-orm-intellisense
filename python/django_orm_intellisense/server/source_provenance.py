"""Producer-bound source witnesses for the optional native startup cache.

This binds sources, interpreter selection and the captured launch environment.
It does not prove dependency, later in-process mutation or external-service
equivalence.
"""
import os
import sys
from pathlib import Path

from ..discovery.workspace import PythonSourceSnapshot
from ..launch_environment import launch_environment_fingerprint


def capture_source_provenance(snapshot: PythonSourceSnapshot, membership: str,
                              extra_roots, requested_settings_module: str | None):
    """Capture before imports. Callers retain this object for that owner only."""
    try:
        executable = Path(os.path.abspath(sys.executable))
        resolved = executable.resolve(strict=True)
        identity = executable.stat()
        if not resolved.is_file():
            return None
        return {
            'version': 2, 'fingerprintVersion': 2, 'membershipVersion': 1,
            'root': snapshot.root, 'extraRoots': [str(path) for path in extra_roots],
            'sourceFingerprint': snapshot.fingerprint, 'membershipFingerprint': membership,
            'requestedSettingsModule': requested_settings_module,
            'launchEnvironmentFingerprint': launch_environment_fingerprint(),
            'interpreter': {'path': str(executable), 'realPath': str(resolved),
                'identity': [str(value) for value in (identity.st_size, identity.st_mtime_ns,
                    identity.st_ctime_ns, identity.st_dev, identity.st_ino)]},
        }
    except (OSError, ValueError):
        return None
