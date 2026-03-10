#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${PROJECT_DIR}/certs"
ENV_FILE="${PROJECT_DIR}/.env"
ENV_EXAMPLE="${PROJECT_DIR}/.env.example"
TAILSCALE_DOMAIN="${TAILSCALE_DOMAIN:-}"

cd "${PROJECT_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}."
  echo "Create it from ${ENV_EXAMPLE} and set OPENAI_API_KEY."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies..."
  npm ci
fi

mkdir -p "${CERT_DIR}" "${PROJECT_DIR}/data/chats"

if [[ -z "${TAILSCALE_DOMAIN}" ]] && command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_DOMAIN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
fi

if [[ -n "${TAILSCALE_DOMAIN}" ]] && command -v tailscale >/dev/null 2>&1; then
  echo "Using Tailscale TLS cert for ${TAILSCALE_DOMAIN}..."
  tailscale cert \
    --cert-file "${CERT_DIR}/cert.pem" \
    --key-file "${CERT_DIR}/key.pem" \
    "${TAILSCALE_DOMAIN}"
  export PUBLIC_URL="${PUBLIC_URL:-https://${TAILSCALE_DOMAIN}:${PORT:-9000}}"
else
  if [[ ! -f "${CERT_DIR}/cert.pem" || ! -f "${CERT_DIR}/key.pem" ]]; then
    echo "Generating local TLS certificate for localhost..."
    openssl req \
      -x509 \
      -newkey rsa:2048 \
      -keyout "${CERT_DIR}/key.pem" \
      -out "${CERT_DIR}/cert.pem" \
      -sha256 \
      -days 365 \
      -nodes \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  fi
fi

echo "Starting orchestrator dashboard..."
node server.js
