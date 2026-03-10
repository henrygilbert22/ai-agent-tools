# AI Agent Tools

A home repo for practical local AI tooling: session memory for Claude Code, and a live orchestration dashboard for managing tmux sessions, processes, artifacts, and rich AI chat from one place.

## Tools

### `claude/`

Persistent session memory and event-log tooling for Claude Code.

- structured append-only session logs
- hook-based context injection
- background state updates via Haiku

Read [claude/README.md](/home/henry/ai-agent-tools/claude/README.md) for setup and architecture.

### `orchestrator-dashboard/`

A mobile-friendly local operator console for your dev machine.

- rich markdown chat with Mermaid rendering
- separate spoken summaries and full text replies
- local persistent, branchable chat history
- tmux capture and guided actions
- grouped process view with attention queue
- Claude log discovery and tailing
- file and diff preview drawers

Start it with:

```bash
cp orchestrator-dashboard/.env.example orchestrator-dashboard/.env
$EDITOR orchestrator-dashboard/.env
./start-orchestrator-dashboard.sh
```

Then open `https://localhost:9000`.

## Repo Layout

```text
claude/                  Claude Code session management system
orchestrator-dashboard/  Local orchestration and management dashboard
start-orchestrator-dashboard.sh
```
