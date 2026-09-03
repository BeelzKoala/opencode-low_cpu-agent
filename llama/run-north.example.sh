#!/usr/bin/env bash
set -euo pipefail

LLAMA_N_PREDICT="${LLAMA_N_PREDICT:-4096}"
LLAMA_REASONING="${LLAMA_REASONING:-off}"
LLAMA_REASONING_BUDGET="${LLAMA_REASONING_BUDGET:-0}"

[[ "$LLAMA_N_PREDICT" =~ ^[1-9][0-9]*$ ]] || {
  echo "STOP: LLAMA_N_PREDICT must be positive integer" >&2
  exit 2
}
[[ "$LLAMA_REASONING_BUDGET" =~ ^[0-9]+$ ]] || {
  echo "STOP: LLAMA_REASONING_BUDGET must be non-negative integer" >&2
  exit 2
}

cd "$HOME/llama.cpp"

exec ./build/bin/llama-server \
  -hf bartowski/North-Mini-Code-1.0-GGUF:Q3_K_L \
  -c 32768 \
  -np 1 \
  -t 8 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --jinja \
  --reasoning "$LLAMA_REASONING" \
  --reasoning-budget "$LLAMA_REASONING_BUDGET" \
  --n-predict "$LLAMA_N_PREDICT" \
  --metrics \
  --alias north-mini-code-local \
  --host 127.0.0.1 \
  --port 8080
