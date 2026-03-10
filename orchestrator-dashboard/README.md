# Orchestrator Dashboard

A local operator console for running an AI-driven development machine. It combines rich chat, tmux control, Claude session visibility, process inspection, artifact previews, and persistent branching chat history in one mobile-friendly dashboard. The default startup flow is Tailscale-first so phone access and browser audio work cleanly.

## What It Does

- Rich markdown chat with collapsible assistant turns and Mermaid rendering
- Separate spoken summaries and full on-screen answers
- Local chat persistence with branchable conversation history
- Tmux session capture and guided actions
- Process board with attribution, attention queue, and quick ask/details actions
- Claude session log discovery and live tailing
- File and diff previews from local artifacts
- Phone-friendly layout with Chat, Control, Processes, and Map tabs

## Requirements

- Node.js 20+
- `tmux`
- `openssl`
- `jq`
- An `OPENAI_API_KEY`

## Quick Start

From the repo root:

```bash
cp orchestrator-dashboard/.env.example orchestrator-dashboard/.env
$EDITOR orchestrator-dashboard/.env
./start-orchestrator-dashboard.sh
```

Then open the printed URL. On this machine, the preferred path is:

```text
https://henry-1.taile5ac.ts.net:9000
```

The first launch will:

1. install npm dependencies if needed
2. try to fetch a trusted Tailscale TLS cert for the current device hostname
3. fall back to a local `localhost` self-signed cert if Tailscale certs are unavailable
4. create local persistence files under `orchestrator-dashboard/data/`

## Environment

`orchestrator-dashboard/.env` supports:

```bash
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-4o-mini
PORT=9000
HOST=0.0.0.0
PUBLIC_URL=
TAILSCALE_DOMAIN=
```

If `TAILSCALE_DOMAIN` is empty, the start script will try to detect it automatically from `tailscale status --json`.

## Project Layout

```text
orchestrator-dashboard/
  app/
    main.js
    styles.css
  data/
  scripts/
    start-dashboard.sh
  index.html
  package.json
  server.js
```

## Notes

- Runtime state, local certs, `node_modules`, and `.env` are intentionally gitignored.
- Voice mode uses OpenAI Realtime; rich display answers use the Responses API.
- The dashboard inspects local tmux sessions, processes, and Claude logs directly on the machine where it runs.
