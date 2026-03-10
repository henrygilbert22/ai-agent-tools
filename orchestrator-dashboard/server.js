import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { exec, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';
import https from 'https';
import fetch from 'node-fetch';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

const DATA_DIR = join(__dirname, 'data');
const CHATS_DIR = join(DATA_DIR, 'chats');
const DASHBOARD_STATE_FILE = join(DATA_DIR, 'dashboard-state.json');
const CURRENT_USER = os.userInfo().username;
const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || `https://localhost:${PORT}`;
const CERTS_DIR = join(__dirname, 'certs');

const AI_SYSTEM_PROMPT = `You are Henry's orchestration copilot for a multi-agent development machine.

Your job is to act like an operator-grade AGI for local engineering work:
- explain what is happening across tmux sessions, Claude sessions, processes, and files
- proactively identify blockers, failures, drift, and idle/stuck work
- produce rich markdown for the visual chat: headings, bullets, tables, code fences, and Mermaid when helpful
- use concrete file paths, process names, and session names whenever useful
- prefer structured, actionable answers over terse replies

When you speak for audio playback:
- keep it short, direct, and conversational
- summarize the most important point first
- do not read long logs or code verbatim

When you answer for the on-screen chat:
- be detailed and helpful
- use markdown formatting intentionally
- include short checklists, plans, or diagrams when that improves clarity
- use mermaid fenced blocks for process flows or relationships when useful

You can use the run_bash tool to inspect the machine. Be proactive but safe.`;

const SESSION_CONFIG = {
  model: 'gpt-realtime',
  instructions: AI_SYSTEM_PROMPT,
  tools: [
    {
      type: 'function',
      name: 'run_bash',
      description: 'Run a bash command on the Linux VM',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
        },
        required: ['command'],
      },
    },
  ],
  tool_choice: 'auto',
};

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  if (!fs.existsSync(DASHBOARD_STATE_FILE)) {
    writeJson(DASHBOARD_STATE_FILE, {
      pinnedSessions: [],
      pinnedProcesses: [],
      recentArtifacts: [],
      uiState: {
        activeTab: 'chat',
        selectedChatId: null,
        selectedMessageId: null,
      },
    });
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read JSON from ${filePath}:`, error.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function runCommand(command, { timeout = 8000, cwd } = {}) {
  return new Promise((resolveResult) => {
    exec(command, { timeout, cwd, shell: '/bin/bash', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveResult({
        ok: !error,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error,
      });
    });
  });
}

function chatFile(chatId) {
  return join(CHATS_DIR, `${chatId}.json`);
}

function defaultChat(title = 'Main cockpit') {
  const createdAt = nowIso();
  return {
    id: randomUUID(),
    title,
    createdAt,
    updatedAt: createdAt,
    rootIds: [],
    activeNodeId: null,
    branchMeta: [],
    nodes: {},
  };
}

function ensurePrimaryChat() {
  const chats = listChats();
  if (chats.length > 0) {
    return chats[0];
  }
  const chat = defaultChat();
  writeChat(chat);
  const dashboardState = getDashboardState();
  dashboardState.uiState.selectedChatId = chat.id;
  writeJson(DASHBOARD_STATE_FILE, dashboardState);
  return chat;
}

function listChats() {
  if (!fs.existsSync(CHATS_DIR)) {
    return [];
  }
  return fs.readdirSync(CHATS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(join(CHATS_DIR, file), null))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getChat(chatId) {
  return readJson(chatFile(chatId), null);
}

function writeChat(chat) {
  chat.updatedAt = nowIso();
  writeJson(chatFile(chat.id), chat);
}

function getDashboardState() {
  return readJson(DASHBOARD_STATE_FILE, {
    pinnedSessions: [],
    pinnedProcesses: [],
    recentArtifacts: [],
    uiState: {
      activeTab: 'chat',
      selectedChatId: null,
      selectedMessageId: null,
    },
  });
}

function summarizeChat(chat) {
  const nodeCount = Object.keys(chat.nodes || {}).length;
  const latestNode = chat.activeNodeId ? chat.nodes?.[chat.activeNodeId] : null;
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    nodeCount,
    activeNodeId: chat.activeNodeId,
    latestPreview: latestNode?.displayMarkdown?.slice(0, 160) || latestNode?.text?.slice(0, 160) || '',
  };
}

function buildPathToNode(chat, nodeId) {
  const path = [];
  let currentId = nodeId;
  const seen = new Set();
  while (currentId && chat.nodes[currentId] && !seen.has(currentId)) {
    seen.add(currentId);
    path.unshift(currentId);
    currentId = chat.nodes[currentId].parentId || null;
  }
  return path;
}

async function listClaudeSessions() {
  const logsDir = '/home/henry/.claude/session-logs';
  try {
    if (!fs.existsSync(logsDir)) {
      return [];
    }
    return fs.readdirSync(logsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const path = join(logsDir, file);
        const content = fs.readFileSync(path, 'utf8').slice(0, 2000);
        const goalMatch = content.match(/Goal[:\s]+(.+)/i);
        return {
          id: file.replace('.md', ''),
          shortId: file.replace('.md', '').slice(0, 8),
          path,
          goal: goalMatch ? goalMatch[1].trim() : 'No goal set',
          updatedAt: fs.statSync(path).mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 12);
  } catch (error) {
    console.error('Failed to list Claude sessions:', error.message);
    return [];
  }
}

async function listTmuxPanes() {
  const result = await runCommand(
    "tmux list-panes -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'",
  );
  if (!result.ok || !result.stdout) {
    return [];
  }
  return result.stdout.split('\n').map((line) => {
    const [sessionName, windowIndex, windowName, paneId, panePid, currentCommand, currentPath] = line.split('\t');
    return {
      sessionName,
      windowIndex: Number(windowIndex),
      windowName,
      paneId,
      panePid: Number(panePid),
      currentCommand,
      currentPath,
    };
  });
}

async function listTmuxSessions() {
  const panes = await listTmuxPanes();
  const bySession = new Map();
  for (const pane of panes) {
    if (!bySession.has(pane.sessionName)) {
      bySession.set(pane.sessionName, {
        name: pane.sessionName,
        windows: [],
        preview: '',
      });
    }
    bySession.get(pane.sessionName).windows.push({
      index: pane.windowIndex,
      name: pane.windowName,
      paneId: pane.paneId,
      panePid: pane.panePid,
      currentCommand: pane.currentCommand,
      currentPath: pane.currentPath,
    });
  }

  const sessions = [];
  for (const session of bySession.values()) {
    const capture = await runCommand(`tmux capture-pane -t ${JSON.stringify(session.name)} -p -S -8`);
    session.preview = capture.stdout;
    sessions.push(session);
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
}

function buildProcessTree(rows) {
  const childrenByPid = new Map();
  for (const row of rows) {
    if (!childrenByPid.has(row.ppid)) {
      childrenByPid.set(row.ppid, []);
    }
    childrenByPid.get(row.ppid).push(row.pid);
  }
  const descendantsByPid = new Map();

  function walk(pid) {
    if (descendantsByPid.has(pid)) {
      return descendantsByPid.get(pid);
    }
    const result = new Set([pid]);
    for (const childPid of childrenByPid.get(pid) || []) {
      for (const nested of walk(childPid)) {
        result.add(nested);
      }
    }
    descendantsByPid.set(pid, result);
    return result;
  }

  for (const row of rows) {
    walk(row.pid);
  }
  return descendantsByPid;
}

function inferPurpose(command) {
  if (command.includes('claude')) return 'Claude session';
  if (command.includes('server.js')) return 'Node service';
  if (command.includes('python')) return 'Python worker';
  if (command.includes('bazel')) return 'Bazel job';
  if (command.includes('npm ') || command.includes('pnpm ') || command.includes('yarn ')) return 'Frontend/dev task';
  if (command.includes('tmux')) return 'Tmux shell';
  return 'Process';
}

async function getProcessSnapshot() {
  const psResult = await runCommand(`ps -u ${JSON.stringify(CURRENT_USER)} -o pid=,ppid=,tty=,etimes=,%cpu=,%mem=,command=`);
  if (!psResult.ok || !psResult.stdout) {
    return { generatedAt: nowIso(), groups: [], attention: [] };
  }

  const tmuxPanes = await listTmuxPanes();
  const claudeSessions = await listClaudeSessions();
  const rows = psResult.stdout.split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      elapsedSec: Number(match[4]),
      cpu: Number(match[5]),
      mem: Number(match[6]),
      command: match[7],
    };
  }).filter(Boolean);

  const descendantsByPid = buildProcessTree(rows);
  const tmuxByPid = new Map();
  for (const pane of tmuxPanes) {
    for (const pid of descendantsByPid.get(pane.panePid) || new Set()) {
      tmuxByPid.set(pid, pane);
    }
  }

  const claudeIds = claudeSessions.map((session) => session.shortId);
  const groups = {
    tmux: [],
    claude: [],
    service: [],
    other: [],
  };

  for (const row of rows) {
    const tmuxOwner = tmuxByPid.get(row.pid);
    const claudeOwner = claudeIds.find((id) => row.command.includes(id) || row.command.includes('claude'));
    const item = {
      id: `${row.pid}`,
      pid: row.pid,
      ppid: row.ppid,
      tty: row.tty,
      elapsedSec: row.elapsedSec,
      cpu: row.cpu,
      mem: row.mem,
      command: row.command,
      purpose: inferPurpose(row.command),
      owner: tmuxOwner ? `tmux:${tmuxOwner.sessionName}` : (claudeOwner ? `claude:${claudeOwner}` : 'system'),
      sessionName: tmuxOwner?.sessionName || null,
      path: tmuxOwner?.currentPath || null,
    };

    if (tmuxOwner) {
      groups.tmux.push(item);
    } else if (claudeOwner) {
      groups.claude.push(item);
    } else if (
      row.command.includes('node') ||
      row.command.includes('python') ||
      row.command.includes('vite') ||
      row.command.includes('next') ||
      row.command.includes('webpack')
    ) {
      groups.service.push(item);
    } else {
      groups.other.push(item);
    }
  }

  const attention = Object.values(groups)
    .flat()
    .filter((item) => item.cpu > 20 || item.elapsedSec > 60 * 60 * 4)
    .sort((a, b) => b.cpu - a.cpu || b.elapsedSec - a.elapsedSec)
    .slice(0, 8)
    .map((item) => ({
      pid: item.pid,
      owner: item.owner,
      label: item.command.slice(0, 120),
      reason: item.cpu > 20 ? `High CPU ${item.cpu}%` : `Long running ${Math.round(item.elapsedSec / 3600)}h`,
    }));

  return {
    generatedAt: nowIso(),
    groups: Object.entries(groups).map(([key, items]) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      count: items.length,
      items: items.sort((a, b) => b.cpu - a.cpu || b.elapsedSec - a.elapsedSec),
    })),
    attention,
  };
}

async function getArtifactFile(pathQuery, startLine = 1, endLine = 220) {
  const absolutePath = resolve(pathQuery);
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error('Path is not a file');
  }
  const content = fs.readFileSync(absolutePath, 'utf8').split('\n');
  const start = Math.max(1, Number(startLine || 1));
  const end = Math.max(start, Math.min(content.length, Number(endLine || 220)));
  return {
    path: absolutePath,
    startLine: start,
    endLine: end,
    lines: content.slice(start - 1, end).map((text, index) => ({
      lineNumber: start + index,
      text,
    })),
  };
}

async function getArtifactDiff(pathQuery) {
  const absolutePath = resolve(pathQuery);
  const dir = dirname(absolutePath);
  const repoRootResult = await runCommand('git rev-parse --show-toplevel', { cwd: dir });
  if (!repoRootResult.ok || !repoRootResult.stdout) {
    throw new Error('File is not inside a git repository');
  }
  const repoRoot = repoRootResult.stdout;
  const diffResult = await runCommand(`git diff --no-ext-diff -- ${JSON.stringify(absolutePath)}`, { cwd: repoRoot, timeout: 15000 });
  return {
    repoRoot,
    path: absolutePath,
    diff: diffResult.stdout,
  };
}

function normalizeSessionTokenResponse(data) {
  return data.client_secret
    ? data
    : { client_secret: { value: data.value, expires_at: data.expires_at }, ...data };
}

function extractResponsesText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

function findLatestSessionLog() {
  const logDir = '/home/henry/.claude/session-logs';
  try {
    const files = fs.readdirSync(logDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const fullPath = join(logDir, file);
        return {
          path: fullPath,
          mtime: fs.statSync(fullPath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path || null;
  } catch (error) {
    console.error('Error finding session log:', error.message);
    return null;
  }
}

ensureDataDirs();
ensurePrimaryChat();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname, {
  etag: false,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  },
}));

app.get('/token', async (req, res) => {
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: { type: 'realtime', ...SESSION_CONFIG } }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI token error:', response.status, errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = normalizeSessionTokenResponse(await response.json());
    res.json({ ...data, session_config: SESSION_CONFIG });
  } catch (error) {
    console.error('Token endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/sessions', async (req, res) => {
  const [tmux, claude] = await Promise.all([listTmuxSessions(), listClaudeSessions()]);
  res.json({
    tmux: tmux.map((session) => ({
      name: session.name,
      preview: session.preview,
      windows: session.windows.length,
    })),
    claude: claude.map((session) => ({
      id: session.shortId,
      path: session.path,
      goal: session.goal.slice(0, 120),
    })),
  });
});

app.post('/tmux/send', async (req, res) => {
  const { session, text } = req.body || {};
  if (!session || !text) {
    return res.status(400).json({ error: 'session and text required' });
  }
  const result = await runCommand(`tmux send-keys -t ${JSON.stringify(session)} ${JSON.stringify(text)} Enter`);
  if (!result.ok) {
    return res.status(500).json({ error: result.stderr || result.error?.message || 'Failed to send keys' });
  }
  res.json({ ok: true });
});

app.get('/api/bootstrap', async (req, res) => {
  const [sessions, claudeSessions, processes] = await Promise.all([
    listTmuxSessions(),
    listClaudeSessions(),
    getProcessSnapshot(),
  ]);
  const dashboardState = getDashboardState();
  const chats = listChats().map(summarizeChat);
  if (!dashboardState.uiState.selectedChatId && chats[0]) {
    dashboardState.uiState.selectedChatId = chats[0].id;
    writeJson(DASHBOARD_STATE_FILE, dashboardState);
  }
  res.json({
    dashboardState,
    chats,
    sessions: {
      tmux: sessions,
      claude: claudeSessions,
    },
    processes,
    model: SESSION_CONFIG.model,
  });
});

app.get('/api/dashboard/state', (req, res) => {
  res.json(getDashboardState());
});

app.put('/api/dashboard/state', (req, res) => {
  const nextState = {
    ...getDashboardState(),
    ...(req.body || {}),
    uiState: {
      ...getDashboardState().uiState,
      ...(req.body?.uiState || {}),
    },
  };
  writeJson(DASHBOARD_STATE_FILE, nextState);
  res.json(nextState);
});

app.get('/api/chats', (req, res) => {
  res.json(listChats().map(summarizeChat));
});

app.post('/api/chats', (req, res) => {
  const chat = defaultChat(req.body?.title || 'New branch');
  writeChat(chat);
  const dashboardState = getDashboardState();
  dashboardState.uiState.selectedChatId = chat.id;
  writeJson(DASHBOARD_STATE_FILE, dashboardState);
  res.status(201).json(chat);
});

app.get('/api/chats/:chatId', (req, res) => {
  const chat = getChat(req.params.chatId);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  res.json({
    ...chat,
    activePath: buildPathToNode(chat, chat.activeNodeId),
  });
});

app.put('/api/chats/:chatId', (req, res) => {
  const chat = getChat(req.params.chatId);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  const nextChat = {
    ...chat,
    ...req.body,
    id: chat.id,
    createdAt: chat.createdAt,
  };
  writeChat(nextChat);
  res.json(nextChat);
});

app.post('/api/chats/:chatId/messages', (req, res) => {
  const chat = getChat(req.params.chatId);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }

  const parentId = req.body?.parentId || null;
  if (parentId && !chat.nodes[parentId]) {
    return res.status(400).json({ error: 'Parent node not found' });
  }

  const node = {
    id: randomUUID(),
    parentId,
    children: [],
    role: req.body?.role || 'assistant',
    createdAt: nowIso(),
    status: req.body?.status || 'done',
    text: req.body?.text || '',
    displayMarkdown: req.body?.displayMarkdown || '',
    spokenSummary: req.body?.spokenSummary || '',
    artifacts: Array.isArray(req.body?.artifacts) ? req.body.artifacts : [],
    sessionRefs: Array.isArray(req.body?.sessionRefs) ? req.body.sessionRefs : [],
    processRefs: Array.isArray(req.body?.processRefs) ? req.body.processRefs : [],
    branchLabel: req.body?.branchLabel || '',
  };

  chat.nodes[node.id] = node;
  if (parentId) {
    chat.nodes[parentId].children.push(node.id);
  } else {
    chat.rootIds.push(node.id);
  }
  chat.activeNodeId = node.id;
  writeChat(chat);
  res.status(201).json({
    ...node,
    activePath: buildPathToNode(chat, node.id),
  });
});

app.patch('/api/chats/:chatId/messages/:messageId', (req, res) => {
  const chat = getChat(req.params.chatId);
  if (!chat || !chat.nodes[req.params.messageId]) {
    return res.status(404).json({ error: 'Message not found' });
  }
  chat.nodes[req.params.messageId] = {
    ...chat.nodes[req.params.messageId],
    ...req.body,
    id: req.params.messageId,
  };
  chat.activeNodeId = req.params.messageId;
  writeChat(chat);
  res.json(chat.nodes[req.params.messageId]);
});

app.post('/api/chats/:chatId/branches', (req, res) => {
  const chat = getChat(req.params.chatId);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  const fromMessageId = req.body?.fromMessageId;
  if (!fromMessageId || !chat.nodes[fromMessageId]) {
    return res.status(400).json({ error: 'fromMessageId is required and must exist' });
  }
  const branch = {
    id: randomUUID(),
    fromMessageId,
    title: req.body?.title || 'Branch',
    createdAt: nowIso(),
  };
  chat.branchMeta.push(branch);
  chat.activeNodeId = fromMessageId;
  writeChat(chat);
  res.status(201).json(branch);
});

app.get('/api/processes', async (req, res) => {
  res.json(await getProcessSnapshot());
});

app.post('/api/text-reply', async (req, res) => {
  try {
    const prompt = req.body?.prompt?.trim();
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const contextSummary = req.body?.contextSummary || '';
    const voiceSummary = req.body?.voiceSummary || '';
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: `${AI_SYSTEM_PROMPT}

You are generating the on-screen rich markdown answer for the orchestration dashboard.
- Use markdown intentionally.
- Prefer concrete action-oriented summaries.
- Use tables, checklists, and mermaid when useful.
- Do not be terse unless the prompt asks for it.
- If a voice summary is provided, expand it into a more complete visible answer rather than repeating it verbatim.`,
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `User prompt:
${prompt}

Known machine context:
${contextSummary || 'No extra machine context provided.'}

Audio/voice summary so far:
${voiceSummary || 'None.'}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Text reply error:', response.status, errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json({
      model: TEXT_MODEL,
      markdown: extractResponsesText(data),
      raw: data,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tmux/:session/capture', async (req, res) => {
  const lines = Number(req.query.lines || 120);
  const result = await runCommand(`tmux capture-pane -t ${JSON.stringify(req.params.session)} -p -S -${lines}`);
  if (!result.ok) {
    return res.status(500).json({ error: result.stderr || 'Failed to capture tmux pane' });
  }
  res.json({
    session: req.params.session,
    lines,
    text: result.stdout,
  });
});

app.post('/api/tmux/:session/action', async (req, res) => {
  const session = req.params.session;
  const action = req.body?.action;
  let command = '';
  if (action === 'send_keys') {
    command = `tmux send-keys -t ${JSON.stringify(session)} ${JSON.stringify(req.body?.text || '')} Enter`;
  } else if (action === 'interrupt') {
    command = `tmux send-keys -t ${JSON.stringify(session)} C-c`;
  } else if (action === 'clear') {
    command = `tmux send-keys -t ${JSON.stringify(session)} clear Enter`;
  } else {
    return res.status(400).json({ error: 'Unsupported tmux action' });
  }

  const result = await runCommand(command);
  if (!result.ok) {
    return res.status(500).json({ error: result.stderr || 'Failed to execute tmux action' });
  }
  res.json({ ok: true, action, session });
});

app.get('/api/artifacts/file', async (req, res) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    res.json(await getArtifactFile(req.query.path, req.query.startLine, req.query.endLine));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/artifacts/diff', async (req, res) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    res.json(await getArtifactDiff(req.query.path));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const certPath = join(CERTS_DIR, 'cert.pem');
const keyPath = join(CERTS_DIR, 'key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('Missing TLS certs. Run ./scripts/start-dashboard.sh to generate local certs automatically.');
  process.exit(1);
}

const sslOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath),
};
const httpsServer = https.createServer(sslOptions, app);
httpsServer.listen(PORT, HOST, () => {
  console.log(`HTTPS server listening on ${HOST}:${PORT}`);
  console.log(`URL: ${PUBLIC_URL}`);
});

const wss = new WebSocketServer({ server: httpsServer, path: '/ws' });

console.log('WSS server attached to HTTPS server at /ws');

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  let tailProcess = null;

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error('Invalid WS message:', error.message);
      return;
    }

    if (message.type === 'run_bash') {
      const { command, call_id: callId } = message;
      exec(command, { timeout: 30000, shell: '/bin/bash', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        let output = (stdout || '').trim();
        let errorText = null;
        if (error) {
          errorText = (stderr || error.message || 'Command failed').trim();
          if (!output && stderr) {
            output = stderr.trim();
            errorText = null;
          }
        }

        if (output.length > 8000) {
          output = `${output.slice(0, 8000)}\n... (truncated)`;
        }
        if (errorText && errorText.length > 8000) {
          errorText = `${errorText.slice(0, 8000)}\n... (truncated)`;
        }

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'bash_result',
            call_id: callId,
            output,
            error: errorText,
          }));
        }
      });
      return;
    }

    if (message.type === 'subscribe_logs') {
      const requestedPath = message.path;
      const logPath = requestedPath && fs.existsSync(requestedPath) ? requestedPath : findLatestSessionLog();
      if (!logPath) {
        ws.send(JSON.stringify({ type: 'log_line', text: '[No session logs found]' }));
        return;
      }

      console.log(`Tailing log: ${logPath}`);
      ws.send(JSON.stringify({ type: 'log_line', text: `[Tailing: ${logPath}]` }));
      tailProcess = spawn('tail', ['-f', '-n', '60', logPath]);

      tailProcess.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (line && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'log_line', text: line }));
          }
        }
      });

      tailProcess.stderr.on('data', (chunk) => {
        console.error('tail stderr:', chunk.toString());
      });

      tailProcess.on('close', (code) => {
        console.log(`tail process exited with code ${code}`);
      });
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (tailProcess) {
      tailProcess.kill();
      tailProcess = null;
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    if (tailProcess) {
      tailProcess.kill();
      tailProcess = null;
    }
  });
});
