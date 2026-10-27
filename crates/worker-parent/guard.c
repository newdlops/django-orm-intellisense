#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int guard_fds[2] = {-1, -1};
static int guard_count = 0;

int djls_native_parent_guard_active(void) { return guard_count > 0; }

static void reset_child(void) {
    for (int i = 0; i < guard_count; ++i) close(guard_fds[i]);
    guard_count = 0;
}

static void *watch_parent(void *unused) {
    (void)unused;
    for (;;) {
        struct pollfd watched[2];
        for (int i = 0; i < guard_count; ++i) watched[i] = (struct pollfd){guard_fds[i], POLLIN, 0};
        int result = poll(watched, (nfds_t)guard_count, -1);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) _exit(1);
        for (int i = 0; i < guard_count; ++i) {
            if (watched[i].revents & POLLHUP) _exit(0);
            if (watched[i].revents & (POLLERR | POLLNVAL)) _exit(1);
        }
        /* Neither the spawn bootstrap bytes nor the explicit EOF channel is
           consumed by the native guard. A live readable writer is not EOF. */
        struct timespec delay = {0, 10000000};
        while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {}
    }
}

__attribute__((constructor)) static void attach_guard(void) {
    const char *encoded = getenv("DJLS_NATIVE_PARENT_FD");
    if (!encoded) return;
    const char *position = encoded;
    for (;;) {
        errno = 0;
        char *end = NULL;
        long value = strtol(position, &end, 10);
        if (errno || !end || end == position || value < 3 || value > INT_MAX || guard_count == 2) _exit(1);
        int reader = (int)value;
        struct stat info;
        int status = fcntl(reader, F_GETFL), flags = fcntl(reader, F_GETFD);
        if (fstat(reader, &info) < 0 || !S_ISFIFO(info.st_mode) || status < 0
            || (status & O_ACCMODE) != O_RDONLY || flags < 0) _exit(1);
        if (fcntl(reader, F_SETFD, flags | FD_CLOEXEC) < 0) _exit(1);
        int duplicate = fcntl(reader, F_DUPFD_CLOEXEC, 3);
        if (duplicate < 0) _exit(1);
        guard_fds[guard_count++] = duplicate;
        if (!*end) break;
        if (*end != ',' || !end[1]) _exit(1);
        position = end + 1;
    }
    const char *present = getenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT");
    const char *original = getenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL");
    if (present && strcmp(present, "1") == 0) {
        if (!original || setenv("DYLD_INSERT_LIBRARIES", original, 1) < 0) _exit(1);
    } else if (present && strcmp(present, "0") == 0) {
        if (unsetenv("DYLD_INSERT_LIBRARIES") < 0) _exit(1);
    } else _exit(1);
    if (unsetenv("DJLS_NATIVE_PARENT_FD") < 0 || unsetenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT") < 0
        || unsetenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL") < 0) _exit(1);
    if (pthread_atfork(NULL, NULL, reset_child) != 0) _exit(1);
    pthread_t thread;
    if (pthread_create(&thread, NULL, watch_parent, NULL) != 0 || pthread_detach(thread) != 0) _exit(1);
}
