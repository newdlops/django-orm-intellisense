#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <mach-o/dyld.h>

int main(int argc, char **argv) {
    if (argc < 7 || strcmp(argv[1], "--djls-tracker-reader") != 0
        || strcmp(argv[3], "--djls-tracker-ready") != 0 || strcmp(argv[5], "--") != 0) return 126;
    char path[PATH_MAX], resolved[PATH_MAX];
    uint32_t size = sizeof path;
    if (_NSGetExecutablePath(path, &size) != 0 || !realpath(path, resolved)) return 126;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 126;
    *slash = '\0';
    const char *suffix = "/resource-tracker-startup-guard.dylib";
    size_t library_size = strlen(resolved) + strlen(suffix) + 1;
    char *library = malloc(library_size);
    if (!library) return 126;
    snprintf(library, library_size, "%s%s", resolved, suffix);
    const char *original = getenv("DYLD_INSERT_LIBRARIES");
    if (setenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT", original ? "1" : "0", 1) < 0
        || setenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL", original ? original : "", 1) < 0) return 126;
    size_t preload_size = strlen(library) + ((original && *original) ? strlen(original) + 1 : 0) + 1;
    char *preload = malloc(preload_size);
    if (!preload) return 126;
    if (original && *original) snprintf(preload, preload_size, "%s:%s", library, original);
    else snprintf(preload, preload_size, "%s", library);
    if (setenv("DYLD_INSERT_LIBRARIES", preload, 1) < 0
        || setenv("DJLS_NATIVE_PARENT_FD", argv[2], 1) < 0
        || setenv("DJLS_NATIVE_PARENT_READY_FD", argv[4], 1) < 0) return 126;
    execv(argv[6], &argv[6]);
    return 127;
}
