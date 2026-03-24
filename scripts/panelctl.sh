#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/evohive-panel.pid"
LOG_FILE="/tmp/evohive-panel.log"
ENV_FILE="$ROOT_DIR/.env"

start() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "already running (pid $(cat "$PID_FILE"))"
    exit 0
  fi

  cd "$ROOT_DIR"
  nohup env EVOHIVE_ENV_PATH="$ENV_FILE" npm run -s dev >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  echo "started pid $(cat "$PID_FILE")"
}

stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "not running"
    exit 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    sleep 1
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running pid $(cat "$PID_FILE")"
    curl -s --max-time 2 http://127.0.0.1:4311/health || true
    echo
  else
    echo "stopped"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) status ;;
  logs) tail -n 80 "$LOG_FILE" ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
