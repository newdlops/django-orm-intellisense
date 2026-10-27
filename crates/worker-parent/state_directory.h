#ifndef DJLS_STATE_DIRECTORY_H
#define DJLS_STATE_DIRECTORY_H
#include <dirent.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int same_inode(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

/* Takes ownership of fd. Every descent opens with O_NOFOLLOW and verifies the
   inode observed in the exact already-open private parent directory. */
static void purge_state_directory(int fd) {
    DIR *directory = fdopendir(fd);
    if (!directory) { close(fd); return; }
    (void)fchmod(fd, 0700);
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        struct stat observed;
        if (fstatat(fd, entry->d_name, &observed, AT_SYMLINK_NOFOLLOW) < 0) continue;
        if (S_ISDIR(observed.st_mode)) {
            int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child < 0) continue;
            struct stat opened, current;
            if (fstat(child, &opened) < 0 || !same_inode(&observed, &opened)) { close(child); continue; }
            purge_state_directory(child);
            if (fstatat(fd, entry->d_name, &current, AT_SYMLINK_NOFOLLOW) == 0
                && same_inode(&observed, &current)) (void)unlinkat(fd, entry->d_name, AT_REMOVEDIR);
        } else {
            /* unlinkat removes a symlink entry itself, never its target. */
            (void)unlinkat(fd, entry->d_name, 0);
        }
    }
    closedir(directory);
}

#endif
