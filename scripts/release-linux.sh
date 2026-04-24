#!/usr/bin/env bash
# Build Linux release bundles (.AppImage + .deb + .rpm) from any host.
# Runs inside a Docker container so a Mac/Windows host can produce a
# Linux x86_64 release without cross-compilation headaches.
#
# Artifacts land in   src-tauri/target-linux/release/bundle/
# Cargo + npm caches are stored in a named docker volume
# (shellboard-build-cache) so subsequent runs are incremental.

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="shellboard-linux-build:latest"
CACHE_VOL="shellboard-build-cache"
NODE_MODULES_VOL="shellboard-linux-node-modules"
DOCKERFILE="scripts/docker/Dockerfile.linux"
CONTEXT_DIR="scripts/docker"
PLATFORM="linux/amd64"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required but not on PATH." >&2
    exit 1
  fi
}
require docker

# (Re)build image when the Dockerfile is newer than the image, or the
# image doesn't exist yet.
rebuild=false
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  rebuild=true
else
  image_ts=$(docker image inspect --format '{{.Created}}' "$IMAGE")
  image_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${image_ts%.*}" "+%s" 2>/dev/null \
               || date -d "$image_ts" +%s 2>/dev/null || echo 0)
  file_epoch=$(stat -f %m "$DOCKERFILE" 2>/dev/null \
              || stat -c %Y "$DOCKERFILE")
  if [ "$file_epoch" -gt "$image_epoch" ]; then
    rebuild=true
  fi
fi
if $rebuild; then
  echo "→ Building Docker image $IMAGE (first time or Dockerfile changed)"
  docker build --platform "$PLATFORM" -f "$DOCKERFILE" -t "$IMAGE" "$CONTEXT_DIR"
fi

# Ensure cache + node_modules volumes exist (create is a no-op if they do).
docker volume create "$CACHE_VOL" >/dev/null
docker volume create "$NODE_MODULES_VOL" >/dev/null

# Allow the caller to raise parallelism if they have bumped Docker Desktop
# memory above the default ~4 GB.
JOBS_ENV=()
if [ -n "${CARGO_BUILD_JOBS:-}" ]; then
  JOBS_ENV=(-e "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}")
fi
BUNDLES_ENV=()
if [ -n "${SHELLBOARD_BUNDLES:-}" ]; then
  BUNDLES_ENV=(-e "SHELLBOARD_BUNDLES=${SHELLBOARD_BUNDLES}")
fi

# Extra debug trace from linuxdeploy-plugin-gtk — normally it logs nothing
# when Tauri captures its output, so failures are opaque. Setting DEBUG=1
# makes the plugin's bash script run under `set -x`, which prints every
# subcommand with arguments. Noisy but invaluable for diagnosing
# "subprocess failed (exit code N)" errors during AppImage bundling.
# Comment out the `-e DEBUG=1` line once things work if the noise bothers.
echo "→ Building Shellboard for Linux ($PLATFORM)..."
docker run --rm -it \
  --platform "$PLATFORM" \
  "${JOBS_ENV[@]}" \
  "${BUNDLES_ENV[@]}" \
  -e DEBUG=1 \
  -v "$(pwd):/app" \
  -v "${NODE_MODULES_VOL}:/app/node_modules" \
  -v "${CACHE_VOL}:/cache" \
  -w /app \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    echo "→ Node: $(node -v), Cargo: $(cargo --version), jobs: ${CARGO_BUILD_JOBS:-auto}"
    npm ci --prefer-offline --no-audit --fund=false
    # Docker + Rosetta emulation + linuxdeploy-plugin-gtk currently fail
    # opaquely ("subprocess failed exit 2") and Tauri does not surface
    # stderr. .deb + .rpm package cleanly without linuxdeploy, so local
    # Docker builds cover the major Linux install formats and CI
    # (native Ubuntu runner) produces .AppImage via the release workflow.
    # Override via SHELLBOARD_BUNDLES env to attempt AppImage anyway.
    BUNDLES="${SHELLBOARD_BUNDLES:-deb,rpm}"
    echo "→ Bundling targets: $BUNDLES"
    npm run tauri -- build --verbose --bundles "$BUNDLES"
  '

ROOT="src-tauri/target-linux/release/bundle"

echo ""
echo "────────────────────────────────────────────"
echo "✅ Linux build finished. Artifacts:"
echo "────────────────────────────────────────────"

print_if_exists() {
  for f in $1; do
    if [ -e "$f" ]; then
      sz=$(du -h "$f" | awk '{print $1}')
      printf "    %s (%s)\n" "$f" "$sz"
    fi
  done
}

echo "  Debian / Ubuntu package:"
print_if_exists "$ROOT/deb/*.deb"
echo ""
echo "  RPM (Fedora / RHEL):"
print_if_exists "$ROOT/rpm/*.rpm"
echo ""
if ls "$ROOT"/appimage/*.AppImage >/dev/null 2>&1; then
  echo "  AppImage (portable, works on any Linux):"
  print_if_exists "$ROOT/appimage/*.AppImage"
  echo ""
else
  echo "  (AppImage skipped — produced via CI release workflow on native"
  echo "   Linux runner. Override with SHELLBOARD_BUNDLES=deb,rpm,appimage)"
  echo ""
fi
echo "  Copy to share:"
echo "    cp $ROOT/deb/*.deb ~/Desktop/"
echo "    cp $ROOT/rpm/*.rpm ~/Desktop/"
