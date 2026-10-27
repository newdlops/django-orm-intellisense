#!/usr/bin/env bash
set -euo pipefail

# Small application-owned N-API watcher. No service, installer, or signing edits.
WATCHER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  exit 0
fi
case "$(uname -m)" in
  arm64) WATCHER_TRIPLE=darwin-arm64 ;;
  x86_64) WATCHER_TRIPLE=darwin-x64 ;;
  *) exit 1 ;;
esac
WATCHER_HEADERS="${NODE_API_HEADERS:-$(node -p 'require("path").resolve(process.execPath, "..", "..", "include", "node")')}"
if [[ ! -f "$WATCHER_HEADERS/node_api.h" ]]; then
  printf 'Set NODE_API_HEADERS to the Node N-API header directory.\n' >&2
  exit 1
fi
WATCHER_DEST="$WATCHER_ROOT/native/$WATCHER_TRIPLE"
mkdir -p "$WATCHER_DEST"
clang -std=c11 -Wall -Wextra -Werror -O2 -bundle -undefined dynamic_lookup \
  -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=source_watcher -I "$WATCHER_HEADERS" \
  -framework CoreServices -framework CoreFoundation \
  "$WATCHER_ROOT/scripts/native-source-watcher.c" -o "$WATCHER_DEST/source-watcher.node"
