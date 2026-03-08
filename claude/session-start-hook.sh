#!/usr/bin/env bash
set -euo pipefail

# Read hook input
HOOK_INPUT=$(cat 2>/dev/null || echo "{}")

# Get session ID
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(date +%Y%m%d_%H%M%S)_$$"
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${PWD:-unknown}}"
LOG_DIR="$HOME/.claude/session-logs"
SESSION_LOG="$LOG_DIR/${SESSION_ID}.md"

mkdir -p "$LOG_DIR"

NOW=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

# Create log only if it doesn't exist (idempotent)
if [ ! -f "$SESSION_LOG" ]; then
    cat > "$SESSION_LOG" << TEMPLATE
# Session: New Session
- Session ID: ${SESSION_ID}
- Created: ${NOW}
- Directory: ${PROJECT_DIR}
- Last auto-sync: (pending)

## Event Log
| Time | Type | Details |
|------|------|---------|
TEMPLATE
fi

# Persist path for UserPromptSubmit hook
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export SESSION_LOG_PATH='${SESSION_LOG}'" >> "$CLAUDE_ENV_FILE"
fi

# Output minimal SessionStart context — full log injected each turn by UserPromptSubmit hook
jq -n \
  --arg path "$SESSION_LOG" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": ("You are the ORCHESTRATOR. Session log: " + $path + "\nFull context will be injected on your first prompt. NEVER use Write on the session log — only Edit to append rows.")
    }
  }'

exit 0
