#!/usr/bin/env bash
set -euo pipefail

# Build Rust native addon for the current platform and place it at
# native/<triple>/index.node for the TS loader to find.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE="${CARGO_PROFILE:-release}"
PROFILE_DIR="$PROFILE"
if [[ "$PROFILE" == "dev" ]]; then
  PROFILE_DIR="debug"
fi

CARGO_FLAGS=()
if [[ "$PROFILE" == "release" ]]; then
  CARGO_FLAGS+=("--release")
fi

if [[ ${#CARGO_FLAGS[@]} -gt 0 ]]; then
  cargo build -p django-orm-node "${CARGO_FLAGS[@]}"
else
  cargo build -p django-orm-node
fi

# Detect platform triple for napi-rs convention.
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"

case "$UNAME_S" in
  Darwin)
    case "$UNAME_M" in
      arm64)   TRIPLE="darwin-arm64"; DYLIB_EXT="dylib" ;;
      x86_64)  TRIPLE="darwin-x64";   DYLIB_EXT="dylib" ;;
      *) echo "unsupported darwin arch: $UNAME_M" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$UNAME_M" in
      x86_64)  TRIPLE="linux-x64-gnu";   DYLIB_EXT="so" ;;
      aarch64) TRIPLE="linux-arm64-gnu"; DYLIB_EXT="so" ;;
      *) echo "unsupported linux arch: $UNAME_M" >&2; exit 1 ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    TRIPLE="win32-x64-msvc"; DYLIB_EXT="dll"
    ;;
  *)
    echo "unsupported platform: $UNAME_S" >&2; exit 1
    ;;
esac

SRC="target/$PROFILE_DIR/libdjango_orm_node.$DYLIB_EXT"
if [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then
  SRC="target/$PROFILE_DIR/django_orm_node.dll"
fi

if [[ ! -f "$SRC" ]]; then
  echo "built artifact missing: $SRC" >&2
  exit 1
fi

DEST_DIR="native/$TRIPLE"
mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST_DIR/index.node"

if [[ "$UNAME_S" == "Darwin" ]]; then
  # macOS 15+/Apple Silicon can reject linker-signed copied dylibs with
  # SIGKILL (Code Signature Invalid) when Node dlopen()s the renamed
  # addon. Re-sign the final .node artifact after the copy.
  codesign --force --sign - "$DEST_DIR/index.node" >/dev/null
fi

echo "wrote $DEST_DIR/index.node"
