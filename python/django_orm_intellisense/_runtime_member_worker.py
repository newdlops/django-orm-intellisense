"""Private fresh-worker entry: watch EOF before importing the server package."""
import sys


if __name__ == '__main__':
    arguments = sys.argv[1:]
    if len(arguments) >= 5 and arguments[-2] in ('--parent-exit-fd', '--parent-exit-handle'):
        from ._worker_parent import watch_inherited_parent_pipe
        watch_inherited_parent_pipe(arguments[-2], arguments[-1])
        arguments = arguments[:-2]

from .server.runtime_members import worker_main


if __name__ == '__main__':
    fresh_runtime = arguments[0] == '--fresh-runtime'
    if fresh_runtime:
        arguments = arguments[1:]
    worker_main(arguments[0], arguments[1], arguments[2], tuple(arguments[3:]),
        **({'fresh_runtime': True} if fresh_runtime else {}))
