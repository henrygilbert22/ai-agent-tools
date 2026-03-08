#!/usr/bin/env bash
# Stop hook: async session log auto-update via Haiku API
# Runs after each Claude turn. All errors are silently ignored.

set -uo pipefail

# ── Read stdin ──────────────────────────────────────────────────────────────
HOOK_INPUT=$(cat 2>/dev/null || echo "{}")

# If stop_hook_active is true, exit immediately to prevent infinite loops
STOP_HOOK_ACTIVE=$(echo "$HOOK_INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# ── Require API key ─────────────────────────────────────────────────────────
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    exit 0
fi

# ── Parse hook input ─────────────────────────────────────────────────────────
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
LAST_ASSISTANT_MSG=$(echo "$HOOK_INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null || true)

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

# ── Locate session log — always use session_id, never the env var ───────────
# SESSION_LOG_PATH env var is collision-prone (appended across sessions).
# session_id from stdin is always correct for the current instance.
LOG_DIR="$HOME/.claude/session-logs"
SESSION_LOG="$LOG_DIR/${SESSION_ID}.md"

if [ ! -f "$SESSION_LOG" ]; then
    exit 0
fi

# ── Lock to prevent concurrent updates ──────────────────────────────────────
LOCK_FILE="/tmp/session-log-update-${SESSION_ID}.lock"

_do_update() {
    # ── Read last 4 full exchanges from transcript ────────────────────────────
    RECENT_EXCHANGES=""
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
        RECENT_EXCHANGES=$(tail -n 200 "$TRANSCRIPT_PATH" 2>/dev/null | \
            jq -r 'select(.type == "user" or .type == "assistant") |
                if .type == "user" then
                    "USER: " + (if (.message.content | type) == "array"
                        then [.message.content[] | select(.type == "text") | .text] | join(" ")
                        else (.message.content // "") end)
                else
                    "ASSISTANT: " + (if (.message.content | type) == "array"
                        then [.message.content[] | select(.type == "text") | .text] | join(" ")
                        else (.message.content // "") end)
                end' 2>/dev/null | \
            tail -n 50 | tail -c 6000 || true)
    fi

    # Fall back to last_assistant_message if transcript parse yielded nothing
    if [ -z "$RECENT_EXCHANGES" ] && [ -n "$LAST_ASSISTANT_MSG" ]; then
        RECENT_EXCHANGES="ASSISTANT: ${LAST_ASSISTANT_MSG}"
    fi

    # ── Read current session log ─────────────────────────────────────────────
    CURRENT_LOG=$(cat "$SESSION_LOG" 2>/dev/null || true)
    if [ -z "$CURRENT_LOG" ]; then
        exit 0
    fi

    # Derive structured state from Event Log (same view Claude gets)
    EVENT_LOG=$(awk '/^## Event Log/{found=1; next} found && /^## /{exit} found && /^\|/{print}' "$SESSION_LOG" | grep -v '^| Time' | grep -v '^|----' || true)

    # Current goal + exit criteria from last GOAL_SET
    GOAL_ROW=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*GOAL_SET[[:space:]]*$/{line=$0} END{print line}' || true)
    CURRENT_GOAL=$(echo "$GOAL_ROW" | awk -F'|' '{print $4}' | sed 's/ *| *Exit:.*//' | xargs || true)
    EXIT_CRITERIA=$(echo "$GOAL_ROW" | grep -o 'Exit:.*' | sed 's/^Exit: //' | sed 's/ *|[[:space:]]*$//' | xargs || true)

    # Active subagents: STARTED ids without matching COMPLETED
    STARTED_IDS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*SUBAGENT_STARTED[[:space:]]*$/{
        f=$4; if (match(f, /id=[^ ]+/)) { print substr(f, RSTART+3, RLENGTH-3) }
    }' || true)
    COMPLETED_IDS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*SUBAGENT_COMPLETED[[:space:]]*$/{
        f=$4; if (match(f, /id=[^ ]+/)) { print substr(f, RSTART+3, RLENGTH-3) }
    }' || true)
    ACTIVE_SUBS=""
    while IFS= read -r sid; do
        [ -z "$sid" ] && continue
        if ! echo "$COMPLETED_IDS" | grep -qF "$sid"; then
            ROW=$(echo "$EVENT_LOG" | awk -F'|' -v id="$sid" '$3 ~ /^[[:space:]]*SUBAGENT_STARTED[[:space:]]*$/ && $4 ~ id {print}' | head -1 || true)
            ACTIVE_SUBS="${ACTIVE_SUBS}${ROW}"$'\n'
        fi
    done <<< "$STARTED_IDS"
    [ -z "$(echo "$ACTIVE_SUBS" | sed '/^$/d')" ] && ACTIVE_SUBS="None"

    # Last 10 event rows
    LAST_10_EVENTS=$(echo "$EVENT_LOG" | tail -10 || true)

    # ── Read CLAUDE.md for orchestrator context (cached by Haiku) ────────────
    CLAUDE_MD=$(cat "$HOME/.claude/CLAUDE.md" 2>/dev/null || true)

    NOW_UTC=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
    NOW_TIME=$(date -u '+%H:%M')

    # ── Build Haiku API request ──────────────────────────────────────────────
    # System prompt is static = gets prompt-cached across turns
    SYSTEM_PROMPT="You are the async session log tracker for an AI orchestration system. You run after each orchestrator turn and emit structured JSON events to append to the session log.

The main Claude model operates as an ORCHESTRATOR with these rules:
${CLAUDE_MD}

Your ONLY job is to analyze the recent conversation and return a JSON object describing what events occurred.

Event schema — return a JSON object with an \"events\" array:
{
  \"events\": [
    {\"type\": \"GOAL_SET\", \"goal\": \"...\", \"exit_criteria\": \"...\"},
    {\"type\": \"SESSION_RENAMED\", \"name\": \"...\"},
    {\"type\": \"SUBAGENT_STARTED\", \"id\": \"...\", \"name\": \"...\", \"task\": \"...\"},
    {\"type\": \"SUBAGENT_UPDATED\", \"id\": \"...\", \"update\": \"...\"},
    {\"type\": \"SUBAGENT_COMPLETED\", \"id\": \"...\", \"outcome\": \"...\"},
    {\"type\": \"TEAM_CREATED\", \"team\": \"...\", \"members\": \"...\", \"purpose\": \"...\"},
    {\"type\": \"TEAM_UPDATED\", \"team\": \"...\", \"update\": \"...\"},
    {\"type\": \"TEAM_COMPLETED\", \"team\": \"...\", \"outcome\": \"...\"},
    {\"type\": \"NOTE\", \"text\": \"...\"}
  ]
}

Valid type enum values: GOAL_SET, SESSION_RENAMED, SUBAGENT_STARTED, SUBAGENT_UPDATED, SUBAGENT_COMPLETED, TEAM_CREATED, TEAM_UPDATED, TEAM_COMPLETED, NOTE

Output rules:
- Return ONLY valid JSON matching the schema above — no preamble, no markdown, no code fences
- events array may be empty if nothing meaningful happened: {\"events\": []}
- GOAL_SET and SESSION_RENAMED: ONLY when the USER explicitly states a new goal or renames the session. Never infer these from the assistant's description of what it is doing. The assistant explains work; the user sets direction.
- SUBAGENT_*/TEAM_*: emit when the ASSISTANT spawns, updates, or closes subagents/teams.
- NOTE: significant facts only — not filler, not status confirmations, not generic observations.
- Raw JSON only — no preamble, no commentary, no code fences."

    USER_PROMPT="Current session state:

<current_goal>${CURRENT_GOAL}</current_goal>
<exit_criteria>${EXIT_CRITERIA}</exit_criteria>
<active_subagents>
${ACTIVE_SUBS}
</active_subagents>
<last_10_events>
${LAST_10_EVENTS}
</last_10_events>

Last conversation exchanges:
<recent_conversation>
${RECENT_EXCHANGES}
</recent_conversation>

Return a JSON object with an events array. Return {\"events\": []} if nothing meaningful happened or if the event was already recorded in last_10_events."

    # Escape for JSON
    SYSTEM_JSON=$(printf '%s' "$SYSTEM_PROMPT" | jq -Rs .)
    USER_JSON=$(printf '%s' "$USER_PROMPT" | jq -Rs .)

    REQUEST_BODY=$(jq -n \
        --argjson system "$SYSTEM_JSON" \
        --argjson user "$USER_JSON" \
        '{
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 500,
            "system": [{"type": "text", "text": $system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": $user}]
        }')

    # ── Call the API ─────────────────────────────────────────────────────────
    RESPONSE=$(curl -s --max-time 30 \
        -X POST "https://api.anthropic.com/v1/messages" \
        -H "x-api-key: ${ANTHROPIC_API_KEY}" \
        -H "anthropic-version: 2023-06-01" \
        -H "content-type: application/json" \
        -d "$REQUEST_BODY" 2>/dev/null || true)

    if [ -z "$RESPONSE" ]; then
        exit 0
    fi

    # Extract text content from response, strip markdown code fences if present
    NEW_ROWS=$(echo "$RESPONSE" | jq -r '.content[0].text // empty' 2>/dev/null || true)
    NEW_ROWS=$(echo "$NEW_ROWS" | sed 's/^```[a-z]*//; s/^```//' | sed '/^```$/d' || true)

    # Validate it's JSON with an events array
    if ! echo "$NEW_ROWS" | jq -e '.events' >/dev/null 2>&1; then
        exit 0  # Invalid response, skip silently
    fi

    # ── Parse events array and append each as a table row ────────────────────
    EVENT_COUNT=$(echo "$NEW_ROWS" | jq '.events | length' 2>/dev/null || echo 0)
    if [ "$EVENT_COUNT" -eq 0 ] 2>/dev/null; then
        # Update timestamp only
        sed -i "s/^- Last auto-sync:.*$/- Last auto-sync: ${NOW_UTC}/" "$SESSION_LOG"
        exit 0
    fi

    echo "$NEW_ROWS" | jq -r --arg time "$NOW_TIME" '.events[] |
        if .type == "GOAL_SET" then
            "| " + $time + " | GOAL_SET | " + .goal + " | Exit: " + .exit_criteria + " |"
        elif .type == "SESSION_RENAMED" then
            "| " + $time + " | SESSION_RENAMED | New name: " + .name + " |"
        elif .type == "SUBAGENT_STARTED" then
            "| " + $time + " | SUBAGENT_STARTED | id=" + .id + " name=" + .name + " task=\"" + .task + "\" |"
        elif .type == "SUBAGENT_UPDATED" then
            "| " + $time + " | SUBAGENT_UPDATED | id=" + .id + " update=\"" + .update + "\" |"
        elif .type == "SUBAGENT_COMPLETED" then
            "| " + $time + " | SUBAGENT_COMPLETED | id=" + .id + " outcome=\"" + .outcome + "\" |"
        elif .type == "TEAM_CREATED" then
            "| " + $time + " | TEAM_CREATED | team=" + .team + " members=\"" + .members + "\" purpose=\"" + .purpose + "\" |"
        elif .type == "TEAM_UPDATED" then
            "| " + $time + " | TEAM_UPDATED | team=" + .team + " update=\"" + .update + "\" |"
        elif .type == "TEAM_COMPLETED" then
            "| " + $time + " | TEAM_COMPLETED | team=" + .team + " outcome=\"" + .outcome + "\" |"
        elif .type == "NOTE" then
            "| " + $time + " | NOTE | " + .text + " |"
        else empty end' 2>/dev/null >> "$SESSION_LOG" || true

    # ── Update Last auto-sync line ────────────────────────────────────────────
    sed -i "s/^- Last auto-sync:.*$/- Last auto-sync: ${NOW_UTC}/" "$SESSION_LOG"
}

# Use flock if available, otherwise run without locking
if command -v flock >/dev/null 2>&1; then
    (
        flock -n 9 || exit 0
        _do_update
    ) 9>"$LOCK_FILE"
else
    # No flock: skip if lock file is recent (within 30s)
    if [ -f "$LOCK_FILE" ]; then
        LOCK_AGE=$(( $(date +%s) - $(date -r "$LOCK_FILE" +%s 2>/dev/null || echo 0) ))
        if [ "$LOCK_AGE" -lt 30 ]; then
            exit 0
        fi
    fi
    touch "$LOCK_FILE"
    _do_update
    rm -f "$LOCK_FILE"
fi

exit 0
