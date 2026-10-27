"""Build macOS parent/explicit-stop guards and tracker startup handoff."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
if sys.platform != 'darwin':
    raise SystemExit('This build entry currently supports macOS only')
sources = root / 'crates/worker-parent'
output = root / 'native/worker-parent/darwin-universal'
output.mkdir(parents=True, exist_ok=True)
for source, target, shared in [
    ('guard.c', 'worker-parent-guard.dylib', True),
    ('launch.c', 'worker-parent-launch', False),
    ('tracker_guard.c', 'resource-tracker-startup-guard.dylib', True),
    ('tracker_launch.c', 'resource-tracker-launch', False),
    ('daemon_guard.c', 'daemon-parent-guard.dylib', True),
    ('daemon_launch.c', 'daemon-parent-launch', False),
]:
    command = ['/usr/bin/clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
               '-arch', 'arm64', '-arch', 'x86_64']
    if shared:
        command.extend(['-dynamiclib', '-pthread'])
    subprocess.run([*command, str(sources / source), '-o', str(output / target)], check=True)
