#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[preflight] repo root: $ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "[fatal] git not found"
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[fatal] not a git repo"
  exit 2
fi

fail=0

echo
printf '%s\n' "[check] forbidden tracked paths"
forbidden_regex='(^|/)(\.env$|\.env\..*\.local$|\.secrets/|data/|output/|node_modules/|\.npm-cache/|.*\.(db|sqlite|sqlite3|pem|key|p12|pfx)$)'
tracked_forbidden="$(git ls-files | grep -E "$forbidden_regex" || true)"
if [[ -n "$tracked_forbidden" ]]; then
  echo "[FAIL] Found forbidden tracked files/paths:"
  echo "$tracked_forbidden"
  fail=1
else
  echo "[ok] no forbidden tracked files"
fi

echo
printf '%s\n' "[check] high-risk secret patterns in tracked files"
# prefer low false positives: detect concrete secret-looking values
secret_regex='(BEGIN (RSA|EC|OPENSSH)? ?PRIVATE KEY|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,}|mnemonic\s*[:=]\s*"?[a-z]+( [a-z]+){8,}|(api|secret|token|private)[_-]?(key|token|secret)?\s*[:=]\s*["\x27][A-Za-z0-9_\-]{24,}["\x27])'
secret_hits_raw="$(git grep -nEI "$secret_regex" -- . ':!*.md' ':!.env.example' || true)"

# reduce known false positives from safe function calls (non-literal values)
secret_hits="$(printf '%s\n' "$secret_hits_raw" | grep -Ev 'resolveHmacSecretForSigning\(auth\)' || true)"

if [[ -n "$secret_hits" ]]; then
  echo "[WARN] Potential secret values found (review manually):"
  echo "$secret_hits"
  fail=1
else
  echo "[ok] no obvious secret values in tracked files"
fi

echo
printf '%s\n' "[check] working tree contains uncommitted sensitive files"
untracked_sensitive="$(git status --porcelain | awk '{print $2}' | grep -E "$forbidden_regex" || true)"
if [[ -n "$untracked_sensitive" ]]; then
  echo "[WARN] Sensitive paths present in working tree (ignored is fine, but verify before add):"
  echo "$untracked_sensitive"
else
  echo "[ok] no sensitive paths detected in working tree changes"
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "[PASS] privacy preflight passed"
  exit 0
fi

echo "[BLOCK] privacy preflight failed; fix above items before pushing to GitHub"
exit 1
