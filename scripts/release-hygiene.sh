#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

LOCAL_PATTERNS_FILE=".git/info/release-hygiene-patterns"

fail=0

section() {
  printf '\n=== %s ===\n' "$1"
}

section "DIFF HYGIENE"

git diff --check
git diff --cached --check

echo "PASS diff whitespace"

section "PRIVATE / LOCAL IDENTIFIERS"

if [[ -s "$LOCAL_PATTERNS_FILE" ]]; then
  mapfile -t patterns < <(
    grep -vE '^[[:space:]]*(#|$)' \
      "$LOCAL_PATTERNS_FILE"
  )

  for pattern in "${patterns[@]}"; do
    [[ -n "$pattern" ]] || continue

    if git grep -nF -- "$pattern"; then
      echo "FAIL tracked private identifier"
      fail=1
    fi

    if git diff --cached --no-ext-diff --text \
      | grep -nF -- "$pattern"
    then
      echo "FAIL staged private identifier"
      fail=1
    fi
  done

  [[ "$fail" -ne 0 ]] \
    || echo "PASS private/local identifiers absent"
else
  echo "WARN no local privacy patterns configured:"
  echo "     $LOCAL_PATTERNS_FILE"
fi

section "HIGH-SIGNAL SECRET MATERIAL"

secret_re='-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}'

if git grep -nE "$secret_re"; then
  echo "FAIL high-signal secret material found"
  fail=1
else
  echo "PASS no high-signal tracked secrets"
fi

section "JUNK / BACKUP FILES"

junk="$(
  find . \
    -type f \
    \( \
      -name '*.bak' \
      -o -name '*.orig' \
      -o -name '*.rej' \
      -o -name '*.tmp' \
      -o -name '*.pre-*' \
      -o -name '*~' \
    \) \
    -not -path './.git/*' \
    -print
)"

if [[ -n "$junk" ]]; then
  printf '%s\n' "$junk"
  echo "FAIL junk files present"
  fail=1
else
  echo "PASS junk files absent"
fi

section "TRACKED RUNTIME ARTIFACTS"

tracked_artifacts="$(
  git ls-files \
    | grep -Ei \
      '(^|/)\.opencode/|(^|/)(tmp|temp)/|search-trace|semantic-engine-shootout.*\.json$' \
    || true
)"

if [[ -n "$tracked_artifacts" ]]; then
  printf '%s\n' "$tracked_artifacts"
  echo "FAIL runtime/generated artifacts tracked"
  fail=1
else
  echo "PASS runtime/generated artifacts absent"
fi

section "STAGED FILES"

git diff --cached --name-status || true

section "STATUS"

git status --short

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "FAIL release hygiene"
  exit 1
fi

echo
echo "PASS release hygiene"
