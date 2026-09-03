#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  echo "STOP restart-qualified-runtime: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  restart-qualified-runtime.sh \
    --restart-script PATH \
    [--base-url URL] \
    [--model MODEL]

Environment defaults:
  OPENCODE_CPU_MODEL_CONTEXT_COMPILER=active
  OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES=2200
  OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES=1800
  OPENCODE_CPU_LLGUIDANCE_MODE=auto
EOF
  exit 2
}

SCRIPT_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd -P
)"
ROOT="$(
  cd -- "$SCRIPT_DIR/.."
  pwd -P
)"

RESTART_SCRIPT=""
BASE_URL="http://127.0.0.1:8080"
MODEL="north-mini-code-local"

while (($#)); do
  case "$1" in
    --restart-script)
      (($# >= 2)) || usage
      RESTART_SCRIPT="$2"
      shift 2
      ;;
    --base-url)
      (($# >= 2)) || usage
      BASE_URL="$2"
      shift 2
      ;;
    --model)
      (($# >= 2)) || usage
      MODEL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$RESTART_SCRIPT" ]] \
  || die "--restart-script is required"

[[ -f "$RESTART_SCRIPT" ]] \
  || die "restart script missing: $RESTART_SCRIPT"

[[ -x "$RESTART_SCRIPT" ]] \
  || die "restart script is not executable: $RESTART_SCRIPT"

QUALIFIER="$ROOT/scripts/qualify-llguidance-runtime.py"

[[ -f "$QUALIFIER" ]] \
  || die "LLGuidance qualifier missing: $QUALIFIER"

command -v curl >/dev/null \
  || die "curl unavailable"

command -v python3 >/dev/null \
  || die "python3 unavailable"

export OPENCODE_CPU_MODEL_CONTEXT_COMPILER="${OPENCODE_CPU_MODEL_CONTEXT_COMPILER:-active}"
export OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES="${OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES:-2200}"
export OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES="${OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES:-1800}"
export OPENCODE_CPU_LLGUIDANCE_MODE="${OPENCODE_CPU_LLGUIDANCE_MODE:-auto}"

echo "=== KOALIK RUNTIME POLICY ==="
printf '%s=%s\n' \
  OPENCODE_CPU_MODEL_CONTEXT_COMPILER \
  "$OPENCODE_CPU_MODEL_CONTEXT_COMPILER"
printf '%s=%s\n' \
  OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES \
  "$OPENCODE_CPU_MODEL_CONTEXT_MAX_BYTES"
printf '%s=%s\n' \
  OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES \
  "$OPENCODE_CPU_REPAIR_CONTEXT_MAX_BYTES"
printf '%s=%s\n' \
  OPENCODE_CPU_LLGUIDANCE_MODE \
  "$OPENCODE_CPU_LLGUIDANCE_MODE"

echo
echo "=== COLD RESTART ==="
"$RESTART_SCRIPT"

echo
echo "=== HEALTH ==="
curl -fsS \
  --max-time 3 \
  "$BASE_URL/health" \
  >/dev/null \
  || die "llama health failed"

echo "PASS llama health"

echo
echo "=== QUIESCENCE ==="

METRICS="$(
  curl -fsS \
    --max-time 3 \
    "$BASE_URL/metrics"
)" || die "metrics unavailable"

processing="$(
  awk '
    $1 == "llamacpp:requests_processing" {
      print $2
      found = 1
    }
    END {
      if (!found) exit 1
    }
  ' <<<"$METRICS"
)" || die "requests_processing metric missing"

deferred="$(
  awk '
    $1 == "llamacpp:requests_deferred" {
      print $2
      found = 1
    }
    END {
      if (!found) exit 1
    }
  ' <<<"$METRICS"
)" || die "requests_deferred metric missing"

[[ "$processing" == "0" ]] \
  || die "runtime not quiescent: requests_processing=$processing"

[[ "$deferred" == "0" ]] \
  || die "runtime not quiescent: requests_deferred=$deferred"

echo "llamacpp:requests_processing $processing"
echo "llamacpp:requests_deferred $deferred"
echo "PASS llama quiescent"

echo
echo "=== LLGUIDANCE LIVE-PROCESS ATTESTATION ==="

python3 "$QUALIFIER" \
  --base-url "$BASE_URL" \
  --model "$MODEL"

echo
echo "=== RESULT ==="
echo "PASS qualified runtime restart"
echo "base_url=$BASE_URL"
echo "model=$MODEL"
echo "llguidance_re_attested=true"
echo "runtime_quiescent=true"
