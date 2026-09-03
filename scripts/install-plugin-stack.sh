#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-check}"
DEST="${2:-${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins}"
RUFF_BRIDGE_REL=".bin/opencode-ruff-python-bridge"
RUFF_BRIDGE_SRC="$ROOT/rust/evidence-distiller/target/release/opencode-ruff-python-bridge"
RUFF_BRIDGE_DST="$DEST/$RUFF_BRIDGE_REL"
MODEL_ABI_COMPILER_REL=".bin/opencode-model-abi-compiler"
MODEL_ABI_COMPILER_SRC="$ROOT/rust/evidence-distiller/target/release/opencode-model-abi-compiler"
MODEL_ABI_COMPILER_DST="$DEST/$MODEL_ABI_COMPILER_REL"

FILES=(
  "cpu-search-core/task-action-v1.mjs"
  "cpu-search-core/task-requirements-v1.mjs"
  "cpu-search-core/task-proof-obligations-v1.mjs"
  "cpu-search-core/task-proof-evaluator-v1.py"
  "cpu-search-core/semantic-preservation-v1.py"
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
  "cpu-search-core/data-obligation-projector-v1.mjs"
  "cpu-search-core/evidence-inspect-v1.mjs"
  "cpu-search-core/scout-evidence-closure-v1.mjs"
  "cpu-search-core/execution-readiness-v1.mjs"
  "cpu-search-core/additive-mutation-v1.mjs"
  "cpu-search-core/additive-mutation-v2.mjs"
  "cpu-search-core/additive-mutation-v3.mjs"
  "cpu-search-core/obligation-bound-synthesis-v1.mjs"
  "cpu-search-core/python-semantic-frontend-v1.py"
  "cpu-search-core/python-semantic-frontend-v1.mjs"
  "cpu-search-core/python-nested-semantic-ir-v1.mjs"
  "cpu-search-core/python-unit-contract-v1.json"
  "cpu-search-core/python-unit-contract-v1.mjs"
  "cpu-search-core/python-semantic-progress-v1.mjs"
  "cpu-search-core/python-semantic-repair-v1.mjs"
  "cpu-search-core/semantic-content-ir-v1.mjs"
  "cpu-search-core/file-family-contract-v1.mjs"
  "cpu-search-core/semantic-obligation-bridge-v1.mjs"
  "cpu-search-core/source-slot-compiler-v1.mjs"
  "cpu-search-core/source-slot-model-hole-v1.mjs"
  "cpu-search-core/model-view-compiler-v1.mjs"
  "cpu-search-core/atomic-model-view-v1.mjs"
  "cpu-search-core/repair-witness-closure-v1.mjs"
  "cpu-search-core/causal-dispatch-contract-v1.mjs"
  "cpu-search-core/typed-counterexample-v1.mjs"
  "cpu-search-core/candidate-obligation-ledger-v1.mjs"
  "cpu-search-core/python-additive-compiler-v1.mjs"
  "cpu-search-core/sealed-additive-site-v1.mjs"
  "cpu-search-core/deterministic-context-carrier-v1.mjs"
  "cpu-search-core/deterministic-scout-entry-v1.mjs"
  "cpu-search-core/governor-latency-v1.mjs"
  "cpu-search-core/governor-work-v2.mjs"
  "cpu-search-core/goal-directed-governor-v1.mjs"
  "cpu-search-core/telemetry-plane-v1.mjs"
  "cpu-search-core/physical-inference-correlation-v1.mjs"
  "cpu-search-core/inference-lifecycle-v1.mjs"
  "cpu-search-core/execution-control-kernel-v1.mjs"
  "cpu-search-core/execution-permit-v1.mjs"
  "cpu-search-core/deterministic-argument-synthesis-v1.mjs"
  "cpu-search-core/native-openai-compatible-mutation-wire-v1.mjs"
  "cpu-search-core/structured-output-runtime-policy-v1.mjs"
  "cpu-search-core/bounded-mutation-inference-v1.mjs"
  "cpu-search-core/qualified-compute-v1.mjs"
  "cpu-search-core/model-context-compiler-v1.mjs"
  "cpu-search-core/execution-contract-v1.mjs"
  "cpu-search-core/repair-convergence-v1.mjs"
  "cpu-search-core/execution-context-planner-v1.mjs"
  "cpu-search-core/mutation-phase-compiler-v1.mjs"
  "cpu-search-core/model-abi-compiler-v1.mjs"
  "cpu-search-core/control-context-layer-v1.mjs"
  "cpu-search-core/physical-inference-lease-v1.mjs"
  "cpu-search-core/governor-physical-lease-v1.mjs"
  "cpu-search.ts"
)

build_ruff_bridge() {
  cargo build --locked --release \
    --manifest-path "$ROOT/rust/evidence-distiller/Cargo.toml" \
    --bin opencode-ruff-python-bridge
}

build_model_abi_compiler() {
  cargo build --locked --release \
    --manifest-path "$ROOT/rust/evidence-distiller/Cargo.toml" \
    --bin opencode-model-abi-compiler
}

install_ruff_bridge() {
  test -x "$RUFF_BRIDGE_SRC" || {
    echo "FAIL Ruff bridge build missing: $RUFF_BRIDGE_SRC" >&2
    return 1
  }
  mkdir -p "$(dirname "$RUFF_BRIDGE_DST")"
  local tmp="${RUFF_BRIDGE_DST}.tmp.$$"
  install -m 0755 "$RUFF_BRIDGE_SRC" "$tmp"
  mv -f "$tmp" "$RUFF_BRIDGE_DST"
}

install_model_abi_compiler() {
  test -x "$MODEL_ABI_COMPILER_SRC" || {
    echo "FAIL Model ABI compiler build missing: $MODEL_ABI_COMPILER_SRC" >&2
    return 1
  }
  mkdir -p "$(dirname "$MODEL_ABI_COMPILER_DST")"
  local tmp="${MODEL_ABI_COMPILER_DST}.tmp.$$"
  install -m 0755 "$MODEL_ABI_COMPILER_SRC" "$tmp"
  mv -f "$tmp" "$MODEL_ABI_COMPILER_DST"
}

check_ruff_bridge() {
  test -x "$RUFF_BRIDGE_DST" || {
    echo "FAIL Ruff bridge missing: $RUFF_BRIDGE_DST" >&2
    return 1
  }
  cmp -s "$RUFF_BRIDGE_SRC" "$RUFF_BRIDGE_DST" || {
    echo "FAIL Ruff bridge drift: $RUFF_BRIDGE_REL" >&2
    sha256sum "$RUFF_BRIDGE_SRC" "$RUFF_BRIDGE_DST" || true
    return 1
  }
}

check_model_abi_compiler() {
  test -x "$MODEL_ABI_COMPILER_DST" || {
    echo "FAIL Model ABI compiler missing: $MODEL_ABI_COMPILER_DST" >&2
    return 1
  }
  cmp -s "$MODEL_ABI_COMPILER_SRC" "$MODEL_ABI_COMPILER_DST" || {
    echo "FAIL Model ABI compiler drift: $MODEL_ABI_COMPILER_REL" >&2
    sha256sum "$MODEL_ABI_COMPILER_SRC" "$MODEL_ABI_COMPILER_DST" || true
    return 1
  }
}

install_one() {
  local rel="$1" src="$ROOT/opencode/plugins/$1" dst="$DEST/$1" tmp
  mkdir -p "$(dirname "$dst")"
  tmp="${dst}.tmp.$$"
  local mode="0644"
  [[ "$rel" == *.py ]] && mode="0755"
  install -m "$mode" "$src" "$tmp"
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
    build_ruff_bridge
    install_ruff_bridge
    build_model_abi_compiler
    install_model_abi_compiler
    for rel in "${FILES[@]}"; do install_one "$rel"; done
    ;;
  check) ;;
  *) echo "usage: $0 [install|check] [plugins-dir]" >&2; exit 2 ;;
esac

for rel in "${FILES[@]}"; do check_one "$rel"; done
check_ruff_bridge
check_model_abi_compiler
echo "PASS plugin-stack-v1 exact files=${#FILES[@]} dest=$DEST"
