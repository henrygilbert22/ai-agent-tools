#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="${SESSION_NAME:-orchestrator-dashboard}"
RUNNER="${REPO_DIR}/orchestrator-dashboard/scripts/start-dashboard.sh"
ENV_FILE="${REPO_DIR}/orchestrator-dashboard/.env"
FORCE=0

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PORT="${PORT:-9000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground)
      exec "${RUNNER}"
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: ./start-orchestrator-dashboard.sh [--force] [--foreground]"
      exit 1
      ;;
  esac
done

if [[ "${FORCE}" -eq 1 ]] && tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Stopping existing tmux session '${SESSION_NAME}' before restart..."
  tmux kill-session -t "${SESSION_NAME}"
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Dashboard tmux session '${SESSION_NAME}' is already running."
  echo "Use ./status-orchestrator-dashboard.sh for details."
  exit 0
fi

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  if [[ "${FORCE}" -eq 1 ]]; then
    echo "Port ${PORT} is in use. Killing current listener(s) because --force was set..."
    lsof -tiTCP:"${PORT}" -sTCP:LISTEN | xargs -r kill
    sleep 1
  else
    echo "Port ${PORT} is already in use. Refusing to start a duplicate dashboard session."
    echo "Use --force to kill the existing listener and replace it."
    lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P
    exit 1
  fi
fi

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port ${PORT} is still occupied after start preflight."
  lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P
  exit 1
fi

tmux new-session -d -s "${SESSION_NAME}" "${RUNNER}"
echo "Started orchestrator dashboard in tmux session '${SESSION_NAME}'."
echo "Use ./status-orchestrator-dashboard.sh to inspect it."
