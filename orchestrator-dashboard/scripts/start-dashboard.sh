#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${PROJECT_DIR}/certs"
ENV_FILE="${PROJECT_DIR}/.env"
ENV_EXAMPLE="${PROJECT_DIR}/.env.example"

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

if [[ ! -f "${CERT_DIR}/cert.pem" || ! -f "${CERT_DIR}/key.pem" ]]; then
  echo "Generating local TLS certificate..."
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

echo "Starting orchestrator dashboard..."
node server.js
