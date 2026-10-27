"""Watch the owning process before importing project-analysis machinery."""
import sys

if __name__ == '__main__':
    arguments = sys.argv[1:]
    if len(arguments) >= 4 and arguments[-2] in ('--parent-exit-fd', '--parent-exit-handle'):
        from ._worker_parent import watch_inherited_parent_pipe
        watch_inherited_parent_pipe(arguments[-2], arguments[-1])
        arguments = arguments[:-2]
    from .runtime.projects import project_worker_main
    project_worker_main(*arguments)
