#!/usr/bin/env bash
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$REPO/rust/evidence-distiller"
CARGO="$CRATE/Cargo.toml"
RELEASE="$CRATE/target/release"

DEST="${OPENCODE_RUNTIME_DIR:-$HOME/.local/libexec/opencode-cpu-agent}"
PARENT="$(dirname "$DEST")"
RUNTIME_MANIFEST=".runtime-stack-v1.json"

COMPONENTS=(
  opencode-patch-compiler
  opencode-patch-executor
  opencode-invariant-verifier
  opencode-impact-index
)

build_stack() {
  cargo build \
    --manifest-path "$CARGO" \
    --release \
    --bin opencode-patch-compiler \
    --bin opencode-patch-executor \
    --bin opencode-invariant-verifier \
    --bin opencode-impact-index
}

write_manifest() {
  local root="$1"
  local git_head

  git_head="$(git -C "$REPO" rev-parse HEAD)"

  python3 - "$root" "$git_head" "${COMPONENTS[@]}" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
git_head = sys.argv[2]
components = sys.argv[3:]

manifest = {
    "protocol": "runtime-stack-v1",
    "git_head": git_head,
    "components": {},
}

for name in components:
    path = root / name
    data = path.read_bytes()
    manifest["components"][name] = {
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
    }

(root / ".runtime-stack-v1.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
}

verify_stack() {
  local root="$1"

  python3 - "$root" "$RUNTIME_MANIFEST" "${COMPONENTS[@]}" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest_name = sys.argv[2]
expected = sys.argv[3:]

manifest_path = root / manifest_name
if not manifest_path.is_file():
    raise SystemExit(f"FAIL runtime_manifest_missing path={manifest_path}")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

if manifest.get("protocol") != "runtime-stack-v1":
    raise SystemExit("FAIL runtime_manifest_protocol")

components = manifest.get("components")
if not isinstance(components, dict):
    raise SystemExit("FAIL runtime_manifest_components")

for name in expected:
    path = root / name

    if not path.is_file():
        raise SystemExit(f"FAIL runtime_binary_missing component={name}")

    if not os.access(path, os.X_OK):
        raise SystemExit(f"FAIL runtime_binary_not_executable component={name}")

    record = components.get(name)
    if not isinstance(record, dict):
        raise SystemExit(f"FAIL runtime_manifest_component_missing component={name}")

    data = path.read_bytes()
    actual_sha = hashlib.sha256(data).hexdigest()
    actual_bytes = len(data)

    if actual_sha != record.get("sha256"):
        raise SystemExit(
            f"FAIL runtime_binary_hash_mismatch component={name} "
            f"expected={record.get('sha256')} actual={actual_sha}"
        )

    if actual_bytes != record.get("bytes"):
        raise SystemExit(
            f"FAIL runtime_binary_size_mismatch component={name}"
        )

    print(
        f"PASS component={name} "
        f"sha256={actual_sha} bytes={actual_bytes}"
    )

print(
    "PASS runtime_stack "
    f"protocol={manifest['protocol']} "
    f"git_head={manifest.get('git_head')}"
)
PY
}

install_stack() {
  build_stack

  mkdir -p "$PARENT"

  local stage backup
  stage="$(mktemp -d "$PARENT/.opencode-cpu-agent.stage.XXXXXX")"
  backup="$PARENT/.opencode-cpu-agent.previous.$$"

  # Preserve unrelated runtime files already installed in this directory.
  if [[ -d "$DEST" ]]; then
    cp -a "$DEST/." "$stage/"
  fi

  for name in "${COMPONENTS[@]}"; do
    install -m 0755 "$RELEASE/$name" "$stage/$name"
  done

  write_manifest "$stage"
  verify_stack "$stage"

  rollback() {
    local rc=$?

    if [[ -d "$backup" ]]; then
      rm -rf "$DEST"
      mv "$backup" "$DEST"
    fi

    [[ -d "$stage" ]] && rm -rf "$stage"

    echo "FAIL runtime_stack_install_rolled_back rc=$rc" >&2
    exit "$rc"
  }

  trap rollback ERR INT TERM

  rm -rf "$backup"

  if [[ -d "$DEST" ]]; then
    mv "$DEST" "$backup"
  fi

  mv "$stage" "$DEST"

  # Verify the actual installed location, not just staging.
  verify_stack "$DEST"

  rm -rf "$backup"
  trap - ERR INT TERM

  echo "PASS runtime_stack_install destination=$DEST"
}

case "${1:-install}" in
  install)
    install_stack
    ;;
  check)
    verify_stack "$DEST"
    ;;
  build)
    build_stack
    ;;
  *)
    echo "usage: $0 {install|check|build}" >&2
    exit 2
    ;;
esac
