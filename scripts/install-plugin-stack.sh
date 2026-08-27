#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-check}"
DEST="${2:-${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins}"

FILES=(
  "cpu-search-core/task-action-v1.mjs"
  "cpu-search-core/task-requirements-v1.mjs"
  "cpu-search-core/evidence-authority-v1.mjs"
  "cpu-search-core/localization-decision-v1.mjs"
  "cpu-search-core/repo-capability-v1.mjs"
  "cpu-search-core/resource-graph-v1.mjs"
  "cpu-search-core/task-search-plan-v1.mjs"
  "cpu-search-core/action-commit-v1.mjs"
  "cpu-search-core/terminal-commit-v1.mjs"
  "cpu-search-core/framework-adapter-v1.mjs"
  "cpu-search-core/flask-jinja-adapter-v1.mjs"
  "cpu-search-core/fastapi-pydantic-adapter-v1.mjs"
  "cpu-search-core/django-orm-adapter-v1.mjs"
  "cpu-search-core/typescript-web-adapter-v1.mjs"
  "cpu-search-core/framework-resource-bridge-v1.mjs"
  "cpu-search-core/resource-adapter-v1.mjs"
  "cpu-search-core/generic-html-js-adapter-v1.mjs"
  "cpu-search-core/react-jsx-router-adapter-v1.mjs"
  "cpu-search-core/vue-sfc-adapter-v1.mjs"
  "cpu-search-core/sql-resource-adapter-v1.mjs"
  "cpu-search-core/resource-adapter-bridge-v1.mjs"
  "cpu-search-core/task-anchor-v1.mjs"
  "cpu-search-core/task-causal-shadow-v1.mjs"
  "cpu-search-core/task-shape-v1.mjs"
  "cpu-search-core/additive-localization-plan-v1.mjs"
  "cpu-search-core/host-integration-shadow-v1.mjs"
  "cpu-search-core/anchor-resolution-frontier-v1.mjs"
  "cpu-search-core/observed-resource-resolver-v1.mjs"
  "cpu-search-core/host-resource-closure-v2.mjs"
  "cpu-search-core/task-bound-obligation-evidence-v1.mjs"
  "cpu-search-core/evidence-tier-v1.mjs"
  "cpu-search-core/obligation-coverage-v1.mjs"
  "cpu-search-core/host-obligation-projector-v1.mjs"
  "cpu-search.ts"
)

install_one() {
  local rel="$1" src="$ROOT/opencode/plugins/$1" dst="$DEST/$1" tmp
  mkdir -p "$(dirname "$dst")"
  tmp="${dst}.tmp.$$"
  install -m 0644 "$src" "$tmp"
  mv -f "$tmp" "$dst"
}

check_one() {
  local rel="$1" src="$ROOT/opencode/plugins/$1" dst="$DEST/$1"
  test -f "$dst" || { echo "FAIL plugin stack missing: $dst"; return 1; }
  cmp -s "$src" "$dst" || {
    echo "FAIL plugin stack drift: $rel"
    sha256sum "$src" "$dst" || true
    return 1
  }
}

case "$MODE" in
  install)
    # A pre-v2.27 entrypoint imports none of these modules. Dependencies are
    # installed first and the new entrypoint is exposed last.
    for rel in "${FILES[@]}"; do install_one "$rel"; done
    ;;
  check) ;;
  *) echo "usage: $0 [install|check] [plugins-dir]" >&2; exit 2 ;;
esac

for rel in "${FILES[@]}"; do check_one "$rel"; done
echo "PASS plugin-stack-v1 exact files=${#FILES[@]} dest=$DEST"
