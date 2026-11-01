#!/bin/sh
# Rebuilds the code mode Python sandbox into vendor/octri-python/.
#
# Both inputs are pinned, so the checked-in output is reproducible and nobody
# else needs emscripten:
#   MicroPython v1.29.0 (tag commit below), emscripten/emsdk:6.0.10.
#
# Run from anywhere with Docker:
#   sh packages/octri-mcp/sandbox/python/build.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
MICROPYTHON_TAG="v1.29.0"
MICROPYTHON_COMMIT="0fd6c573ea815774668bbb16b8e197c8822368b2"
EMSDK_IMAGE="emscripten/emsdk:6.0.10"

mkdir -p "$PKG/vendor/octri-python"

# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container paths.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$HERE/port:/src/port:ro" \
  -v "$PKG/vendor/octri-python:/out" \
  "$EMSDK_IMAGE" \
  sh -euc "
    git clone --quiet --depth 1 --branch $MICROPYTHON_TAG https://github.com/micropython/micropython.git /src/micropython
    test \"\$(git -C /src/micropython rev-parse HEAD)\" = $MICROPYTHON_COMMIT
    cp -r /src/port /src/build-port
    make -C /src/build-port TOP=/src/micropython -j\$(nproc)
    cp /src/build-port/build/octri-python.mjs /src/build-port/build/octri-python.wasm /out/
    cp /src/micropython/LICENSE /out/LICENSE
  "

echo "Built: $PKG/vendor/octri-python"
