#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK_PATH="$ROOT_DIR/.git/hooks/pre-commit"

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  echo "[fatal] $ROOT_DIR is not a git repository"
  exit 2
fi

cat > "$HOOK_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

bash deploy/remote-agent-github-kit/privacy-preflight.sh
EOF

chmod +x "$HOOK_PATH"

echo "[ok] pre-commit hook installed: $HOOK_PATH"
echo "     it will run privacy-preflight before each commit"
