#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="${SESSION_NAME:-orchestrator-dashboard}"
RUNNER="${REPO_DIR}/orchestrator-dashboard/scripts/start-dashboard.sh"
ENV_FILE="${REPO_DIR}/orchestrator-dashboard/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PORT="${PORT:-9000}"

if [[ "${1:-}" == "--foreground" ]]; then
  exec "${RUNNER}"
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Dashboard tmux session '${SESSION_NAME}' is already running."
  echo "Use ./status-orchestrator-dashboard.sh for details."
  exit 0
fi

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use. Refusing to start a duplicate dashboard session."
  lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P
  exit 1
fi

tmux new-session -d -s "${SESSION_NAME}" "${RUNNER}"
echo "Started orchestrator dashboard in tmux session '${SESSION_NAME}'."
echo "Use ./status-orchestrator-dashboard.sh to inspect it."
