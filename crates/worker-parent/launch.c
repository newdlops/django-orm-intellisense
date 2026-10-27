#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <mach-o/dyld.h>

int main(int argc, char **argv) {
    char **original_argv;
    const char *readers;
    if (argc >= 5 && strcmp(argv[1], "--djls-worker-readers") == 0 && strcmp(argv[3], "--") == 0) {
        readers = argv[2];
        original_argv = &argv[4];
    } else if (argc >= 3 && strcmp(argv[argc - 2], "--parent-exit-fd") == 0) {
        readers = argv[argc - 1];
        original_argv = argv;
    } else return 126;
    char executable[PATH_MAX], resolved[PATH_MAX];
    uint32_t size = sizeof executable;
    if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) return 126;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 126;
    *slash = '\0';
    const char *filename = "/worker-parent-guard.dylib";
    size_t library_size = strlen(resolved) + strlen(filename) + 1;
    char *library = malloc(library_size);
    if (!library) return 126;
    snprintf(library, library_size, "%s%s", resolved, filename);
    const char *original = getenv("DYLD_INSERT_LIBRARIES");
    if (setenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT", original ? "1" : "0", 1) < 0
        || setenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL", original ? original : "", 1) < 0) return 126;
    size_t preload_size = strlen(library) + ((original && *original) ? strlen(original) + 1 : 0) + 1;
    char *preload = malloc(preload_size);
    if (!preload) return 126;
    if (original && *original) snprintf(preload, preload_size, "%s:%s", library, original);
    else snprintf(preload, preload_size, "%s", library);
    if (setenv("DYLD_INSERT_LIBRARIES", preload, 1) < 0
        || setenv("DJLS_NATIVE_PARENT_FD", readers, 1) < 0) return 126;
    execv(original_argv[0], original_argv);
    return 127;
}
