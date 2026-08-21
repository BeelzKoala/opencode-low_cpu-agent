#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/llama.cpp"

exec ./build/bin/llama-server \
  -hf bartowski/North-Mini-Code-1.0-GGUF:Q3_K_L \
  -c 32768 \
  -np 1 \
  -t 8 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --jinja \
  --reasoning off \
  --reasoning-budget 0 \
  --metrics \
  --alias north-mini-code-local \
  --host 127.0.0.1 \
  --port 8080
