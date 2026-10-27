#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef struct _object PyObject;
typedef int (*audit_hook)(const char *, PyObject *, void *);
static PyObject *(*tuple_item)(PyObject *, ptrdiff_t);
static int (*is_instance)(PyObject *, PyObject *);
static long (*as_long)(PyObject *);
static void (*err_fetch)(PyObject **, PyObject **, PyObject **);
static void (*err_restore)(PyObject *, PyObject *, PyObject *);
static void (*err_clear)(void);
static PyObject *(*get_frame)(void);
static PyObject *(*frame_globals)(PyObject *);
static PyObject *(*frame_code)(PyObject *);
static PyObject *(*dict_item)(PyObject *, const char *);
static PyObject *(*get_attr)(PyObject *, const char *);
static int (*compare_ascii)(PyObject *, const char *);
static void (*decref)(PyObject *);
static PyObject *long_type;

enum { INACTIVE = 0, ACTIVE = 1, HANDED_OFF = 2, EXITING = 3 };
static atomic_int state = INACTIVE;
static pthread_mutex_t fd_lock = PTHREAD_MUTEX_INITIALIZER;
static int reader = -1, watched = -1, ready_fd = -1, wake_pipe[2] = {-1, -1};

int djls_native_parent_guard_active(void) { return atomic_load(&state) == ACTIVE; }

static int fd_value(const char *value) {
    if (!value) _exit(1);
    errno = 0;
    char *end = NULL;
    long parsed = strtol(value, &end, 10);
    if (errno || !end || end == value || *end || parsed < 3 || parsed > INT_MAX) _exit(1);
    return (int)parsed;
}

static void close_slot(int *fd) {
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static void before_fork(void) { pthread_mutex_lock(&fd_lock); }
static void after_parent(void) { pthread_mutex_unlock(&fd_lock); }
static void after_child(void) {
    close_slot(&watched);
    close_slot(&ready_fd);
    close_slot(&wake_pipe[0]);
    close_slot(&wake_pipe[1]);
    if (atomic_load(&state) == ACTIVE) close_slot(&reader);
    atomic_store(&state, INACTIVE);
    pthread_mutex_unlock(&fd_lock);
}

static void *watch_startup(void *unused) {
    (void)unused;
    for (;;) {
        struct pollfd fds[2] = {{watched, POLLIN, 0}, {wake_pipe[0], POLLIN, 0}};
        int result = poll(fds, 2, -1);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) _exit(1);
        if (atomic_load(&state) != ACTIVE || fds[1].revents) break;
        if (fds[0].revents & POLLHUP) {
            int expected = ACTIVE;
            if (atomic_compare_exchange_strong(&state, &expected, EXITING)) _exit(0);
            break;
        }
        if (fds[0].revents & (POLLERR | POLLNVAL)) _exit(1);
        struct timespec delay = {0, 10000000};
        while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {}
    }
    pthread_mutex_lock(&fd_lock);
    close_slot(&watched);
    close_slot(&wake_pipe[0]);
    close_slot(&wake_pipe[1]);
    pthread_mutex_unlock(&fd_lock);
    return NULL;
}

static void write_byte(int fd, char value) {
    ssize_t count;
    do { count = write(fd, &value, 1); } while (count < 0 && errno == EINTR);
    if (count != 1) _exit(1);
}

/* This hook is called with the interpreter's GIL. The watchdog never calls
   Python. No object layout, Python state pointer or borrowed object is cached. */
static int tracker_open(const char *event, PyObject *args, void *unused) {
    (void)unused;
    if (atomic_load(&state) != ACTIVE || strcmp(event, "open") != 0) return 0;
    int saved_errno = errno;
    PyObject *old_type = NULL, *old_value = NULL, *old_traceback = NULL;
    err_fetch(&old_type, &old_value, &old_traceback);
    PyObject *path = tuple_item(args, 0);
    int matches = path && is_instance(path, long_type) == 1 && as_long(path) == reader;
    PyObject *globals = NULL, *code = NULL, *name = NULL;
    if (matches) {
        PyObject *frame = get_frame();
        globals = frame ? frame_globals(frame) : NULL;
        code = frame ? frame_code(frame) : NULL;
        PyObject *module = globals ? dict_item(globals, "__name__") : NULL;
        name = code ? get_attr(code, "co_name") : NULL;
        matches = module && name && compare_ascii(module, "multiprocessing.resource_tracker") == 0
            && compare_ascii(name, "main") == 0;
    }
    if (name) decref(name);
    if (code) decref(code);
    if (globals) decref(globals);
    err_clear();
    err_restore(old_type, old_value, old_traceback);
    errno = saved_errno;
    if (matches) {
        int expected = ACTIVE;
        if (atomic_compare_exchange_strong(&state, &expected, HANDED_OFF)) {
            /* The parent must wait for R before creating/registering resources.
               After this atomic handoff native EOF can never skip main cleanup. */
            write_byte(wake_pipe[1], 'D');
            write_byte(ready_fd, 'R');
            close_slot(&ready_fd);
        }
    }
    errno = saved_errno;
    return 0;
}

__attribute__((constructor)) static void attach_startup_guard(void) {
    const char *encoded = getenv("DJLS_NATIVE_PARENT_FD");
    if (!encoded) return;
    reader = fd_value(encoded);
    ready_fd = fd_value(getenv("DJLS_NATIVE_PARENT_READY_FD"));
    if (reader == ready_fd) _exit(1);
    struct stat info;
    if (fstat(reader, &info) < 0 || !S_ISFIFO(info.st_mode)) _exit(1);
    int access = fcntl(reader, F_GETFL), flags = fcntl(reader, F_GETFD);
    if (access < 0 || (access & O_ACCMODE) != O_RDONLY || flags < 0
        || fcntl(reader, F_SETFD, flags | FD_CLOEXEC) < 0) _exit(1);
    if (fstat(ready_fd, &info) < 0 || !S_ISFIFO(info.st_mode)) _exit(1);
    access = fcntl(ready_fd, F_GETFL);
    flags = fcntl(ready_fd, F_GETFD);
    if (access < 0 || (access & O_ACCMODE) != O_WRONLY || flags < 0
        || fcntl(ready_fd, F_SETFD, flags | FD_CLOEXEC) < 0) _exit(1);
    watched = fcntl(reader, F_DUPFD_CLOEXEC, 3);
    if (watched < 0 || pipe(wake_pipe) < 0) _exit(1);
    for (int i = 0; i < 2; ++i) if (fcntl(wake_pipe[i], F_SETFD, FD_CLOEXEC) < 0) _exit(1);
    const char *present = getenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT");
    const char *original = getenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL");
    if (present && strcmp(present, "1") == 0) {
        if (!original || setenv("DYLD_INSERT_LIBRARIES", original, 1) < 0) _exit(1);
    } else if (present && strcmp(present, "0") == 0) {
        if (unsetenv("DYLD_INSERT_LIBRARIES") < 0) _exit(1);
    } else _exit(1);
    for (const char **key = (const char *[]){"DJLS_NATIVE_PARENT_FD", "DJLS_NATIVE_PARENT_READY_FD",
         "DJLS_NATIVE_PARENT_PRELOAD_PRESENT", "DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL", NULL}; *key; ++key) {
        if (unsetenv(*key) < 0) _exit(1);
    }
#define RESOLVE(slot, symbol) do { *(void **)(&(slot)) = dlsym(RTLD_DEFAULT, symbol); if (!(slot)) _exit(1); } while (0)
    int (*add_hook)(audit_hook, void *);
    RESOLVE(add_hook, "PySys_AddAuditHook");
    RESOLVE(tuple_item, "PyTuple_GetItem");
    RESOLVE(is_instance, "PyObject_IsInstance");
    RESOLVE(as_long, "PyLong_AsLong");
    RESOLVE(err_fetch, "PyErr_Fetch");
    RESOLVE(err_restore, "PyErr_Restore");
    RESOLVE(err_clear, "PyErr_Clear");
    RESOLVE(get_frame, "PyEval_GetFrame");
    RESOLVE(frame_globals, "PyFrame_GetGlobals");
    RESOLVE(frame_code, "PyFrame_GetCode");
    RESOLVE(dict_item, "PyDict_GetItemString");
    RESOLVE(get_attr, "PyObject_GetAttrString");
    RESOLVE(compare_ascii, "PyUnicode_CompareWithASCIIString");
    RESOLVE(decref, "Py_DecRef");
    RESOLVE(long_type, "PyLong_Type");
#undef RESOLVE
    atomic_store(&state, ACTIVE);
    if (add_hook(tracker_open, NULL) != 0) _exit(1);
    if (pthread_atfork(before_fork, after_parent, after_child) != 0) _exit(1);
    pthread_t thread;
    if (pthread_create(&thread, NULL, watch_startup, NULL) != 0 || pthread_detach(thread) != 0) _exit(1);
}
