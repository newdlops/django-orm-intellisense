"""Private worker entry point for a single fresh Django app population."""
import sys


if __name__ == '__main__':
    arguments = sys.argv[1:]
    if len(arguments) >= 5 and arguments[-2] in ('--parent-exit-fd', '--parent-exit-handle'):
        from .worker_lifetime import watch_inherited_parent_pipe
        watch_inherited_parent_pipe(arguments[-2], arguments[-1])
        arguments = arguments[:-2]

from .runtime_members import worker_main


if __name__ == '__main__':
    worker_main(arguments[0], arguments[1], arguments[2], tuple(arguments[3:]))
