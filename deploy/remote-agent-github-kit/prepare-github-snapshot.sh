#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_DIR="${1:-$ROOT_DIR/../evohive-github-ready}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "[fatal] rsync not found"
  exit 2
fi

mkdir -p "$TARGET_DIR"

echo "[snapshot] source: $ROOT_DIR"
echo "[snapshot] target: $TARGET_DIR"

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.npm-cache/' \
  --exclude '.env' \
  --exclude '.env.*.local' \
  --exclude '.secrets/' \
  --exclude 'data/' \
  --exclude 'output/' \
  --exclude '*.db' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite3' \
  --exclude '*.pem' \
  --exclude '*.key' \
  --exclude '*.p12' \
  --exclude '*.pfx' \
  "$ROOT_DIR/" "$TARGET_DIR/"

echo "[done] sanitized snapshot generated"
echo "       run privacy preflight inside target before push:"
echo "       cd '$TARGET_DIR' && bash deploy/remote-agent-github-kit/privacy-preflight.sh"
