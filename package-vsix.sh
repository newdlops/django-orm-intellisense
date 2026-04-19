#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the extension." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to package the extension." >&2
  exit 1
fi

VSIX_NAME="$(node -p "const pkg = require('./package.json'); [pkg.name, pkg.version].join('-') + '.vsix'")"

echo "Compiling extension..."
npm run compile

# Build native addon for the host platform. CI-produced prebuilds for other
# platforms can be dropped into native/<triple>/index.node before invoking
# this script; they will be included in the .vsix as-is.
if [[ "${SKIP_NATIVE_BUILD:-0}" != "1" ]]; then
  echo "Building native addon for host platform..."
  bash scripts/build-native.sh
fi

echo "Packaging VSIX..."
npx --yes @vscode/vsce package "$@"

if [[ -f "$VSIX_NAME" ]]; then
  echo
  echo "Created: $ROOT_DIR/$VSIX_NAME"
  echo "Install: code --install-extension \"$ROOT_DIR/$VSIX_NAME\""
fi
