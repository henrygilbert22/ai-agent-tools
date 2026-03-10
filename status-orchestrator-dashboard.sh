#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="${SESSION_NAME:-orchestrator-dashboard}"
ENV_FILE="${REPO_DIR}/orchestrator-dashboard/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PORT="${PORT:-9000}"
PUBLIC_URL="${PUBLIC_URL:-}"
TAILSCALE_DOMAIN="${TAILSCALE_DOMAIN:-}"

if [[ -z "${TAILSCALE_DOMAIN}" ]] && command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_DOMAIN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
fi

if [[ -z "${PUBLIC_URL}" && -n "${TAILSCALE_DOMAIN}" ]]; then
  PUBLIC_URL="https://${TAILSCALE_DOMAIN}:${PORT}"
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "Dashboard status: running"
  echo "tmux session: ${SESSION_NAME}"
  if [[ -n "${PUBLIC_URL}" ]]; then
    echo "url: ${PUBLIC_URL}"
  fi
  echo
  echo "Recent output:"
  tmux capture-pane -t "${SESSION_NAME}" -p -S -20
  exit 0
fi

echo "Dashboard status: stopped"
echo "tmux session: ${SESSION_NAME}"
if [[ -n "${PUBLIC_URL}" ]]; then
  echo "url: ${PUBLIC_URL}"
fi
if lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo
  echo "Port ${PORT} is currently occupied by:"
  lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P
fi
