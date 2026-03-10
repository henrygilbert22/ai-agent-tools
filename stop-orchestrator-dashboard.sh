#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${SESSION_NAME:-orchestrator-dashboard}"

if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Dashboard tmux session '${SESSION_NAME}' is not running."
  exit 0
fi

tmux kill-session -t "${SESSION_NAME}"
echo "Stopped orchestrator dashboard tmux session '${SESSION_NAME}'."
