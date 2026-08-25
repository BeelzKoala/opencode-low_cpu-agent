#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" config core.hooksPath .githooks
echo "PASS core.hooksPath=.githooks"
echo "NOTE hooks are advisory; --no-verify bypasses them. ./ci is authoritative."
