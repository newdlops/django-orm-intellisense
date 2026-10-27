#ifndef DJLS_NATIVE_STATE_CLEANUP_H
#define DJLS_NATIVE_STATE_CLEANUP_H
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "state_directory.h"
#include "state_lease.h"

/* The pre-spawn allocator may clean its own unspawned lease (pid0). For a
   real child, actual close precedes this call and any live/reused PID refuses. */
static int cleanup_leased_state(int argc, char **argv) {
    int modern=argc==10 && strcmp(argv[1],"--djls-clean-owned-state-v2")==0;
    if (!modern && !(argc==9 && strcmp(argv[1],"--djls-clean-owned-state")==0)) return 2;
    uintmax_t values[7],v;
    for (int i=0;i<(modern?7:6);++i) {
        if (lease_number(argv[i+2],&v)<0) return 2;
        if (modern) values[i]=v;
        else { values[i==0?0:i+1]=v;if (i==0) values[1]=v; }
    }
    if (values[0]>INT_MAX || !values[1] || values[1]>INT_MAX || values[2]!=(uintmax_t)getuid()) return 2;
    if (!values[0]) {
        if (!modern || values[1]!=(uintmax_t)getppid()) return 2;
    } else {
        errno=0;
        if (kill((pid_t)values[0],0)==0 || errno!=ESRCH) return 2;
    }
    struct state_lease lease={.allocator=(pid_t)values[1],.uid=(uid_t)values[2]};
    const char *provided=argv[modern?9:8],*name;
    if (strlen(provided)>=sizeof lease.path) return 2;
    strcpy(lease.path,provided);
    const char *root=lease.path;
    if (lease_path_name(&lease,&name)<0) return 2;
    char parent[PATH_MAX],canonical[PATH_MAX];
    size_t n=(size_t)(name-root)-1;
    memcpy(parent,root,n);parent[n]='\0';
    if (!realpath(parent,canonical)) return errno==ENOENT?0:2;
    if (strcmp(parent,canonical)) return 2;
    int parent_fd=open(parent,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if (parent_fd<0) return errno==ENOENT?0:2;
    struct stat parent_info,observed,opened,current;
    int result=2,root_fd=-1;
    if (fstat(parent_fd,&parent_info)<0 || (uintmax_t)parent_info.st_dev!=values[3] || (uintmax_t)parent_info.st_ino!=values[4]) goto done;
    if (fstatat(parent_fd,name,&observed,AT_SYMLINK_NOFOLLOW)<0) { if(errno==ENOENT)result=0;goto done; }
    if (!S_ISDIR(observed.st_mode) || (uintmax_t)observed.st_uid!=values[2]
        || (uintmax_t)observed.st_dev!=values[5] || (uintmax_t)observed.st_ino!=values[6]) goto done;
    root_fd=openat(parent_fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if (root_fd<0 || fstat(root_fd,&opened)<0 || !same_inode(&observed,&opened)) goto done;
    purge_state_directory(root_fd);root_fd=-1;
    if (fstatat(parent_fd,name,&current,AT_SYMLINK_NOFOLLOW)==0 && same_inode(&observed,&current)
        && unlinkat(parent_fd,name,AT_REMOVEDIR)==0) result=0;
done:
    if(root_fd>=0)close(root_fd);
    close(parent_fd);
    if(result)fputs("Owned state identity changed or cleanup failed; preserved.\n",stderr);
    return result;
}
#endif
