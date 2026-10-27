"""Bind reusable runtime metadata to the environment at package startup."""
import os
from hashlib import sha256
from typing import Mapping


def fingerprint_environment(environment: Mapping[str, str]) -> str:
    # Sort by encoded names to match the Node launcher, including non-ASCII
    # names. NUL cannot occur in an OS environment name/value, so it safely
    # separates entries without retaining or publishing their secret values.
    pairs = sorted((name.encode('utf-8', 'surrogateescape'),
                    value.encode('utf-8', 'surrogateescape'))
                   for name, value in environment.items())
    digest = sha256(b'django-orm-launch-environment-v1\0')
    for name, value in pairs:
        digest.update(name + b'\0' + value + b'\0')
    return digest.hexdigest()


# Django and project imports can mutate os.environ. Never relabel an existing
# runtime with those later values or turn every unchanged restart into a miss.
_LAUNCH_ENVIRONMENT_FINGERPRINT = fingerprint_environment(os.environ)


def launch_environment_fingerprint() -> str:
    return _LAUNCH_ENVIRONMENT_FINGERPRINT
