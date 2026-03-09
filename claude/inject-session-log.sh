#!/usr/bin/env bash
# UserPromptSubmit hook: re-orients the orchestrator each turn.
# Injects session context via additionalContext (discrete — not shown in chat UI).
# The session log is the durable store, re-read fresh each turn.
# Auto-sync via Stop hook keeps it current; may lag 1-2 turns.
set -euo pipefail

HOOK_INPUT=$(cat 2>/dev/null || echo "{}")

# Block cf fork commands from reaching Claude — launch cf as side effect
PROMPT=$(echo "$HOOK_INPUT" | jq -r '.prompt // empty' 2>/dev/null || true)
if [[ "$PROMPT" =~ ^cf[[:space:]] ]] || [[ "$PROMPT" =~ ^!cf[[:space:]] ]]; then
    CMD="${PROMPT#!}"
    bash -c "$CMD" &>/dev/null &
    jq -n '{"decision":"block","reason":"cf fork launched"}'
    exit 0
fi

# Todo commands — handled silently, Claude never sees them
SESSION_ID_FOR_TODOS=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
TODOS_FILE="$HOME/.claude/session-logs/${SESSION_ID_FOR_TODOS}.todos.json"

_todos_init() {
    if [ ! -f "$TODOS_FILE" ]; then
        echo '{"next_id":1,"active":[],"completed":[],"cancelled":[]}' > "$TODOS_FILE"
    fi
}

_todos_block() {
    jq -n --arg msg "$1" '{"decision":"block","reason":$msg}'
    exit 0
}

# todo-add 'name' or todo-add 'name' 'description'
if [[ "$PROMPT" =~ ^todo-add[[:space:]]+(.*) ]]; then
    _todos_init
    REST="${BASH_REMATCH[1]}"
    # Parse: first quoted-or-unquoted token = name, remainder = description
    NAME=$(echo "$REST" | sed "s/^['\"]//; s/['\"].*$//" | awk '{print $0}' | head -1)
    # Simpler: just treat the whole thing as the name
    NAME="${REST#\'}" ; NAME="${NAME%\'}" ; NAME="${NAME#\"}" ; NAME="${NAME%\"}"
    NOW=$(date -u '+%Y-%m-%d %H:%M UTC')
    NEXT_ID=$(jq '.next_id' "$TODOS_FILE")
    jq --arg name "$NAME" --arg ts "$NOW" --argjson id "$NEXT_ID" \
        '.active += [{"id":$id,"name":$name,"created":$ts}] | .next_id += 1' \
        "$TODOS_FILE" > "${TODOS_FILE}.tmp" && mv "${TODOS_FILE}.tmp" "$TODOS_FILE"
    _todos_block "✓ Added [#${NEXT_ID}]: $NAME"
fi

# todo-list
if [[ "$PROMPT" == "todo-list" ]]; then
    _todos_init
    ACTIVE_COUNT=$(jq '.active | length' "$TODOS_FILE")
    if [ "$ACTIVE_COUNT" -eq 0 ]; then
        _todos_block "No pending todos."
    fi
    MSG=$(jq -r '
        "=== Todos ===\nActive:",
        (.active[] | "  [#\(.id)] \(.name)  (\(.created))"),
        if (.completed | length) > 0 then "\nCompleted:", (.completed[] | "  [#\(.id)] \(.name)") else "" end,
        if (.cancelled | length) > 0 then "\nCancelled:", (.cancelled[] | "  [#\(.id)] \(.name)") else "" end
    ' "$TODOS_FILE" | sed '/^$/d')
    _todos_block "$MSG"
fi

# todo-done <id>
if [[ "$PROMPT" =~ ^todo-done[[:space:]]+([0-9]+) ]]; then
    _todos_init
    ID="${BASH_REMATCH[1]}"
    NOW=$(date -u '+%Y-%m-%d %H:%M UTC')
    NAME=$(jq -r --argjson id "$ID" '.active[] | select(.id==$id) | .name' "$TODOS_FILE")
    if [ -z "$NAME" ]; then _todos_block "No active todo with id #${ID}."; fi
    jq --argjson id "$ID" --arg ts "$NOW" \
        '(.active[] | select(.id==$id)) as $t |
         .completed += [$t + {"completed":$ts}] |
         .active = [.active[] | select(.id!=$id)]' \
        "$TODOS_FILE" > "${TODOS_FILE}.tmp" && mv "${TODOS_FILE}.tmp" "$TODOS_FILE"
    _todos_block "✓ Done [#${ID}]: $NAME"
fi

# todo-cancel <id>
if [[ "$PROMPT" =~ ^todo-cancel[[:space:]]+([0-9]+) ]]; then
    _todos_init
    ID="${BASH_REMATCH[1]}"
    NOW=$(date -u '+%Y-%m-%d %H:%M UTC')
    NAME=$(jq -r --argjson id "$ID" '.active[] | select(.id==$id) | .name' "$TODOS_FILE")
    if [ -z "$NAME" ]; then _todos_block "No active todo with id #${ID}."; fi
    jq --argjson id "$ID" --arg ts "$NOW" \
        '(.active[] | select(.id==$id)) as $t |
         .cancelled += [$t + {"cancelled":$ts}] |
         .active = [.active[] | select(.id!=$id)]' \
        "$TODOS_FILE" > "${TODOS_FILE}.tmp" && mv "${TODOS_FILE}.tmp" "$TODOS_FILE"
    _todos_block "✗ Cancelled [#${ID}]: $NAME"
fi

# todo-delete <id>
if [[ "$PROMPT" =~ ^todo-delete[[:space:]]+([0-9]+) ]]; then
    _todos_init
    ID="${BASH_REMATCH[1]}"
    NAME=$(jq -r --argjson id "$ID" '(.active[],.completed[],.cancelled[]) | select(.id==$id) | .name' "$TODOS_FILE" | head -1)
    if [ -z "$NAME" ]; then _todos_block "No todo with id #${ID}."; fi
    jq --argjson id "$ID" \
        '.active = [.active[] | select(.id!=$id)] |
         .completed = [.completed[] | select(.id!=$id)] |
         .cancelled = [.cancelled[] | select(.id!=$id)]' \
        "$TODOS_FILE" > "${TODOS_FILE}.tmp" && mv "${TODOS_FILE}.tmp" "$TODOS_FILE"
    _todos_block "Deleted [#${ID}]: $NAME"
fi

# Always derive session log from session_id — env var is collision-prone across instances
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
SESSION_LOG="$HOME/.claude/session-logs/${SESSION_ID}.md"

# Nothing to inject if no log found
if [ -z "$SESSION_LOG" ] || [ ! -f "$SESSION_LOG" ]; then
    exit 0
fi

# Extract session name from first line (# Session: <name>)
SESSION_NAME=$(head -1 "$SESSION_LOG" | sed 's/^# Session: //')

# Parse Event Log rows (skip header rows)
EVENT_LOG=$(awk '/^## Event Log/{found=1; next} found && /^## /{exit} found && /^\|/{print}' "$SESSION_LOG" | grep -v '^| Time' | grep -v '^|----' || true)

# Current goal = last GOAL_SET row's Details field (match column 3 exactly)
GOAL_ROW=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*GOAL_SET[[:space:]]*$/{line=$0} END{print line}' || true)
CURRENT_GOAL=$(echo "$GOAL_ROW" | awk -F'|' '{print $4}' | sed 's/ *| *Exit:.*//' | xargs || true)

# Exit criteria = last GOAL_SET row, everything after "Exit:"
EXIT_CRITERIA=$(echo "$GOAL_ROW" | grep -o 'Exit:.*' | sed 's/^Exit: //' | sed 's/ *|[[:space:]]*$//' | xargs || true)

# Check if goal is populated
if [ -z "$CURRENT_GOAL" ]; then
    jq -n --arg msg "[Session log not yet populated: ${SESSION_LOG}]
You MUST add a GOAL_SET event to the Event Log before proceeding." \
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$msg}}'
    exit 0
fi

# Active subagents: SUBAGENT_STARTED ids with no matching SUBAGENT_COMPLETED
STARTED_IDS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*SUBAGENT_STARTED[[:space:]]*$/{
    f=$4
    if (match(f, /id=[^ ]+/)) {
        s=substr(f, RSTART+3, RLENGTH-3)
        print s
    }
}' || true)

COMPLETED_IDS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*SUBAGENT_COMPLETED[[:space:]]*$/{
    f=$4
    if (match(f, /id=[^ ]+/)) {
        s=substr(f, RSTART+3, RLENGTH-3)
        print s
    }
}' || true)

ACTIVE_SUBAGENTS_ROWS=""
while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    if ! echo "$COMPLETED_IDS" | grep -qxF "$sid"; then
        # Find the matching STARTED row for details
        ROW=$(echo "$EVENT_LOG" | awk -F'|' -v id="$sid" '$3 ~ /^[[:space:]]*SUBAGENT_STARTED[[:space:]]*$/ && $4 ~ id {print}' | head -1 || true)
        ACTIVE_SUBAGENTS_ROWS="${ACTIVE_SUBAGENTS_ROWS}${ROW}"$'\n'
    fi
done <<< "$STARTED_IDS"

if [ -n "$(echo "$ACTIVE_SUBAGENTS_ROWS" | sed '/^$/d')" ]; then
    ACTIVE_SUBAGENTS="| Time | Type | Details |
|------|------|---------|
${ACTIVE_SUBAGENTS_ROWS}"
else
    ACTIVE_SUBAGENTS="None"
fi

# Active teams: TEAM_CREATED names with no matching TEAM_COMPLETED
CREATED_TEAMS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*TEAM_CREATED[[:space:]]*$/{
    f=$4
    if (match(f, /team=[^ ]+/)) {
        s=substr(f, RSTART+5, RLENGTH-5)
        print s
    }
}' || true)

COMPLETED_TEAMS=$(echo "$EVENT_LOG" | awk -F'|' '$3 ~ /^[[:space:]]*TEAM_COMPLETED[[:space:]]*$/{
    f=$4
    if (match(f, /team=[^ ]+/)) {
        s=substr(f, RSTART+5, RLENGTH-5)
        print s
    }
}' || true)

ACTIVE_TEAMS_ROWS=""
while IFS= read -r tname; do
    [ -z "$tname" ] && continue
    if ! echo "$COMPLETED_TEAMS" | grep -qxF "$tname"; then
        ROW=$(echo "$EVENT_LOG" | awk -F'|' -v t="$tname" '$3 ~ /^[[:space:]]*TEAM_CREATED[[:space:]]*$/ && $4 ~ t {print}' | head -1 || true)
        ACTIVE_TEAMS_ROWS="${ACTIVE_TEAMS_ROWS}${ROW}"$'\n'
    fi
done <<< "$CREATED_TEAMS"

if [ -n "$(echo "$ACTIVE_TEAMS_ROWS" | sed '/^$/d')" ]; then
    ACTIVE_TEAMS="| Time | Type | Details |
|------|------|---------|
${ACTIVE_TEAMS_ROWS}"
else
    ACTIVE_TEAMS="None"
fi

# Extract last auto-sync metadata if present
LAST_SYNC=$(grep '^- Last auto-sync:' "$SESSION_LOG" | tail -1 | sed 's/^- Last auto-sync: //' || true)
if [ -n "$LAST_SYNC" ]; then
    SYNC_NOTE="Last auto-sync: ${LAST_SYNC}. This log is updated automatically after each turn and may lag 1-2 turns."
else
    SYNC_NOTE="This log may lag 1-2 turns (auto-sync pending)."
fi

# --- Delta injection state tracking ---
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
TURN_COUNTER_FILE="/tmp/session-log-inject-${SESSION_ID}.turn"
STATE_FILE="/tmp/session-log-inject-${SESSION_ID}.state"

TURN=$(cat "$TURN_COUNTER_FILE" 2>/dev/null || echo 0)
TURN=$((TURN + 1))
echo "$TURN" > "$TURN_COUNTER_FILE"

LAST_SEEN=$(cat "$STATE_FILE" 2>/dev/null || echo 0)

# Count current event rows (table data rows only, not header/separator)
TOTAL_ROWS=$(echo "$EVENT_LOG" | grep -c '^\|' || echo 0)

# Determine if this is a full-view turn
FULL_VIEW=false
if [ "$TURN" -eq 1 ] || [ $((TURN % 10)) -eq 0 ] || ([ "$TURN" -gt 1 ] && [ "$LAST_SEEN" -eq 0 ]); then
    FULL_VIEW=true
fi

if [ "$FULL_VIEW" = true ]; then
    # Full view: show last 20 event rows
    RECENT_EVENTS=$(echo "$EVENT_LOG" | tail -20 || true)

    CONTEXT="=== ORCHESTRATOR CONTEXT (full) ===
Session: ${SESSION_NAME} | Log: ${SESSION_LOG}
${SYNC_NOTE}

## Current Goal
${CURRENT_GOAL}

## Exit Criteria
${EXIT_CRITERIA}

## Active Subagents
${ACTIVE_SUBAGENTS}

## Active Teams
${ACTIVE_TEAMS}

## Event Log (last 20)
${RECENT_EVENTS}

REMINDER: You are the ORCHESTRATOR. You coordinate — you do not implement.
- ALWAYS spawn a subagent or team for: reading files, running commands, writing/editing code, searching, debugging, research, analysis
- Use a SUBAGENT for single-pass tasks (one step, returns a result)
- Use an AGENT TEAM MEMBER for multi-step sequential work, pipelines, or anything with dependent phases
- NEVER plan in main context — planning goes to a team member
- NEVER pull team results into context automatically — notify user and ask first
- NEVER shut down a team without confirming with the user first
=== END ORCHESTRATOR CONTEXT ==="

    echo "$TOTAL_ROWS" > "$STATE_FILE"

    jq -n --arg ctx "$CONTEXT" \
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'

else
    # Delta view: show only new events since last injection
    NEW_ROWS=$(echo "$EVENT_LOG" | tail -n +$((LAST_SEEN + 1)) || true)
    NEW_ROWS_TRIMMED=$(echo "$NEW_ROWS" | sed '/^[[:space:]]*$/d' || true)

    echo "$TOTAL_ROWS" > "$STATE_FILE"

    if [ -z "$NEW_ROWS_TRIMMED" ]; then
        # No new events — output nothing (exit silently)
        exit 0
    fi

    CONTEXT="=== SESSION UPDATE ===
${NEW_ROWS_TRIMMED}
=== END UPDATE ==="

    jq -n --arg ctx "$CONTEXT" \
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
fi

exit 0
