import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

const state = {
  bootstrap: null,
  chats: [],
  currentChat: null,
  activeTab: 'chat',
  selectedNodeId: null,
  expandedMessages: new Set(),
  drawerOpen: false,
  logLines: [],
  logExpanded: false,
  mode: 'text',
  autoSpeak: false,
  connectionState: 'disconnected',
  ws: null,
  pc: null,
  dc: null,
  remoteAudio: null,
  pendingUserText: null,
  pendingTurn: null,
  streamingMessageId: null,
  detailedResponseInFlight: false,
  currentLogPath: null,
  selectedChatId: null,
  branchCounter: 1,
};

const dom = {
  heroTitle: document.getElementById('hero-title'),
  heroSubtitle: document.getElementById('hero-subtitle'),
  heroMetrics: document.getElementById('hero-metrics'),
  statusStrip: document.getElementById('status-strip'),
  chatTitle: document.getElementById('chat-title'),
  chatFeed: document.getElementById('chat-feed'),
  chatBreadcrumbs: document.getElementById('chat-breadcrumbs'),
  quickActions: document.getElementById('quick-actions'),
  tmuxList: document.getElementById('tmux-list'),
  claudeList: document.getElementById('claude-list'),
  attentionQueue: document.getElementById('attention-queue'),
  processGroups: document.getElementById('process-groups'),
  mapSummary: document.getElementById('map-summary'),
  branchTree: document.getElementById('branch-tree'),
  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerKicker: document.getElementById('drawer-kicker'),
  drawerBody: document.getElementById('drawer-body'),
  drawerCloseBtn: document.getElementById('drawer-close-btn'),
  drawerDismissBtn: document.getElementById('drawer-dismiss-btn'),
  chatPickerBtn: document.getElementById('chat-picker-btn'),
  newChatBtn: document.getElementById('new-chat-btn'),
  branchBtn: document.getElementById('branch-btn'),
  toggleLogBtn: document.getElementById('toggle-log-btn'),
  sessionLog: document.getElementById('session-log'),
  connectionPill: document.getElementById('connection-pill'),
  connectBtn: document.getElementById('connect-btn'),
  modeVoice: document.getElementById('mode-voice'),
  modeText: document.getElementById('mode-text'),
  composerInput: document.getElementById('composer-input'),
  sendBtn: document.getElementById('send-btn'),
  speakToggleBtn: document.getElementById('speak-toggle-btn'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  panels: Array.from(document.querySelectorAll('.panel')),
  remoteAudio: document.getElementById('remote-audio'),
};

marked.setOptions({
  breaks: true,
  gfm: true,
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '0m';
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function plainText(value = '') {
  return value.replace(/```[\s\S]*?```/g, '').replace(/[#>*_\-`]/g, '').trim();
}

function summarizeText(value = '') {
  const cleaned = plainText(value);
  if (!cleaned) return '';
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0];
  return firstSentence.slice(0, 220);
}

function currentNodePath(chat = state.currentChat, nodeId = state.selectedNodeId || state.currentChat?.activeNodeId) {
  if (!chat || !nodeId || !chat.nodes[nodeId]) return [];
  const path = [];
  let currentId = nodeId;
  const seen = new Set();
  while (currentId && chat.nodes[currentId] && !seen.has(currentId)) {
    seen.add(currentId);
    path.unshift(chat.nodes[currentId]);
    currentId = chat.nodes[currentId].parentId;
  }
  return path;
}

async function loadBootstrap() {
  state.bootstrap = await fetchJson('/api/bootstrap');
  state.chats = state.bootstrap.chats;
  state.activeTab = state.bootstrap.dashboardState?.uiState?.activeTab || 'chat';
  state.selectedChatId = state.bootstrap.dashboardState?.uiState?.selectedChatId || state.chats[0]?.id || null;
  if (!state.selectedChatId && state.chats[0]) {
    state.selectedChatId = state.chats[0].id;
  }
  if (state.selectedChatId) {
    await loadChat(state.selectedChatId);
  }
  renderAll();
}

async function loadChat(chatId) {
  const chat = await fetchJson(`/api/chats/${chatId}`);
  state.currentChat = chat;
  state.selectedChatId = chat.id;
  state.selectedNodeId = chat.activeNodeId;
  await persistUiState();
}

async function persistUiState() {
  await fetchJson('/api/dashboard/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uiState: {
        activeTab: state.activeTab,
        selectedChatId: state.selectedChatId,
        selectedMessageId: state.selectedNodeId,
      },
    }),
  }).catch(() => {});
}

function renderAll() {
  renderShell();
  renderChat();
  renderControl();
  renderProcesses();
  renderMap();
}

function renderShell() {
  const tmuxCount = state.bootstrap?.sessions?.tmux?.length || 0;
  const claudeCount = state.bootstrap?.sessions?.claude?.length || 0;
  const attentionCount = state.bootstrap?.processes?.attention?.length || 0;
  dom.heroTitle.textContent = `${tmuxCount} tmux sessions, ${claudeCount} Claude sessions, ${attentionCount} things to watch`;
  dom.heroSubtitle.textContent = 'Use the chat to reason about the machine, then jump straight into sessions, processes, files, and diffs.';
  dom.heroMetrics.innerHTML = '';

  const metricData = [
    { label: 'Chats', value: `${state.chats.length}` },
    { label: 'Processes', value: `${state.bootstrap?.processes?.groups?.reduce((sum, group) => sum + group.count, 0) || 0}` },
    { label: 'Pinned', value: `${state.bootstrap?.dashboardState?.pinnedSessions?.length || 0}` },
    { label: 'Model', value: state.bootstrap?.model || 'gpt-realtime' },
  ];
  for (const metric of metricData) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    card.innerHTML = `<div class="value">${escapeHtml(metric.value)}</div><div class="label">${escapeHtml(metric.label)}</div>`;
    dom.heroMetrics.appendChild(card);
  }

  const attention = state.bootstrap?.processes?.attention || [];
  const cards = [
    {
      value: state.connectionState === 'connected' ? 'Live' : 'Idle',
      label: 'Realtime link',
    },
    {
      value: attention[0]?.reason || 'Quiet',
      label: attention[0]?.label?.slice(0, 36) || 'Attention queue',
    },
    {
      value: `${tmuxCount}`,
      label: 'Tmux workspaces',
    },
  ];
  dom.statusStrip.innerHTML = cards.map((card) => `<div class="status-card"><div class="value">${escapeHtml(card.value)}</div><div class="label">${escapeHtml(card.label)}</div></div>`).join('');

  dom.connectionPill.textContent = state.connectionState === 'connected'
    ? 'Connected'
    : state.connectionState === 'connecting'
      ? 'Connecting'
      : state.connectionState === 'error'
        ? 'Error'
        : 'Disconnected';
  dom.connectionPill.className = `connection-pill ${state.connectionState}`;
  dom.connectBtn.textContent = state.connectionState === 'connected' ? 'Disconnect' : 'Connect';
  dom.modeText.classList.toggle('active', state.mode === 'text');
  dom.modeVoice.classList.toggle('active', state.mode === 'voice');
  dom.speakToggleBtn.classList.toggle('active', state.autoSpeak);
  dom.speakToggleBtn.textContent = state.autoSpeak ? 'Speaking text replies' : 'Speak text replies';
  dom.drawerCloseBtn.classList.toggle('hidden', !state.drawerOpen);

  for (const panel of dom.panels) {
    panel.classList.toggle('visible', panel.dataset.panel === state.activeTab);
  }
  for (const tab of dom.tabs) {
    tab.classList.toggle('active', tab.dataset.tab === state.activeTab);
  }
}

function renderChat() {
  if (!state.currentChat) return;
  dom.chatTitle.textContent = state.currentChat.title;
  const path = currentNodePath();
  dom.chatBreadcrumbs.innerHTML = '';
  for (const node of path) {
    const button = document.createElement('button');
    button.className = `chip ${node.id === (state.selectedNodeId || state.currentChat.activeNodeId) ? 'active' : ''}`;
    button.textContent = `${node.role} · ${plainText(node.text || node.displayMarkdown || 'turn').slice(0, 28)}`;
    button.addEventListener('click', () => {
      state.selectedNodeId = node.id;
      renderChat();
      renderMap();
      persistUiState();
    });
    dom.chatBreadcrumbs.appendChild(button);
  }

  dom.chatFeed.innerHTML = '';
  if (path.length === 0) {
    dom.chatFeed.innerHTML = '<div class="message-card system-card"><p>No turns yet. Start with a question about the machine.</p></div>';
    return;
  }

  for (const node of path) {
    dom.chatFeed.appendChild(renderMessageCard(node));
  }
  dom.chatFeed.scrollTop = dom.chatFeed.scrollHeight;
}

function renderMessageCard(node) {
  const card = document.createElement('article');
  card.className = `message-card ${node.role === 'user' ? 'user' : 'assistant'}`;
  const shouldCollapse = !state.expandedMessages.has(node.id) && plainText(node.displayMarkdown || node.text || '').length > 260;
  const spoken = node.spokenSummary ? `<div class="spoken-summary">${escapeHtml(node.spokenSummary)}</div>` : '';
  const bodyHtml = node.role === 'assistant'
    ? renderMarkdown(node.displayMarkdown || node.text || (node.status === 'streaming' ? '_Thinking…_' : ''))
    : `<p>${escapeHtml(node.text || node.displayMarkdown || '')}</p>`;
  const artifacts = (node.artifacts || []).map((artifact) => (
    `<button class="chip" data-artifact-type="${escapeHtml(artifact.type)}" data-artifact-path="${escapeHtml(artifact.path || '')}" data-artifact-label="${escapeHtml(artifact.label || artifact.title || artifact.type)}">${escapeHtml(artifact.label || artifact.title || artifact.type)}</button>`
  )).join('');

  card.innerHTML = `
    <div class="message-meta">
      <span class="role">${escapeHtml(node.role)}</span>
      <span class="mini-label">${new Date(node.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
    ${spoken}
    <div class="body ${shouldCollapse ? 'collapsed' : ''}">${bodyHtml}</div>
    <div class="message-actions">
      ${node.role === 'assistant' && node.spokenSummary ? '<button class="pill-btn" data-action="speak">Speak</button>' : ''}
      ${node.role === 'assistant' && plainText(node.displayMarkdown || '').length > 260 ? `<button class="pill-btn" data-action="expand">${shouldCollapse ? 'Expand' : 'Collapse'}</button>` : ''}
      <button class="pill-btn" data-action="branch">Branch</button>
      <button class="pill-btn" data-action="focus">Focus here</button>
    </div>
    ${artifacts ? `<div class="artifact-row">${artifacts}</div>` : ''}
  `;

  card.querySelector('[data-action="branch"]')?.addEventListener('click', () => createBranchFromNode(node.id));
  card.querySelector('[data-action="focus"]')?.addEventListener('click', () => {
    state.selectedNodeId = node.id;
    renderChat();
    renderMap();
    persistUiState();
  });
  card.querySelector('[data-action="expand"]')?.addEventListener('click', () => {
    if (state.expandedMessages.has(node.id)) {
      state.expandedMessages.delete(node.id);
    } else {
      state.expandedMessages.add(node.id);
    }
    renderChat();
  });
  card.querySelector('[data-action="speak"]')?.addEventListener('click', () => speak(node.spokenSummary));
  for (const artifactButton of card.querySelectorAll('[data-artifact-type]')) {
    artifactButton.addEventListener('click', () => openArtifact({
      type: artifactButton.dataset.artifactType,
      path: artifactButton.dataset.artifactPath,
      label: artifactButton.dataset.artifactLabel,
    }));
  }

  queueMicrotask(() => renderMermaid(card));
  return card;
}

function renderMarkdown(markdown) {
  const renderer = new marked.Renderer();
  renderer.link = ({ href, text }) => {
    if (href?.startsWith('/home/henry/')) {
      return `<button class="chip" data-artifact-type="file" data-artifact-path="${escapeHtml(href)}" data-artifact-label="${escapeHtml(text || href)}">${escapeHtml(text || href)}</button>`;
    }
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text || href)}</a>`;
  };
  const html = marked.parse(markdown || '', { renderer });
  return window.DOMPurify.sanitize(html);
}

async function renderMermaid(container) {
  for (const code of container.querySelectorAll('pre code.language-mermaid')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid';
    wrapper.textContent = code.textContent || '';
    code.parentElement.replaceWith(wrapper);
  }

  const blocks = container.querySelectorAll('.mermaid');
  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`mermaid-${Math.random().toString(36).slice(2)}`, block.textContent);
      block.innerHTML = svg;
    } catch (error) {
      block.innerHTML = `<pre>${escapeHtml(block.textContent)}</pre>`;
    }
  }
}

function renderControl() {
  renderQuickActions();
  renderTmuxList();
  renderClaudeList();
  dom.sessionLog.textContent = state.logLines.join('\n') || '[Waiting for session log]';
  dom.sessionLog.classList.toggle('collapsed', !state.logExpanded);
  dom.toggleLogBtn.textContent = state.logExpanded ? 'Collapse' : 'Expand';
}

function renderQuickActions() {
  const actions = [
    { label: 'Summarize eval-harness', prompt: 'Summarize the eval-harness tmux session and tell me if anything is blocked.' },
    { label: 'Scan active processes', prompt: 'Scan the current processes and tell me what needs attention first.' },
    { label: 'Resume latest Claude work', prompt: 'Read the latest Claude session log and summarize what the active engineers are doing.' },
  ];
  dom.quickActions.innerHTML = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.className = 'quick-action';
    button.innerHTML = `<strong>${escapeHtml(action.label)}</strong><div class="muted">One tap prompt</div>`;
    button.addEventListener('click', () => {
      dom.composerInput.value = action.prompt;
      state.activeTab = 'chat';
      renderShell();
    });
    dom.quickActions.appendChild(button);
  }
}

function renderTmuxList() {
  const sessions = state.bootstrap?.sessions?.tmux || [];
  dom.tmuxList.innerHTML = sessions.length ? '' : '<div class="message-card system-card">No tmux sessions found.</div>';
  for (const session of sessions) {
    const card = document.createElement('div');
    card.className = 'tmux-card';
    card.innerHTML = `
      <div class="tmux-card-header">
        <div>
          <h4>${escapeHtml(session.name)}</h4>
          <div class="muted">${session.windows.length} windows</div>
        </div>
        <button class="pill-btn" data-action="open">Inspect</button>
      </div>
      <pre class="tmux-preview">${escapeHtml(session.preview || '[no preview]')}</pre>
      <div class="tmux-actions">
        <button class="chip" data-action="ask">Ask agent</button>
        <button class="chip" data-action="capture">Capture</button>
        <button class="chip" data-action="interrupt">Interrupt</button>
      </div>
    `;
    card.querySelector('[data-action="ask"]').addEventListener('click', () => {
      dom.composerInput.value = `Inspect tmux session "${session.name}" and tell me what is happening, what is blocked, and the next best action.`;
      state.activeTab = 'chat';
      renderShell();
    });
    card.querySelector('[data-action="capture"]').addEventListener('click', () => inspectTmuxCapture(session.name));
    card.querySelector('[data-action="open"]').addEventListener('click', () => inspectTmuxCapture(session.name));
    card.querySelector('[data-action="interrupt"]').addEventListener('click', () => runTmuxAction(session.name, 'interrupt'));
    dom.tmuxList.appendChild(card);
  }
}

function renderClaudeList() {
  const sessions = state.bootstrap?.sessions?.claude || [];
  dom.claudeList.innerHTML = sessions.length ? '' : '<div class="message-card system-card">No Claude session logs found.</div>';
  for (const session of sessions) {
    const card = document.createElement('div');
    card.className = 'claude-card';
    card.innerHTML = `
      <div class="tmux-card-header">
        <div>
          <h4>${escapeHtml(session.shortId)}</h4>
          <div class="muted">${escapeHtml(session.goal)}</div>
        </div>
        <button class="pill-btn">Tail</button>
      </div>
    `;
    card.querySelector('button').addEventListener('click', () => {
      state.currentLogPath = session.path;
      subscribeLogs(session.path);
      state.activeTab = 'control';
      renderControl();
      openDrawer('Claude session', session.goal, `<pre>${escapeHtml(session.path)}</pre>`);
    });
    dom.claudeList.appendChild(card);
  }
}

function renderProcesses() {
  const attention = state.bootstrap?.processes?.attention || [];
  dom.attentionQueue.innerHTML = attention.length ? '' : '<div class="message-card system-card">No urgent process alerts right now.</div>';
  for (const item of attention) {
    const card = document.createElement('div');
    card.className = 'attention-card';
    card.innerHTML = `<strong>${escapeHtml(item.reason)}</strong><div class="muted">${escapeHtml(item.label)}</div>`;
    dom.attentionQueue.appendChild(card);
  }

  dom.processGroups.innerHTML = '';
  for (const group of state.bootstrap?.processes?.groups || []) {
    const wrapper = document.createElement('div');
    wrapper.className = 'stack';
    const heading = document.createElement('div');
    heading.className = 'panel-subsection';
    heading.innerHTML = `<div class="subsection-header"><h4>${escapeHtml(group.label)}</h4><span class="muted">${group.count}</span></div>`;
    wrapper.appendChild(heading);

    for (const process of group.items.slice(0, 10)) {
      const card = document.createElement('div');
      card.className = 'process-card';
      card.innerHTML = `
        <div class="process-header">
          <div>
            <h4>${escapeHtml(process.purpose)}</h4>
            <div class="muted">${escapeHtml(process.command.slice(0, 120))}</div>
          </div>
          <span class="mini-label">${formatDuration(process.elapsedSec)} · ${process.cpu}% CPU</span>
        </div>
        <div class="process-actions">
          <button class="chip" data-action="ask">Ask</button>
          <button class="chip" data-action="details">Details</button>
        </div>
      `;
      card.querySelector('[data-action="ask"]').addEventListener('click', () => {
        dom.composerInput.value = `Summarize process ${process.pid} (${process.command}) and tell me whether I should interrupt it.`;
        state.activeTab = 'chat';
        renderShell();
      });
      card.querySelector('[data-action="details"]').addEventListener('click', () => {
        openDrawer('Process', process.owner, `
          <pre>${escapeHtml(JSON.stringify(process, null, 2))}</pre>
        `);
      });
      wrapper.appendChild(card);
    }
    dom.processGroups.appendChild(wrapper);
  }
}

function renderMap() {
  if (!state.currentChat) return;
  dom.mapSummary.innerHTML = `<div class="mini-label">Current path</div><pre>${escapeHtml(currentNodePath().map((node) => `${node.role.toUpperCase()}: ${plainText(node.text || node.displayMarkdown || '').slice(0, 100)}`).join('\n\n') || 'No path selected')}</pre>`;
  dom.branchTree.innerHTML = '';
  for (const rootId of state.currentChat.rootIds) {
    dom.branchTree.appendChild(renderTreeNode(rootId));
  }
}

function renderTreeNode(nodeId) {
  const node = state.currentChat.nodes[nodeId];
  const wrapper = document.createElement('div');
  wrapper.className = `tree-node ${nodeId === (state.selectedNodeId || state.currentChat.activeNodeId) ? 'active' : ''}`;
  wrapper.innerHTML = `
    <div class="tree-node-header">
      <div>
        <h4>${escapeHtml(node.role)} · ${escapeHtml((node.branchLabel || plainText(node.text || node.displayMarkdown || 'turn')).slice(0, 36))}</h4>
        <div class="muted">${new Date(node.createdAt).toLocaleString()}</div>
      </div>
      <div class="message-actions">
        <button class="pill-btn" data-action="focus">Focus</button>
        <button class="pill-btn" data-action="branch">Branch</button>
      </div>
    </div>
  `;
  wrapper.querySelector('[data-action="focus"]').addEventListener('click', () => {
    state.selectedNodeId = nodeId;
    renderChat();
    renderMap();
    persistUiState();
  });
  wrapper.querySelector('[data-action="branch"]').addEventListener('click', () => createBranchFromNode(nodeId));

  if (node.children?.length) {
    const children = document.createElement('div');
    children.className = 'tree-node-children';
    for (const childId of node.children) {
      children.appendChild(renderTreeNode(childId));
    }
    wrapper.appendChild(children);
  }
  return wrapper;
}

function openDrawer(title, kicker, bodyHtml) {
  state.drawerOpen = true;
  dom.drawer.classList.add('open');
  dom.drawerTitle.textContent = title;
  dom.drawerKicker.textContent = kicker;
  dom.drawerBody.innerHTML = bodyHtml;
  renderShell();
}

function closeDrawer() {
  state.drawerOpen = false;
  dom.drawer.classList.remove('open');
  renderShell();
}

async function openArtifact(artifact) {
  if (!artifact.path) return;
  if (artifact.type === 'file') {
    const file = await fetchJson(`/api/artifacts/file?path=${encodeURIComponent(artifact.path)}`);
    openDrawer(artifact.label || 'File preview', 'Local file', `<pre>${escapeHtml(file.lines.map((line) => `${line.lineNumber.toString().padStart(4, ' ')}  ${line.text}`).join('\n'))}</pre>`);
    return;
  }
  if (artifact.type === 'diff') {
    const diff = await fetchJson(`/api/artifacts/diff?path=${encodeURIComponent(artifact.path)}`);
    openDrawer(artifact.label || 'Diff preview', 'Git diff', `<pre>${escapeHtml(diff.diff || '[No diff]')}</pre>`);
  }
}

async function inspectTmuxCapture(sessionName) {
  const capture = await fetchJson(`/api/tmux/${encodeURIComponent(sessionName)}/capture?lines=160`);
  openDrawer(sessionName, 'Tmux capture', `<pre>${escapeHtml(capture.text || '[empty]')}</pre>`);
}

async function runTmuxAction(sessionName, action, text = '') {
  await fetchJson(`/api/tmux/${encodeURIComponent(sessionName)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, text }),
  });
  const note = action === 'interrupt' ? `Interrupted ${sessionName}` : `Sent action ${action} to ${sessionName}`;
  appendSystemCard(note);
}

function appendSystemCard(text) {
  const card = document.createElement('div');
  card.className = 'message-card system-card';
  card.innerHTML = `<p>${escapeHtml(text)}</p>`;
  dom.chatFeed.appendChild(card);
  dom.chatFeed.scrollTop = dom.chatFeed.scrollHeight;
}

function connectLogSocket() {
  const url = `wss://${location.host}/ws`;
  state.ws = new WebSocket(url);
  state.ws.addEventListener('open', () => subscribeLogs(state.currentLogPath));
  state.ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'log_line') {
      state.logLines.push(message.text);
      if (state.logLines.length > 220) {
        state.logLines = state.logLines.slice(-220);
      }
      renderControl();
      return;
    }
    if (message.type === 'bash_result') {
      sendFunctionResultToRealtime(message);
    }
  });
  state.ws.addEventListener('close', () => {
    setTimeout(connectLogSocket, 2000);
  });
}

function subscribeLogs(path) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'subscribe_logs', path }));
}

function setConnectionState(next) {
  state.connectionState = next;
  renderShell();
}

async function ensureRealtimeConnection(textOnly) {
  if (state.connectionState === 'connected' && state.dc?.readyState === 'open') {
    return;
  }
  setConnectionState('connecting');
  try {
    const token = await fetchJson('/token');
    state.pc = new RTCPeerConnection();
    state.remoteAudio = dom.remoteAudio;
    state.remoteAudio.muted = state.mode === 'text';

    if (state.mode === 'voice' && !textOnly) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        state.pc.addTrack(track, stream);
      }
    } else {
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      state.pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    }

    state.pc.addEventListener('track', (event) => {
      dom.remoteAudio.srcObject = event.streams[0];
    });

    state.dc = state.pc.createDataChannel('oai-events');
    state.dc.addEventListener('open', () => {
      setConnectionState('connected');
      sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: {
            input: {
              turn_detection: { type: 'server_vad' },
            },
            output: {
              voice: 'marin',
            },
          },
        },
      });
      if (state.pendingUserText) {
        const pending = state.pendingUserText;
        state.pendingUserText = null;
        void sendTextTurn(pending);
      }
    });
    state.dc.addEventListener('message', (event) => handleRealtimeEvent(JSON.parse(event.data)));
    state.dc.addEventListener('close', () => setConnectionState('disconnected'));
    state.dc.addEventListener('error', () => setConnectionState('error'));

    await state.pc.setLocalDescription();
    await new Promise((resolve) => {
      if (state.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      state.pc.addEventListener('icegatheringstatechange', function onGather() {
        if (state.pc.iceGatheringState === 'complete') {
          state.pc.removeEventListener('icegatheringstatechange', onGather);
          resolve();
        }
      });
    });

    const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.client_secret.value}`,
        'Content-Type': 'application/sdp',
      },
      body: state.pc.localDescription.sdp,
    });
    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }
    await state.pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
  } catch (error) {
    console.error(error);
    setConnectionState('error');
    appendSystemCard(`Connection error: ${error.message}`);
  }
}

function disconnectRealtime() {
  if (state.dc) {
    try { state.dc.close(); } catch {}
    state.dc = null;
  }
  if (state.pc) {
    for (const sender of state.pc.getSenders()) {
      try {
        sender.track?.stop();
      } catch {}
    }
    try { state.pc.close(); } catch {}
    state.pc = null;
  }
  setConnectionState('disconnected');
}

function sendEvent(payload) {
  if (state.dc?.readyState === 'open') {
    state.dc.send(JSON.stringify(payload));
  }
}

async function createChatMessage(payload) {
  const created = await fetchJson(`/api/chats/${encodeURIComponent(state.currentChat.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.currentChat.nodes[created.id] = { ...created, children: created.children || [] };
  if (!created.parentId) {
    state.currentChat.rootIds.push(created.id);
  } else {
    const parent = state.currentChat.nodes[created.parentId];
    if (parent && !parent.children.includes(created.id)) {
      parent.children.push(created.id);
    }
  }
  state.currentChat.activeNodeId = created.id;
  state.selectedNodeId = created.id;
  return created;
}

async function patchChatMessage(messageId, payload) {
  const updated = await fetchJson(`/api/chats/${encodeURIComponent(state.currentChat.id)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.currentChat.nodes[messageId] = {
    ...state.currentChat.nodes[messageId],
    ...updated,
  };
  state.currentChat.activeNodeId = messageId;
  state.selectedNodeId = messageId;
  return updated;
}

async function createBranchFromNode(nodeId) {
  if (!state.currentChat || !nodeId) return;
  await fetchJson(`/api/chats/${encodeURIComponent(state.currentChat.id)}/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromMessageId: nodeId,
      title: `Branch ${state.branchCounter++}`,
    }),
  });
  state.selectedNodeId = nodeId;
  state.activeTab = 'chat';
  dom.composerInput.focus();
  renderAll();
}

function buildBranchContext(parentId) {
  if (!parentId || !state.currentChat?.nodes[parentId]) return '';
  const nodes = currentNodePath(state.currentChat, parentId).slice(-6);
  if (!nodes.length) return '';
  return nodes.map((node) => `${node.role.toUpperCase()}: ${plainText(node.displayMarkdown || node.text || '').slice(0, 360)}`).join('\n\n');
}

function buildContextSummary() {
  const sections = [];

  const attention = state.bootstrap?.processes?.attention || [];
  if (attention.length) {
    sections.push(`Attention queue:\n${attention.slice(0, 5).map((item) => `- ${item.reason}: ${item.label}`).join('\n')}`);
  }

  const tmuxSessions = state.bootstrap?.sessions?.tmux || [];
  if (tmuxSessions.length) {
    sections.push(`Tmux sessions:\n${tmuxSessions.slice(0, 4).map((session) => `- ${session.name}: ${(session.preview || '[no preview]').slice(0, 240)}`).join('\n')}`);
  }

  const branchPath = currentNodePath().slice(-6);
  if (branchPath.length) {
    sections.push(`Active branch path:\n${branchPath.map((node) => `- ${node.role}: ${plainText(node.displayMarkdown || node.text || '').slice(0, 220)}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

async function requestDetailedMarkdown(prompt, assistantNodeId, voiceSummary = '') {
  const response = await fetchJson('/api/text-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      contextSummary: buildContextSummary(),
      voiceSummary,
    }),
  });
  const displayMarkdown = response.markdown || voiceSummary || '_No response captured._';
  const spokenSummary = voiceSummary || summarizeText(displayMarkdown);

  await patchChatMessage(assistantNodeId, {
    displayMarkdown,
    spokenSummary,
    status: 'done',
  });

  if (state.autoSpeak && spokenSummary) {
    speak(spokenSummary);
  }

  if (state.pendingTurn?.assistantNodeId === assistantNodeId) {
    state.pendingTurn = null;
  }
  state.detailedResponseInFlight = false;
  renderChat();
  renderMap();
}

async function sendTextTurn(userText) {
  const parentId = state.selectedNodeId || state.currentChat?.activeNodeId || null;
  const branchContext = parentId && parentId !== state.currentChat?.activeNodeId ? buildBranchContext(parentId) : '';
  const sentText = branchContext ? `Continue from this branch context:\n\n${branchContext}\n\nNew request:\n${userText}` : userText;

  const userNode = await createChatMessage({
    parentId,
    role: 'user',
    text: userText,
    displayMarkdown: userText,
    status: 'done',
  });
  const assistantNode = await createChatMessage({
    parentId: userNode.id,
    role: 'assistant',
    text: '',
    displayMarkdown: '',
    spokenSummary: '',
    status: 'streaming',
  });
  state.pendingTurn = {
    userNodeId: userNode.id,
    assistantNodeId: assistantNode.id,
    audioBuffer: '',
    prompt: sentText,
  };
  renderChat();
  renderMap();

  state.detailedResponseInFlight = true;
  try {
    await requestDetailedMarkdown(sentText, assistantNode.id);
  } catch (error) {
    state.detailedResponseInFlight = false;
    await patchChatMessage(assistantNode.id, {
      displayMarkdown: `## Error\n\n${error.message}`,
      spokenSummary: 'The detailed reply failed.',
      status: 'done',
    });
    state.pendingTurn = null;
    renderChat();
    renderMap();
  }
}

function handleRealtimeEvent(event) {
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = (event.transcript || '').trim();
    if (!transcript || !state.currentChat) return;
    void createChatMessage({
      parentId: state.selectedNodeId || state.currentChat.activeNodeId || null,
      role: 'user',
      text: transcript,
      displayMarkdown: transcript,
      status: 'done',
    }).then((userNode) => createChatMessage({
      parentId: userNode.id,
      role: 'assistant',
      status: 'streaming',
      text: '',
      displayMarkdown: '',
      spokenSummary: '',
    })).then((assistantNode) => {
      state.pendingTurn = {
        assistantNodeId: assistantNode.id,
        audioBuffer: '',
        prompt: transcript,
      };
      renderChat();
      renderMap();
    });
    return;
  }

  if (!state.pendingTurn && event.type.startsWith('response.')) {
    return;
  }

  switch (event.type) {
    case 'response.output_audio_transcript.delta':
      state.pendingTurn.audioBuffer += event.delta || '';
      void patchChatMessage(state.pendingTurn.assistantNodeId, {
        spokenSummary: state.pendingTurn.audioBuffer,
        status: 'streaming',
      });
      break;
    case 'response.output_audio_transcript.done':
      state.pendingTurn.audioBuffer = event.transcript || state.pendingTurn.audioBuffer;
      if (!state.detailedResponseInFlight && state.mode === 'voice') {
        state.detailedResponseInFlight = true;
        void requestDetailedMarkdown(
          state.pendingTurn.prompt || state.pendingTurn.audioBuffer,
          state.pendingTurn.assistantNodeId,
          state.pendingTurn.audioBuffer,
        ).catch(async (error) => {
          state.detailedResponseInFlight = false;
          await patchChatMessage(state.pendingTurn.assistantNodeId, {
            displayMarkdown: state.pendingTurn.audioBuffer || `## Error\n\n${error.message}`,
            spokenSummary: state.pendingTurn.audioBuffer || 'The detailed reply failed.',
            status: 'done',
          });
          state.pendingTurn = null;
          renderChat();
          renderMap();
        });
      }
      break;
    case 'response.function_call_arguments.done':
      handleFunctionCall(event);
      break;
    case 'error':
      appendSystemCard(`AI error: ${event.error?.message || 'Unknown error'}`);
      break;
    default:
      break;
  }
}

function handleFunctionCall(event) {
  if (event.name !== 'run_bash') return;
  let args = {};
  try {
    args = JSON.parse(event.arguments || '{}');
  } catch {}
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'run_bash',
      command: args.command || '',
      call_id: event.call_id,
    }));
  }
}

function sendFunctionResultToRealtime(message) {
  if (!state.dc || state.dc.readyState !== 'open') return;
  const output = message.error ? `Error: ${message.error}\n${message.output || ''}`.trim() : (message.output || '');
  sendEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: message.call_id,
      output,
    },
  });
}

function speak(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

async function handleSend() {
  const value = dom.composerInput.value.trim();
  if (!value || !state.currentChat) return;
  dom.composerInput.value = '';
  if (state.mode === 'text') {
    await sendTextTurn(value);
    return;
  }
  if (state.connectionState !== 'connected') {
    state.pendingUserText = value;
    await ensureRealtimeConnection(state.mode === 'text');
    return;
  }
  await sendTextTurn(value);
}

function bindEvents() {
  dom.tabs.forEach((tab) => tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    renderShell();
    persistUiState();
  }));
  dom.drawerCloseBtn.addEventListener('click', closeDrawer);
  dom.drawerDismissBtn.addEventListener('click', closeDrawer);
  dom.drawer.addEventListener('click', (event) => {
    if (event.target === dom.drawer) {
      closeDrawer();
    }
  });
  dom.connectBtn.addEventListener('click', async () => {
    if (state.connectionState === 'connected') {
      disconnectRealtime();
      return;
    }
    await ensureRealtimeConnection(state.mode === 'text');
  });
  dom.modeVoice.addEventListener('click', () => {
    state.mode = 'voice';
    renderShell();
  });
  dom.modeText.addEventListener('click', () => {
    state.mode = 'text';
    renderShell();
  });
  dom.sendBtn.addEventListener('click', handleSend);
  dom.composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  });
  dom.speakToggleBtn.addEventListener('click', () => {
    state.autoSpeak = !state.autoSpeak;
    renderShell();
  });
  dom.toggleLogBtn.addEventListener('click', () => {
    state.logExpanded = !state.logExpanded;
    renderControl();
  });
  dom.newChatBtn.addEventListener('click', async () => {
    const chat = await fetchJson('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `New chat ${state.chats.length + 1}` }),
    });
    state.chats.unshift(chat);
    await loadChat(chat.id);
    renderAll();
  });
  dom.branchBtn.addEventListener('click', () => {
    if (state.selectedNodeId) {
      void createBranchFromNode(state.selectedNodeId);
    }
  });
  dom.chatPickerBtn.addEventListener('click', () => {
    const body = state.chats.map((chat) => `
      <button class="quick-action" data-chat-id="${escapeHtml(chat.id)}">
        <strong>${escapeHtml(chat.title)}</strong>
        <div class="muted">${escapeHtml(chat.latestPreview || 'No turns yet')}</div>
      </button>
    `).join('');
    openDrawer('Chats', 'History', body);
    for (const button of dom.drawerBody.querySelectorAll('[data-chat-id]')) {
      button.addEventListener('click', async () => {
        await loadChat(button.dataset.chatId);
        closeDrawer();
        renderAll();
      });
    }
  });
}

async function init() {
  bindEvents();
  connectLogSocket();
  await loadBootstrap();
}

void init();
