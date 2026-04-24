#!/usr/bin/env bash
# Build a release bundle of Shellboard for the current platform.
#
# macOS → .dmg (+ .app)
# Linux → .AppImage, .deb (and .rpm if the toolchain is available)
# Windows → .msi, .exe (if run on Windows)
#
# Usage:
#   ./scripts/release.sh [extra tauri args]
#
# Examples:
#   ./scripts/release.sh
#   ./scripts/release.sh --target aarch64-apple-darwin
#   ./scripts/release.sh --target x86_64-apple-darwin

set -euo pipefail

cd "$(dirname "$0")/.."

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required but not on PATH." >&2
    echo "$2" >&2
    exit 1
  fi
}

require node  "install Node.js (see .nvmrc for the version)"
require npm   "npm ships with Node.js"
require cargo "install Rust toolchain from https://rustup.rs"

OS="$(uname -s)"
ARCH="$(uname -m)"
echo "→ Building Shellboard release for ${OS} ${ARCH}"
echo ""

if [ ! -d node_modules ]; then
  echo "→ node_modules missing, running npm ci..."
  npm ci
fi

# Pass any extra args through to `tauri build`
npm run tauri -- build "$@"

ROOT="src-tauri/target/release/bundle"

print_if_exists() {
  local pattern=$1
  local files
  files=$(ls "$pattern" 2>/dev/null || true)
  if [ -n "$files" ]; then
    for f in $files; do
      local sz
      sz=$(du -h "$f" | awk '{print $1}')
      printf "    %s (%s)\n" "$f" "$sz"
    done
  fi
}

echo ""
echo "────────────────────────────────────────────"
echo "✅ Build finished. Release artifacts:"
echo "────────────────────────────────────────────"

case "$OS" in
  Darwin)
    echo "  macOS .app bundle:"
    print_if_exists "$ROOT/macos/*.app"
    echo ""
    echo "  macOS .dmg (drag-to-install):"
    print_if_exists "$ROOT/dmg/*.dmg"
    echo ""
    echo "  Install locally:"
    echo "    open $ROOT/dmg/*.dmg   # drag to Applications"
    echo "    # or copy the .app directly:"
    echo "    cp -R $ROOT/macos/Shellboard.app /Applications/"
    ;;
  Linux)
    echo "  Debian/Ubuntu package:"
    print_if_exists "$ROOT/deb/*.deb"
    echo ""
    echo "  AppImage (universal, portable):"
    print_if_exists "$ROOT/appimage/*.AppImage"
    echo ""
    echo "  RPM:"
    print_if_exists "$ROOT/rpm/*.rpm"
    echo ""
    echo "  Install locally:"
    echo "    sudo apt install ./$(ls $ROOT/deb/*.deb 2>/dev/null | head -1 || echo '<your.deb>')"
    echo "    # or run the AppImage directly:"
    echo "    chmod +x $ROOT/appimage/*.AppImage && $ROOT/appimage/*.AppImage"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "  Windows installers:"
    print_if_exists "$ROOT/msi/*.msi"
    print_if_exists "$ROOT/nsis/*.exe"
    ;;
  *)
    echo "  Unknown platform — check $ROOT/ manually."
    ;;
esac

echo ""
