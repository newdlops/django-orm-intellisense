#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "state_lease.h"
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int guard_fd = -1, queue_fd = -1;

/* Inserted into the daemon guard only. No Python API, process payload, model
   object, global temporary-directory scan or external symlink traversal. */
#include <dirent.h>
#include <stdio.h>

static pthread_mutex_t state_lock = PTHREAD_MUTEX_INITIALIZER;
static int state_parent_fd = -1, state_root_fd = -1;
static pid_t state_owner_pid = 0, state_allocator_pid = 0;
static struct stat state_identity;
static char state_root_path[PATH_MAX], state_root_name[128];

const char *djls_native_state_directory(void) {
    pthread_mutex_lock(&state_lock);
    const char *path = state_owner_pid == getpid() && state_root_fd >= 0 ? state_root_path : NULL;
    pthread_mutex_unlock(&state_lock);
    return path;
}

#include "state_directory.h"

static void cleanup_state_root(void) {
    pthread_mutex_lock(&state_lock);
    if (state_owner_pid == getpid() && state_root_fd >= 0 && state_parent_fd >= 0) {
        struct stat current, opened;
        if (fstatat(state_parent_fd, state_root_name, &current, AT_SYMLINK_NOFOLLOW) == 0
            && fstat(state_root_fd, &opened) == 0 && same_inode(&state_identity, &current)
            && same_inode(&state_identity, &opened)) {
            int root = state_root_fd;
            state_root_fd = -1;
            purge_state_directory(root);
            if (fstatat(state_parent_fd, state_root_name, &current, AT_SYMLINK_NOFOLLOW) == 0
                && same_inode(&state_identity, &current)) (void)unlinkat(state_parent_fd, state_root_name, AT_REMOVEDIR);
        }
    }
    if (state_root_fd >= 0) close(state_root_fd);
    if (state_parent_fd >= 0) close(state_parent_fd);
    state_root_fd = state_parent_fd = -1;
    pthread_mutex_unlock(&state_lock);
}

static _Noreturn void exit_with_state(int status) {
    cleanup_state_root();
    _exit(status);
}

static int create_state_root(void) {
    const char *temporary = getenv("TMPDIR");
    if (!temporary || !*temporary) temporary = "/tmp";
    char resolved[PATH_MAX];
    if (!realpath(temporary, resolved)) return -1;
    state_parent_fd = open(resolved, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (state_parent_fd < 0) return -1;
    int length = snprintf(state_root_path, sizeof state_root_path, "%s/djls-owned-worker-state-%ld-XXXXXX", resolved, (long)getpid());
    if (length < 0 || (size_t)length >= sizeof state_root_path || !mkdtemp(state_root_path)) return -1;
    const char *name = strrchr(state_root_path, '/');
    if (!name || strlen(name + 1) >= sizeof state_root_name) return -1;
    strcpy(state_root_name, name + 1);
    if (fstatat(state_parent_fd, state_root_name, &state_identity, AT_SYMLINK_NOFOLLOW) < 0
        || !S_ISDIR(state_identity.st_mode) || state_identity.st_uid != getuid()) return -1;
    state_owner_pid = state_allocator_pid = getpid();
    state_root_fd = openat(state_parent_fd, state_root_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (state_root_fd < 0) {
        /* The newly created root is still empty if its initial open fails. */
        struct stat current;
        if (fstatat(state_parent_fd, state_root_name, &current, AT_SYMLINK_NOFOLLOW) == 0
            && same_inode(&state_identity, &current)) (void)unlinkat(state_parent_fd, state_root_name, AT_REMOVEDIR);
        return -1;
    }
    struct stat opened;
    if (fstat(state_root_fd, &opened) < 0 || !same_inode(&state_identity, &opened)) return -1;
    return 0;
}

static int adopt_state_root(const struct state_lease *lease) {
    struct stat parent,root,current;
    const char *name;
    if (lease->uid!=getuid() || lease_path_name(lease,&name)<0
        || fstat(5,&parent)<0 || fstat(4,&root)<0
        || !S_ISDIR(parent.st_mode) || !S_ISDIR(root.st_mode) || root.st_uid!=getuid()
        || (uintmax_t)parent.st_dev!=lease->parent_dev || (uintmax_t)parent.st_ino!=lease->parent_ino
        || (uintmax_t)root.st_dev!=lease->root_dev || (uintmax_t)root.st_ino!=lease->root_ino
        || fstatat(5,name,&current,AT_SYMLINK_NOFOLLOW)<0 || !same_inode(&root,&current)) return -1;
    state_identity=root;state_owner_pid=getpid();state_allocator_pid=lease->allocator;
    strcpy(state_root_path,lease->path);strcpy(state_root_name,name);
    state_parent_fd=fcntl(5,F_DUPFD_CLOEXEC,6);
    if (state_parent_fd<0) return -1;
    state_root_fd=fcntl(4,F_DUPFD_CLOEXEC,6);
    if (state_root_fd<0) return -1;
    close(4);close(5);
    return 0;
}

static void state_before_fork(void) { pthread_mutex_lock(&state_lock); }
static void state_after_fork_parent(void) { pthread_mutex_unlock(&state_lock); }
static void state_after_fork_child(void) {
    if (state_root_fd >= 0) close(state_root_fd);
    if (state_parent_fd >= 0) close(state_parent_fd);
    state_root_fd = state_parent_fd = -1;
    state_owner_pid = state_allocator_pid = 0;
    state_root_path[0] = state_root_name[0] = '\0';
    pthread_mutex_unlock(&state_lock);
}

__attribute__((destructor)) static void release_state_on_ordinary_exit(void) {
    cleanup_state_root();
}


int djls_native_parent_guard_active(void) { return guard_fd >= 0; }

static void reset_child(void) {
    if (guard_fd >= 0) close(guard_fd);
    guard_fd = -1;
    /* kqueue descriptors are not inherited by fork. */
    queue_fd = -1;
    state_after_fork_child();
}

/* A bounded, nonblocking frame on a private socket. No process-wide signal
   disposition change and no Python/PTH code can write to this closed fd. */
#include <inttypes.h>
static int report_state_root(int channel) {
    struct stat parent;
    if (fstat(state_parent_fd, &parent) < 0) { close(channel); return -1; }
    char encoded[2 * PATH_MAX + 1], frame[8192];
    size_t size = strlen(state_root_path);
    if (size >= PATH_MAX) { close(channel); return -1; }
    const char *hex = "0123456789abcdef";
    for (size_t i = 0; i < size; ++i) {
        unsigned char byte = (unsigned char)state_root_path[i];
        encoded[i * 2] = hex[byte >> 4]; encoded[i * 2 + 1] = hex[byte & 15];
    }
    encoded[size * 2] = '\0';
    int n = snprintf(frame, sizeof frame, "djls-state-2\t%ld\t%ld\t%ju\t%ju\t%ju\t%ju\t%ju\t%s\n",
        (long)getpid(), (long)state_allocator_pid, (uintmax_t)getuid(), (uintmax_t)parent.st_dev, (uintmax_t)parent.st_ino,
        (uintmax_t)state_identity.st_dev, (uintmax_t)state_identity.st_ino, encoded);
    int one = 1, flags = fcntl(channel, F_GETFL);
    if (n < 0 || (size_t)n >= sizeof frame || flags < 0
        || setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one) < 0
        || fcntl(channel, F_SETFL, flags | O_NONBLOCK) < 0) { close(channel); return -1; }
    size_t sent = 0;
    while (sent < (size_t)n) {
        ssize_t count = send(channel, frame + sent, (size_t)n - sent, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { close(channel); return -1; }
        sent += (size_t)count;
    }
    close(channel);
    return 0;
}

static void *watch_stdin(void *unused) {
    (void)unused;
    for (;;) {
        struct kevent event;
        int result = kevent(queue_fd, NULL, 0, &event, 1, NULL);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) exit_with_state(1);
        if (result == 0) continue;
        if (event.flags & EV_ERROR) exit_with_state(1);
        if (event.flags & EV_EOF) {
            /* Give ordinary Python EOF/finally cleanup the existing 2.5s
               owner-close window. Enforce EOF3s even when it cannot run. */
            struct timespec grace = {2, 500000000};
            while (nanosleep(&grace, &grace) < 0 && errno == EINTR) {}
            exit_with_state(0);
        }
        /* EV_CLEAR delivers the next transition without reading even one byte.
           EOF is reported for a half-closed socket with unread input too. */
    }
}

__attribute__((constructor)) static void attach_stdin_guard(void) {
    const char *encoded=getenv("DJLS_NATIVE_DAEMON_FD");
    if (!encoded) return;
    char *copy=strdup(encoded);if(!copy)exit_with_state(1);
    char *fields[10],*save=NULL;size_t count=0;
    for(char *p=strtok_r(copy,":",&save);p;p=strtok_r(NULL,":",&save)) {
        if(count>=10)exit_with_state(1);fields[count++]=p;
    }
    uintmax_t reader_number,channel_number=0;
    if((count!=1 && count!=2 && count!=9) || lease_number(fields[0],&reader_number)<0
        || reader_number<3 || reader_number>INT_MAX)exit_with_state(1);
    int state_channel=-1;struct state_lease lease;
    if(count>=2) {
        if(lease_number(fields[1],&channel_number)<0 || channel_number!=3 || channel_number==reader_number)exit_with_state(1);
        state_channel=3;
    }
    if(count==9 && parse_state_lease(fields+2,&lease)<0)exit_with_state(1);
    int reader=(int)reader_number;
    struct stat info;
    if(fstat(reader,&info)<0)exit_with_state(1);
    if(S_ISSOCK(info.st_mode)) {
        int type;socklen_t size=sizeof type;
        if(getsockopt(reader,SOL_SOCKET,SO_TYPE,&type,&size)<0 || type!=SOCK_STREAM)exit_with_state(1);
    } else if(S_ISFIFO(info.st_mode)) {
        int access=fcntl(reader,F_GETFL);
        if(access<0 || (access&O_ACCMODE)!=O_RDONLY)exit_with_state(1);
    } else exit_with_state(1);
    guard_fd=fcntl(reader,F_DUPFD_CLOEXEC,6);
    if(guard_fd<0)exit_with_state(1);
    close(reader);
    const char *present=getenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT");
    const char *original=getenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL");
    if(present && strcmp(present,"1")==0) {
        if(!original || setenv("DYLD_INSERT_LIBRARIES",original,1)<0)exit_with_state(1);
    } else if(present && strcmp(present,"0")==0) {
        if(unsetenv("DYLD_INSERT_LIBRARIES")<0)exit_with_state(1);
    } else exit_with_state(1);
    if(unsetenv("DJLS_NATIVE_DAEMON_FD")<0 || unsetenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT")<0
        || unsetenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL")<0)exit_with_state(1);
    int adopted=count==9?adopt_state_root(&lease):create_state_root();
    free(copy);
    if(adopted<0)exit_with_state(1);
    queue_fd=kqueue();
    if(queue_fd<0 || fcntl(queue_fd,F_SETFD,FD_CLOEXEC)<0)exit_with_state(1);
    struct kevent change;
    EV_SET(&change,guard_fd,EVFILT_READ,EV_ADD|EV_ENABLE|EV_CLEAR,0,0,NULL);
    if(kevent(queue_fd,&change,1,NULL,0,NULL)<0)exit_with_state(1);
    if(pthread_atfork(state_before_fork,state_after_fork_parent,reset_child)!=0)exit_with_state(1);
    pthread_t thread;
    if(pthread_create(&thread,NULL,watch_stdin,NULL)!=0 || pthread_detach(thread)!=0)exit_with_state(1);
    if(state_channel>=0 && report_state_root(state_channel)<0)exit_with_state(1);
}
