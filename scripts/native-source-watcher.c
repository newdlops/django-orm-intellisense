#include <node_api.h>
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define EVENT_LIMIT 256
#define BYTE_LIMIT 65536
#define IGNORE_LIMIT 64

typedef struct {
  uint32_t offset, flags;
  uint64_t id;
} Entry;

typedef struct {
  Entry entries[EVENT_LIMIT];
  char paths[BYTE_LIMIT];
  size_t count, bytes;
  bool rescan, base_changed, history_done;
} Pending;

typedef struct {
  atomic_uint references;
  atomic_bool closing;
  napi_env env;
  napi_threadsafe_function delivery;
  bool hook_active, stream_started, wake_queued, include_non_python;
  FSEventStreamRef stream;
  dispatch_queue_t queue;
  pthread_mutex_t mutex;
  char *root, *base;
  size_t root_length, ignored_count;
  char *ignored[IGNORE_LIMIT];
  char **selected_files, **selected_directories;
  size_t selected_file_count, selected_directory_count;
  bool selection_enabled, selection_fallback;
  Pending pending;
} Watcher;

static atomic_uint active_streams;
static const napi_type_tag SOURCE_WATCHER_TAG = {0xd08d32b69337408aULL, 0x8bbd984fef31c5abULL};
static void close_watcher(Watcher *watcher);

static void retain_watcher(Watcher *watcher) {
  atomic_fetch_add_explicit(&watcher->references, 1, memory_order_relaxed);
}

static void release_selection(Watcher *watcher) {
  for (size_t i = 0; i < watcher->selected_file_count; i++) free(watcher->selected_files[i]);
  for (size_t i = 0; i < watcher->selected_directory_count; i++) free(watcher->selected_directories[i]);
  free(watcher->selected_files); free(watcher->selected_directories);
  watcher->selected_files = watcher->selected_directories = NULL;
  watcher->selected_file_count = watcher->selected_directory_count = 0;
}

static void release_watcher(Watcher *watcher) {
  if (atomic_fetch_sub_explicit(&watcher->references, 1, memory_order_acq_rel) != 1) return;
  for (size_t i = 0; i < watcher->ignored_count; i++) free(watcher->ignored[i]);
  release_selection(watcher);
  free(watcher->root); free(watcher->base);
  pthread_mutex_destroy(&watcher->mutex);
  free(watcher);
}

static void delivery_finalized(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  release_watcher(data);
}

static void cleanup_environment(void *data) {
  Watcher *watcher = data;
  watcher->hook_active = false;
  close_watcher(watcher);
  release_watcher(watcher);
}

static void object_finalized(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Watcher *watcher = data;
  close_watcher(watcher);
  release_watcher(watcher);
}

static bool property(napi_env env, napi_value object, const char *name, napi_value value) {
  return napi_set_named_property(env, object, name, value) == napi_ok;
}

static bool boolean_property(napi_env env, napi_value object, const char *name, bool value) {
  napi_value result;
  return napi_get_boolean(env, value, &result) == napi_ok && property(env, object, name, result);
}

static bool number_property(napi_env env, napi_value object, const char *name, uint32_t value) {
  napi_value result;
  return napi_create_uint32(env, value, &result) == napi_ok && property(env, object, name, result);
}

static void deliver(napi_env env, napi_value callback, void *context, void *data) {
  (void)data;
  Watcher *watcher = context;
  if (!env || !callback || atomic_load_explicit(&watcher->closing, memory_order_acquire)) return;
  Pending snapshot;
  Pending *batch = &snapshot;
  pthread_mutex_lock(&watcher->mutex);
  *batch = watcher->pending;
  memset(&watcher->pending, 0, sizeof(watcher->pending));
  watcher->wake_queued = false;
  pthread_mutex_unlock(&watcher->mutex);
  napi_value result, array, receiver;
  bool ok = napi_create_object(env, &result) == napi_ok
    && napi_create_array_with_length(env, batch->count, &array) == napi_ok;
  for (size_t i = 0; ok && i < batch->count; i++) {
    napi_value entry, name, id;
    char identifier[32];
    snprintf(identifier, sizeof(identifier), "%llu", (unsigned long long)batch->entries[i].id);
    ok = napi_create_object(env, &entry) == napi_ok
      && napi_create_string_utf8(env, batch->paths + batch->entries[i].offset, NAPI_AUTO_LENGTH, &name) == napi_ok
      && napi_create_string_utf8(env, identifier, NAPI_AUTO_LENGTH, &id) == napi_ok
      && property(env, entry, "path", name) && property(env, entry, "id", id)
      && number_property(env, entry, "flags", batch->entries[i].flags)
      && napi_set_element(env, array, (uint32_t)i, entry) == napi_ok;
  }
  if (ok) ok = property(env, result, "events", array)
    && boolean_property(env, result, "rescan", batch->rescan)
    && boolean_property(env, result, "baseChanged", batch->base_changed)
    && boolean_property(env, result, "historyDone", batch->history_done)
    && napi_get_undefined(env, &receiver) == napi_ok;
  if (ok) {
    napi_value ignored;
    /* JS owns error reporting. Native code never calls JS from the CF queue. */
    (void)napi_call_function(env, receiver, callback, 1, &result, &ignored);
  }
}

static const char *relative_path(const Watcher *watcher, const char *name) {
  if (strcmp(watcher->root, "/") == 0) return name[0] == '/' ? name + 1 : NULL;
  if (strncmp(name, watcher->root, watcher->root_length) != 0) return NULL;
  if (name[watcher->root_length] == '\0') return name + watcher->root_length;
  return name[watcher->root_length] == '/' ? name + watcher->root_length + 1 : NULL;
}

static bool ignored_path(const Watcher *watcher, const char *relative) {
  for (const char *segment = relative; *segment;) {
    const char *end = strchr(segment, '/');
    size_t length = end ? (size_t)(end - segment) : strlen(segment);
    for (size_t i = 0; i < watcher->ignored_count; i++) {
      if (strlen(watcher->ignored[i]) == length && memcmp(segment, watcher->ignored[i], length) == 0) return true;
    }
    if (!end) break;
    segment = end + 1;
  }
  return false;
}

static bool python_file(const char *name, size_t length) {
  return length >= 3 && name[length - 3] == '.'
    && tolower((unsigned char)name[length - 2]) == 'p'
    && tolower((unsigned char)name[length - 1]) == 'y';
}

static size_t selected_lower_bound(char *const *paths, size_t count, const char *name) {
  size_t first = 0;
  while (first < count) {
    size_t middle = first + (count - first) / 2;
    if (strcmp(paths[middle], name) < 0) first = middle + 1;
    else count = middle;
  }
  return first;
}

static bool selected_exact(char *const *paths, size_t count, const char *name) {
  size_t index = selected_lower_bound(paths, count, name);
  return index < count && strcmp(paths[index], name) == 0;
}

static bool selected_descendant(char *const *paths, size_t count, const char *prefix, size_t length) {
  size_t index = selected_lower_bound(paths, count, prefix);
  return index < count && strncmp(paths[index], prefix, length) == 0;
}

/* A conservative superset of the physical observer's existing JS predicate.
 * ASCII folding may retain extra events on case-sensitive volumes. Unicode
 * or non-literal names retain the original unfiltered observation instead.
 * Uncertainty/root-change flags are processed before this queue filter. */
static bool selected_event(const Watcher *watcher, const char *name, size_t length, uint32_t flags) {
  if (!watcher->selection_enabled || watcher->selection_fallback) return true;
  char folded[PATH_MAX + 2];
  for (size_t i = 0; i < length; i++) {
    unsigned char value = (unsigned char)name[i];
    if (value >= 128) return true;
    folded[i] = (value >= 'A' && value <= 'Z') ? (char)(value + ('a' - 'A')) : (char)value;
  }
  folded[length] = '\0';
  if (selected_exact(watcher->selected_files, watcher->selected_file_count, folded)) return true;
  if (flags & kFSEventStreamEventFlagItemIsDir) {
    size_t prefix_length = length;
    if (prefix_length == 0 || folded[prefix_length - 1] != '/') folded[prefix_length++] = '/';
    folded[prefix_length] = '\0';
    bool ancestor = selected_descendant(watcher->selected_files, watcher->selected_file_count, folded, prefix_length)
      || selected_descendant(watcher->selected_directories, watcher->selected_directory_count, folded, prefix_length);
    folded[length] = '\0';
    if (ancestor) return true;
  }
  for (;;) {
    if (selected_exact(watcher->selected_directories, watcher->selected_directory_count, folded)) return true;
    char *slash = strrchr(folded, '/');
    if (!slash || slash[1] == '\0') break;
    if (slash == folded) slash[1] = '\0';
    else *slash = '\0';
  }
  return false;
}

static void changed(ConstFSEventStreamRef stream, void *info, size_t count, void *names,
                    const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  (void)stream;
  Watcher *watcher = info;
  char **paths = names;
  pthread_mutex_lock(&watcher->mutex);
  if (atomic_load_explicit(&watcher->closing, memory_order_acquire)) {
    pthread_mutex_unlock(&watcher->mutex); return;
  }
  Pending *pending = &watcher->pending;
  const uint32_t uncertainty = kFSEventStreamEventFlagMustScanSubDirs
    | kFSEventStreamEventFlagUserDropped | kFSEventStreamEventFlagKernelDropped
    | kFSEventStreamEventFlagEventIdsWrapped | kFSEventStreamEventFlagMount
    | kFSEventStreamEventFlagUnmount;
  for (size_t i = 0; i < count; i++) {
    if (flags[i] & kFSEventStreamEventFlagHistoryDone) { pending->history_done = true; continue; }
    if (flags[i] & kFSEventStreamEventFlagRootChanged) {
      pending->base_changed = true; pending->rescan = true;
    }
    if (flags[i] & uncertainty) pending->rescan = true;
    const char *relative = relative_path(watcher, paths[i]);
    if (!relative || ignored_path(watcher, relative)) continue;
    size_t length = strnlen(paths[i], PATH_MAX + 1);
    if (length > PATH_MAX) { pending->rescan = true; continue; }
    if (!selected_event(watcher, paths[i], length, flags[i])) continue;
    if (!watcher->include_non_python
        && (flags[i] & kFSEventStreamEventFlagItemIsFile) && !python_file(paths[i], length)) continue;
    if (pending->rescan) continue;
    if (pending->count == EVENT_LIMIT || length + 1 > BYTE_LIMIT - pending->bytes) {
      pending->rescan = true; pending->count = pending->bytes = 0; continue;
    }
    Entry *entry = &pending->entries[pending->count++];
    entry->offset = (uint32_t)pending->bytes; entry->flags = flags[i]; entry->id = ids[i];
    memcpy(pending->paths + pending->bytes, paths[i], length + 1);
    pending->bytes += length + 1;
  }
  if (!watcher->wake_queued && (pending->count || pending->rescan || pending->history_done)) {
    watcher->wake_queued = true;
    napi_status status = napi_call_threadsafe_function(watcher->delivery, NULL, napi_tsfn_nonblocking);
    if (status != napi_ok) {
      pending->rescan = true;
      /* QueueFull means the existing wake will drain the dirty-root marker. */
      if (status != napi_queue_full) watcher->wake_queued = false;
    }
  }
  pthread_mutex_unlock(&watcher->mutex);
}

static void barrier(void *unused) { (void)unused; }

static void close_watcher(Watcher *watcher) {
  if (atomic_exchange_explicit(&watcher->closing, true, memory_order_acq_rel)) return;
  if (watcher->stream) {
    if (watcher->stream_started) {
      FSEventStreamStop(watcher->stream);
      atomic_fetch_sub_explicit(&active_streams, 1, memory_order_relaxed);
    }
    FSEventStreamInvalidate(watcher->stream);
    dispatch_sync_f(watcher->queue, NULL, barrier);
    FSEventStreamRelease(watcher->stream);
    watcher->stream = NULL;
  }
  if (watcher->queue) { dispatch_release(watcher->queue); watcher->queue = NULL; }
  release_selection(watcher);
  pthread_mutex_lock(&watcher->mutex);
  memset(&watcher->pending, 0, sizeof(watcher->pending));
  pthread_mutex_unlock(&watcher->mutex);
  if (watcher->delivery) {
    (void)napi_release_threadsafe_function(watcher->delivery, napi_tsfn_abort);
    watcher->delivery = NULL;
  }
  if (watcher->hook_active
      && napi_remove_env_cleanup_hook(watcher->env, cleanup_environment, watcher) == napi_ok) {
    watcher->hook_active = false;
    release_watcher(watcher);
  }
}

static Watcher *unwrap(napi_env env, napi_callback_info info) {
  napi_value receiver;
  Watcher *watcher = NULL;
  bool matches = false;
  if (napi_get_cb_info(env, info, NULL, NULL, &receiver, NULL) != napi_ok
      || napi_check_object_type_tag(env, receiver, &SOURCE_WATCHER_TAG, &matches) != napi_ok || !matches
      || napi_unwrap(env, receiver, (void **)&watcher) != napi_ok || !watcher) {
    napi_throw_type_error(env, NULL, "A native source watcher receiver is required.");
    return NULL;
  }
  return watcher;
}

static napi_value dispose(napi_env env, napi_callback_info info) {
  Watcher *watcher = unwrap(env, info);
  if (!watcher) return NULL;
  close_watcher(watcher);
  napi_value result; (void)napi_get_undefined(env, &result); return result;
}

static napi_value state(napi_env env, napi_callback_info info) {
  Watcher *watcher = unwrap(env, info);
  if (!watcher) return NULL;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  pthread_mutex_lock(&watcher->mutex);
  bool ok = number_property(env, result, "pendingBytes", (uint32_t)watcher->pending.bytes)
    && number_property(env, result, "pendingEvents", (uint32_t)watcher->pending.count)
    && number_property(env, result, "capacityBytes", BYTE_LIMIT)
    && number_property(env, result, "capacityEvents", EVENT_LIMIT)
    && boolean_property(env, result, "rescan", watcher->pending.rescan)
    && boolean_property(env, result, "closed", atomic_load_explicit(&watcher->closing, memory_order_acquire));
  pthread_mutex_unlock(&watcher->mutex);
  return ok ? result : NULL;
}

static char *string_value(napi_env env, napi_value value, size_t maximum) {
  size_t length;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string
      || napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || !length || length > maximum) return NULL;
  char *result = malloc(length + 1);
  if (!result) return NULL;
  size_t copied;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &copied) != napi_ok
      || copied != length || strlen(result) != length) { free(result); return NULL; }
  return result;
}

static int selected_compare(const void *first, const void *second) {
  return strcmp(*(char *const *)first, *(char *const *)second);
}

static bool selected_paths(napi_env env, napi_value selection, const char *property_name,
                           char ***values, size_t *size, bool *fallback) {
  napi_value array;
  bool is_array;
  uint32_t count;
  if (napi_get_named_property(env, selection, property_name, &array) != napi_ok
      || napi_is_array(env, array, &is_array) != napi_ok || !is_array
      || napi_get_array_length(env, array, &count) != napi_ok) return false;
  if (count && SIZE_MAX / (size_t)count < sizeof(char *)) return false;
  if (count) {
    *values = calloc((size_t)count, sizeof(char *));
    if (!*values) return false;
  }
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    if (napi_get_element(env, array, i, &entry) != napi_ok) return false;
    char *name = string_value(env, entry, PATH_MAX);
    if (!name) {
      napi_valuetype type;
      size_t length;
      if (napi_typeof(env, entry, &type) == napi_ok && type == napi_string
          && napi_get_value_string_utf8(env, entry, NULL, 0, &length) == napi_ok && length > PATH_MAX) {
        *fallback = true;
        continue;
      }
      return false;
    }
    (*values)[(*size)++] = name;
    if (name[0] != '/') *fallback = true;
    for (char *p = name; *p; p++) {
      unsigned char value = (unsigned char)*p;
      if (value >= 128) *fallback = true;
      if (*p == '/' && (p[1] == '/' || (p[1] == '.' && (p[2] == '/' || p[2] == '\0'))
          || (p[1] == '.' && p[2] == '.' && (p[3] == '/' || p[3] == '\0')))) *fallback = true;
      if (value >= 'A' && value <= 'Z') *p = (char)(value + ('a' - 'A'));
    }
    size_t length = strlen(name);
    if (length > 1 && name[length - 1] == '/') *fallback = true;
  }
  if (*size > 1) qsort(*values, *size, sizeof(char *), selected_compare);
  return true;
}

static napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6], resource, object;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 4) {
    napi_throw_type_error(env, NULL, "Expected root, watermark-or-null, ignored segments, callback, optional non-Python flag and path selection."); return NULL;
  }
  Watcher *watcher = calloc(1, sizeof(*watcher));
  if (!watcher) { napi_throw_error(env, "ENOMEM", "Cannot allocate source watcher."); return NULL; }
  atomic_init(&watcher->references, 1); atomic_init(&watcher->closing, false); watcher->env = env;
  if (pthread_mutex_init(&watcher->mutex, NULL)) { free(watcher); return NULL; }
  const char *failure = "Invalid native source watcher arguments.";
  if (argc >= 5 && napi_get_value_bool(env, args[4], &watcher->include_non_python) != napi_ok) goto failed;
  if (argc >= 6) {
    napi_valuetype selection_type;
    if (napi_typeof(env, args[5], &selection_type) != napi_ok) goto failed;
    if (selection_type != napi_null && selection_type != napi_undefined) {
      if (!watcher->include_non_python || selection_type != napi_object
          || !selected_paths(env, args[5], "files", &watcher->selected_files,
              &watcher->selected_file_count, &watcher->selection_fallback)
          || !selected_paths(env, args[5], "directories", &watcher->selected_directories,
              &watcher->selected_directory_count, &watcher->selection_fallback)) goto failed;
      watcher->selection_enabled = true;
      if (watcher->selection_fallback) release_selection(watcher);
    }
  }
  watcher->root = string_value(env, args[0], PATH_MAX);
  if (!watcher->root || watcher->root[0] != '/') goto failed;
  watcher->root_length = strlen(watcher->root);
  while (watcher->root_length > 1 && watcher->root[watcher->root_length - 1] == '/') watcher->root[--watcher->root_length] = '\0';
  struct stat entry;
  if (stat(watcher->root, &entry) == 0 && !S_ISDIR(entry.st_mode)) goto failed;
  watcher->base = strdup(watcher->root);
  if (!watcher->base) goto failed;
  char *slash = strrchr(watcher->base, '/');
  if (slash == watcher->base) slash[1] = '\0'; else *slash = '\0';
  FSEventStreamEventId since = kFSEventStreamEventIdSinceNow;
  napi_valuetype type;
  if (napi_typeof(env, args[1], &type) != napi_ok) goto failed;
  if (type != napi_null && type != napi_undefined) {
    char *boundary = string_value(env, args[1], 20);
    if (!boundary) goto failed;
    bool digits = true;
    for (const char *p = boundary; *p; p++) if (*p < '0' || *p > '9') digits = false;
    char *end;
    errno = 0; unsigned long long value = strtoull(boundary, &end, 10);
    bool valid = digits && !errno && *end == '\0' && value && value != UINT64_MAX;
    free(boundary);
    if (!valid) goto failed;
    since = (uint64_t)value;
  }
  bool is_array;
  uint32_t ignored_count;
  if (napi_is_array(env, args[2], &is_array) != napi_ok || !is_array
      || napi_get_array_length(env, args[2], &ignored_count) != napi_ok || ignored_count > IGNORE_LIMIT) goto failed;
  for (uint32_t i = 0; i < ignored_count; i++) {
    napi_value segment;
    if (napi_get_element(env, args[2], i, &segment) != napi_ok) goto failed;
    char *name = string_value(env, segment, 255);
    if (!name || strchr(name, '/') || strchr(name, '\\')) { free(name); goto failed; }
    watcher->ignored[watcher->ignored_count++] = name;
  }
  if (napi_typeof(env, args[3], &type) != napi_ok || type != napi_function) goto failed;
  if (napi_create_string_utf8(env, "django-orm source events", NAPI_AUTO_LENGTH, &resource) != napi_ok) goto failed;
  if (napi_create_threadsafe_function(env, args[3], NULL, resource, 1, 1, watcher,
      delivery_finalized, watcher, deliver, &watcher->delivery) != napi_ok) goto failed;
  retain_watcher(watcher);
  if (napi_unref_threadsafe_function(env, watcher->delivery) != napi_ok) goto failed;
  if (napi_add_env_cleanup_hook(env, cleanup_environment, watcher) != napi_ok) goto failed;
  watcher->hook_active = true; retain_watcher(watcher);
  watcher->queue = dispatch_queue_create("django-orm.native-source-watcher", DISPATCH_QUEUE_SERIAL);
  if (!watcher->queue) goto failed;
  CFStringRef directory = CFStringCreateWithFileSystemRepresentation(NULL, watcher->base);
  if (!directory) goto failed;
  CFArrayRef paths = CFArrayCreate(NULL, (const void **)&directory, 1, &kCFTypeArrayCallBacks);
  CFRelease(directory);
  if (!paths) goto failed;
  FSEventStreamContext context = {0, watcher, NULL, NULL, NULL};
  watcher->stream = FSEventStreamCreate(NULL, changed, &context, paths, since, 0.0,
      kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot);
  CFRelease(paths);
  if (!watcher->stream) goto failed;
  FSEventStreamSetDispatchQueue(watcher->stream, watcher->queue);
  failure = "Native source event registration failed; source watcher is not ready.";
  if (!FSEventStreamStart(watcher->stream)) goto failed;
  watcher->stream_started = true; atomic_fetch_add_explicit(&active_streams, 1, memory_order_relaxed);
  if (napi_create_object(env, &object) != napi_ok) goto failed;
  const napi_property_descriptor methods[] = {
    {"dispose", NULL, dispose, NULL, NULL, NULL, napi_default, NULL},
    {"state", NULL, state, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, object, 2, methods) != napi_ok
      || napi_type_tag_object(env, object, &SOURCE_WATCHER_TAG) != napi_ok
      || napi_wrap(env, object, watcher, object_finalized, NULL, NULL) != napi_ok) goto failed;
  return object;
failed:
  close_watcher(watcher); release_watcher(watcher);
  napi_throw_error(env, NULL, failure);
  return NULL;
}

static napi_value watermark(napi_env env, napi_callback_info info) {
  (void)info;
  char identifier[32];
  snprintf(identifier, sizeof(identifier), "%llu", (unsigned long long)FSEventsGetCurrentEventId());
  napi_value result;
  return napi_create_string_utf8(env, identifier, NAPI_AUTO_LENGTH, &result) == napi_ok ? result : NULL;
}

static napi_value live_streams(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  return napi_create_uint32(env, atomic_load_explicit(&active_streams, memory_order_relaxed), &result) == napi_ok ? result : NULL;
}

static napi_value path_observation_version(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  return napi_create_uint32(env, 1, &result) == napi_ok ? result : NULL;
}

static napi_value path_selection_version(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  return napi_create_uint32(env, 1, &result) == napi_ok ? result : NULL;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"start", NULL, start, NULL, NULL, NULL, napi_default, NULL},
    {"watermark", NULL, watermark, NULL, NULL, NULL, napi_default, NULL},
    {"liveStreams", NULL, live_streams, NULL, NULL, NULL, napi_default, NULL},
    {"pathObservationVersion", NULL, path_observation_version, NULL, NULL, NULL, napi_default, NULL},
    {"pathSelectionVersion", NULL, path_selection_version, NULL, NULL, NULL, napi_default, NULL},
  };
  return napi_define_properties(env, exports, 5, methods) == napi_ok ? exports : NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
