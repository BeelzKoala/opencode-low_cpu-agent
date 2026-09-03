#!/usr/bin/env bash
set -Eeuo pipefail

LLAMA_DIR="${LLAMA_DIR:-$HOME/llama.cpp}"
BUILD_DIR="${LLAMA_BUILD_DIR:-$LLAMA_DIR/build}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

die() {
  echo "STOP $*" >&2
  exit 2
}

command -v cmake >/dev/null || die "cmake missing"
command -v cargo >/dev/null || die "cargo missing"
command -v rustc >/dev/null || die "rustc missing"

[[ -f "$LLAMA_DIR/CMakeLists.txt" ]] \
  || die "llama.cpp source missing: $LLAMA_DIR"

echo "=== CONFIGURE LLGUIDANCE ==="
cmake \
  -S "$LLAMA_DIR" \
  -B "$BUILD_DIR" \
  -DLLAMA_LLGUIDANCE=ON \
  -DCMAKE_BUILD_TYPE=Release

echo
echo "=== BUILD SERVER + BENCH ==="
cmake \
  --build "$BUILD_DIR" \
  --target llama-server llama-bench \
  -j "$JOBS"

CACHE="$BUILD_DIR/CMakeCache.txt"
[[ -f "$CACHE" ]] \
  || die "CMakeCache missing after build"

grep -q '^LLAMA_LLGUIDANCE:BOOL=ON$' "$CACHE" \
  || die "LLAMA_LLGUIDANCE is not ON in CMakeCache"

[[ -x "$BUILD_DIR/bin/llama-server" ]] \
  || die "llama-server missing"
[[ -x "$BUILD_DIR/bin/llama-bench" ]] \
  || die "llama-bench missing"

echo
echo "PASS llama.cpp LLGuidance build"
"$BUILD_DIR/bin/llama-server" --version | head -n 3 || true
