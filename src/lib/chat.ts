/**
 * lib/chat.ts
 *
 * Minimal chat-agent support for the prototype.
 *
 * Cloudflare chat-agent patterns used here:
 * - persistent conversation sessions (`ChatSession`)
 * - append-only message history (`ChatMessage`)
 * - server-sent event streaming for assistant output
 * - tool-style routing from chat message -> DispatcherAgent -> task creation
 *
 * MESSAGE PERSISTENCE MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * - Each session is stored in R2 at:
 *     org/hilton/chat/sessions/{sessionId}/session.json
 * - Each message is stored as one immutable JSON object at:
 *     org/hilton/chat/sessions/{sessionId}/messages/{createdAt}_{messageId}.json
 * - `listChatMessages()` sorts keys lexicographically, so ISO timestamps preserve
 *   chronological order without a separate index.
 * - This is append-only and replayable: on page reload, the frontend fetches the
 *   session's message list and reconstructs the conversation exactly.
 * - Because messages are immutable, the model is safe for prototype use and easy
 *   to audit. Streaming text is buffered server-side and only persisted once the
 *   assistant turn completes.
 */

import { R2BucketLike, R2ObjectLike } from "./types";

const DEFAULT_ORG_PREFIX = "org/hilton";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatSession {
  sessionId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  messageId: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  taskId?: string;
  taskStatus?: string;
  meta?: Record<string, unknown>;
}

export interface ChatMessageInput {
  role: ChatRole;
  content: string;
  taskId?: string;
  taskStatus?: string;
  meta?: Record<string, unknown>;
}

export interface ChatStreamEvent {
  type:
    | "session"
    | "message_saved"
    | "assistant_text"
    | "assistant_delta"
    | "task"
    | "task_proposal"
    | "task_progress"
    | "task_result"
    | "approval_request"
    | "done"
    | "error";
  data: Record<string, unknown>;
}

export const EXAMPLE_CHAT_CONVERSATION = [
  {
    role: "user",
    content: "Please draft CAB notes for a NAC policy rollback after today's WiFi outage.",
  },
  {
    role: "assistant",
    content:
      "I created task task-20260331-001 as change_review/nac and queued it for processing. Current status: queued.",
    taskId: "task-20260331-001",
    taskStatus: "queued",
  },
  {
    role: "user",
    content: "Show me the latest status for that task.",
  },
  {
    role: "assistant",
    content: "Task task-20260331-001 is still queued. Once the workflow runs, I will report completed, failed, or paused_for_approval.",
    taskId: "task-20260331-001",
    taskStatus: "queued",
  },
] as const;

export function createChatSession(userId: string, title: string): ChatSession {
  const now = new Date().toISOString();
  return {
    sessionId: crypto.randomUUID(),
    userId,
    title: title.trim().slice(0, 80) || "New chat",
    createdAt: now,
    updatedAt: now,
  };
}

export function createChatMessage(sessionId: string, input: ChatMessageInput): ChatMessage {
  return {
    messageId: crypto.randomUUID(),
    sessionId,
    role: input.role,
    content: input.content,
    createdAt: new Date().toISOString(),
    taskId: input.taskId,
    taskStatus: input.taskStatus,
    meta: input.meta,
  };
}

export async function putChatSession(
  bucket: R2BucketLike,
  session: ChatSession,
  orgPrefix?: string
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyChatSession(session.sessionId, orgPrefix);
  return putJson(bucket, key, session);
}

export async function getChatSession(
  bucket: R2BucketLike,
  sessionId: string,
  orgPrefix?: string
): Promise<ChatSession | null> {
  return getJson<ChatSession>(bucket, keyChatSession(sessionId, orgPrefix));
}

export async function appendChatMessage(
  bucket: R2BucketLike,
  message: ChatMessage,
  orgPrefix?: string
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyChatMessage(message.sessionId, message.createdAt, message.messageId, orgPrefix);
  return putJson(bucket, key, message);
}

export async function listChatMessages(
  bucket: R2BucketLike,
  sessionId: string,
  orgPrefix?: string
): Promise<ChatMessage[]> {
  const prefix = keyChatMessagesPrefix(sessionId, orgPrefix);
  const listed = await bucket.list({ prefix });
  const keys = listed.objects.map((obj: R2ObjectLike) => obj.key).sort();
  const messages: ChatMessage[] = [];
  for (const key of keys) {
    const msg = await getJson<ChatMessage>(bucket, key);
    if (msg) messages.push(msg);
  }
  return messages;
}

export function renderChatPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CloudflareBot Operator Chat</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 2px solid #e0e0e0;
    }
    h1 {
      margin: 0;
      font-size: 24px;
    }
    .subtitle {
      margin-top: 6px;
      font-size: 13px;
      color: #666;
    }
    .session-info {
      font-size: 12px;
      color: #666;
    }
    .new-chat-btn {
      padding: 8px 16px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    .new-chat-btn:hover {
      background: #f9f9f9;
    }
    .chat-panel {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      display: flex;
      flex-direction: column;
      height: 600px;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .message.user {
      align-items: flex-end;
    }
    .message-bubble {
      max-width: 75%;
      padding: 12px 16px;
      border-radius: 8px;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .message.user .message-bubble {
      background: #2563eb;
      color: white;
    }
    .message.assistant .message-bubble {
      background: #f0f0f0;
      color: #1a1a1a;
    }
    .message-meta {
      font-size: 11px;
      color: #999;
      padding: 0 4px;
    }
    .task-card {
      max-width: 75%;
      padding: 12px 16px;
      border-left: 4px solid #10b981;
      background: #f0fdf4;
      border-radius: 4px;
      font-size: 13px;
    }
    .task-card strong {
      color: #059669;
    }
    .proposal-card, .result-card {
      max-width: 85%;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      background: #f8fafc;
      font-size: 13px;
    }
    .proposal-card {
      border-left: 4px solid #2563eb;
      background: #eff6ff;
    }
    .result-card {
      border-left: 4px solid #10b981;
      background: #ecfdf5;
    }
    .approval-card {
      max-width: 85%;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid #fbbf24;
      border-left: 4px solid #f59e0b;
      background: #fffbeb;
      font-size: 13px;
    }
    .assistant-text-card {
      max-width: 75%;
      padding: 12px 16px;
      border-radius: 8px;
      border-left: 4px solid #64748b;
      background: #f8fafc;
      color: #1a1a1a;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .card-title {
      font-weight: 700;
      margin-bottom: 8px;
    }
    .card-grid {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 6px 10px;
      margin-bottom: 10px;
    }
    .card-label {
      color: #475569;
      font-weight: 600;
    }
    .card-value {
      color: #0f172a;
    }
    .proposal-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .btn-small {
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-small:hover { background: #f8fafc; }
    .btn-small.primary {
      background: #2563eb;
      color: white;
      border-color: #2563eb;
    }
    .btn-small.primary:hover { background: #1d4ed8; }
    .proposal-edit {
      margin-top: 8px;
      display: none;
      gap: 8px;
      flex-direction: column;
    }
    .proposal-edit label {
      font-size: 12px;
      color: #475569;
      font-weight: 600;
    }
    .proposal-edit input, .proposal-edit select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 12px;
      font-family: inherit;
      background: white;
    }
    .progress-line {
      max-width: 85%;
      font-size: 12px;
      color: #475569;
      background: #f8fafc;
      border: 1px dashed #cbd5e1;
      padding: 8px 10px;
      border-radius: 6px;
    }
    .details-link {
      color: #1d4ed8;
      text-decoration: none;
      font-weight: 600;
    }
    .details-link:hover { text-decoration: underline; }
    .open-details-btn {
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .open-details-btn:hover {
      background: #dbeafe;
    }
    .input-area {
      padding: 16px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      gap: 8px;
    }
    input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
    }
    input:focus {
      outline: none;
      border-color: #2563eb;
    }
    button[type="submit"] {
      padding: 10px 20px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    button[type="submit"]:hover {
      background: #1d4ed8;
    }
    button[type="submit"]:disabled {
      background: #cbd5e1;
      cursor: not-allowed;
    }
    .status {
      padding: 12px 16px;
      font-size: 13px;
      color: #666;
      border-top: 1px solid #e0e0e0;
      background: #fafafa;
    }
    .status.error {
      color: #dc2626;
    }
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid #e0e0e0;
      border-top-color: #2563eb;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>CloudflareBot Operator</h1>
        <div class="subtitle">Task-aware assistant for proposals, execution, and general questions</div>
      </div>
      <button class="new-chat-btn" id="new-chat">New Chat</button>
    </header>

    <div class="chat-panel">
      <div class="messages" id="messages"></div>
      <div class="status" id="status">Ready</div>
      <div class="input-area">
        <input
          id="message-input"
          type="text"
          placeholder="Ask anything, or describe work to propose a task..."
          autocomplete="off"
        />
        <button type="submit" id="send-btn">Send</button>
      </div>
    </div>

    <div style="margin-top: 16px; font-size: 12px; color: #999;">
      Session: <span id="session-label">Loading...</span>
    </div>
  </div>

  <script>
    const messagesEl = document.getElementById('messages');
    const statusEl = document.getElementById('status');
    const inputEl = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const sessionLabelEl = document.getElementById('session-label');
    const newChatBtn = document.getElementById('new-chat');

    let sessionId = localStorage.getItem('cloudflarebot:sessionId') || '';
    let isSending = false;
    let currentLiveAssistant = null;

    function setStatus(text, isError = false) {
      statusEl.innerHTML = text;
      statusEl.className = isError ? 'status error' : 'status';
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function appendMessage(role, content, taskId = null, taskStatus = null) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message ' + role;

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = content;
      msgDiv.appendChild(bubble);

      if (taskId) {
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = taskId + ' • ' + (taskStatus || 'queued');
        msgDiv.appendChild(meta);
      }

      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendAssistantText(content) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      const card = document.createElement('div');
      card.className = 'assistant-text-card';
      card.textContent = content || '';
      msgDiv.appendChild(card);
      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendTaskCard(taskId, taskStatus) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';

      const card = document.createElement('div');
      card.className = 'task-card';
      card.innerHTML = '<strong>Task created:</strong> ' + taskId + '<br/>Status: <strong>' + (taskStatus || 'queued') + '</strong>';
      msgDiv.appendChild(card);

      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendTaskProposalCard(proposal) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';

      const card = document.createElement('div');
      card.className = 'proposal-card';
      card.dataset.proposalId = proposal.proposalId;
      card.innerHTML =
        '<div class="card-title">Task Proposal</div>' +
        '<div class="card-grid">' +
          '<div class="card-label">Task Type</div><div class="card-value" data-field="taskType">' + escapeHtml(proposal.taskType) + '</div>' +
          '<div class="card-label">Domain</div><div class="card-value" data-field="domain">' + escapeHtml(proposal.domain || 'unspecified') + '</div>' +
          '<div class="card-label">Title</div><div class="card-value" data-field="title">' + escapeHtml(proposal.title) + '</div>' +
          '<div class="card-label">Confidence</div><div class="card-value" data-field="confidence">' + escapeHtml((proposal.confidence || 0).toFixed(2)) + '</div>' +
          '<div class="card-label">Route Class (future)</div><div class="card-value" data-field="routeClass">' + escapeHtml(proposal.routeClass || 'utility') + '</div>' +
        '</div>' +
        '<div class="proposal-actions">' +
          '<button class="btn-small primary" data-action="run">Run now</button>' +
          '<button class="btn-small" data-action="edit">Edit</button>' +
          '<button class="btn-small" data-action="cancel">Cancel</button>' +
        '</div>' +
        '<div class="proposal-edit">' +
          '<div><label>Title</label><input type="text" data-edit="title" value="' + escapeHtml(proposal.title) + '" /></div>' +
          '<div><label>Task Type</label><select data-edit="taskType">' +
            renderOptions(['incident_triage','change_review','report_draft','exec_summary','vendor_followup','root_cause_analysis'], proposal.taskType) +
          '</select></div>' +
          '<div><label>Domain</label><select data-edit="domain">' +
            renderOptions(['cross_domain','wifi','nac','ztna','telecom','content_filtering'], proposal.domain || 'cross_domain') +
          '</select></div>' +
          '<button class="btn-small primary" data-action="save-run">Run edited proposal</button>' +
        '</div>';

      msgDiv.appendChild(card);
      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      card.querySelector('[data-action="edit"]').addEventListener('click', () => {
        const editor = card.querySelector('.proposal-edit');
        editor.style.display = editor.style.display === 'flex' ? 'none' : 'flex';
      });

      card.querySelector('[data-action="cancel"]').addEventListener('click', async () => {
        await sendAction({
          content: 'Cancel this proposal',
          action: 'cancel_proposal',
          proposal: proposal,
        });
      });

      card.querySelector('[data-action="run"]').addEventListener('click', async () => {
        await sendAction({
          content: 'Run this proposed task',
          action: 'run_task',
          proposal: proposal,
        });
      });

      card.querySelector('[data-action="save-run"]').addEventListener('click', async () => {
        const edited = {
          ...proposal,
          title: card.querySelector('[data-edit="title"]').value.trim(),
          taskType: card.querySelector('[data-edit="taskType"]').value,
          domain: card.querySelector('[data-edit="domain"]').value,
        };
        await sendAction({
          content: 'Run edited proposal',
          action: 'run_task',
          proposal: edited,
        });
      });
    }

    function renderOptions(options, selected) {
      return options.map((value) => {
        const isSelected = value === selected ? ' selected' : '';
        return '<option value="' + escapeHtml(value) + '"' + isSelected + '>' + escapeHtml(value) + '</option>';
      }).join('');
    }

    function appendTaskProgress(update) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      const line = document.createElement('div');
      line.className = 'progress-line';
      const stage = update.stage ? ('[' + update.stage + '] ') : '';
      line.textContent = stage + (update.message || update.status || 'Task update');
      msgDiv.appendChild(line);
      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendTaskResultCard(result) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      const card = document.createElement('div');
      card.className = 'result-card';
      const detailsHref = result.detailsUrl || ('/api/tasks/' + encodeURIComponent(result.taskId || ''));
      card.innerHTML =
        '<div class="card-title">Task Result</div>' +
        '<div class="card-grid">' +
          '<div class="card-label">Task ID</div><div class="card-value">' + escapeHtml(result.taskId || 'n/a') + '</div>' +
          '<div class="card-label">Audit Verdict</div><div class="card-value">' + escapeHtml(result.auditVerdict || 'n/a') + '</div>' +
          '<div class="card-label">Audit Score</div><div class="card-value">' + escapeHtml(String(result.auditScore ?? 'n/a')) + '</div>' +
          '<div class="card-label">Finding Count</div><div class="card-value">' + escapeHtml(String(result.findingCount ?? 0)) + '</div>' +
          '<div class="card-label">Completed At</div><div class="card-value">' + escapeHtml(result.completedAt || 'n/a') + '</div>' +
          '<div class="card-label">Details</div><div class="card-value"><button class="open-details-btn" data-open-details="' + escapeHtml(detailsHref) + '">Open details</button></div>' +
        '</div>';
      const detailsBtn = card.querySelector('[data-open-details]');
      if (detailsBtn) {
        detailsBtn.addEventListener('click', () => {
          const href = detailsBtn.getAttribute('data-open-details');
          if (href) window.open(href, '_blank', 'noopener');
        });
      }
      msgDiv.appendChild(card);
      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendApprovalRequestCard(request) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      const card = document.createElement('div');
      card.className = 'approval-card';
      const taskId = request.taskId || 'n/a';
      const summary = request.summary || request.message || 'This task is waiting for approval.';
      const score = request.auditScore ?? request.score;
      card.innerHTML =
        '<div class="card-title">Approval Required</div>' +
        '<div class="card-grid">' +
          '<div class="card-label">Task ID</div><div class="card-value">' + escapeHtml(taskId) + '</div>' +
          '<div class="card-label">Summary</div><div class="card-value">' + escapeHtml(summary) + '</div>' +
          '<div class="card-label">Audit Score</div><div class="card-value">' + escapeHtml(score == null ? 'n/a' : String(score)) + '</div>' +
        '</div>';
      msgDiv.appendChild(card);
      messagesEl.appendChild(msgDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function startLiveAssistant() {
      currentLiveAssistant = document.createElement('div');
      currentLiveAssistant.className = 'message assistant';
      currentLiveAssistant.dataset.live = 'true';
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      currentLiveAssistant.appendChild(bubble);
      messagesEl.appendChild(currentLiveAssistant);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateLiveAssistant(text) {
      if (!currentLiveAssistant) startLiveAssistant();
      const bubble = currentLiveAssistant.querySelector('.message-bubble');
      bubble.textContent = text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finalizeLiveAssistant() {
      if (currentLiveAssistant) {
        currentLiveAssistant.removeAttribute('data-live');
      }
      currentLiveAssistant = null;
    }

    function renderSavedMessage(msg) {
      const renderType = msg.meta && msg.meta.renderType;
      if (renderType === 'assistant_text') {
        appendAssistantText(msg.content || '');
        return;
      }
      if (renderType === 'task_proposal' && msg.meta.proposal) {
        appendTaskProposalCard(msg.meta.proposal);
        return;
      }
      if (renderType === 'task_result' && msg.meta.result) {
        appendTaskResultCard(msg.meta.result);
        return;
      }
      if (renderType === 'task_progress' && msg.meta.progress) {
        appendTaskProgress(msg.meta.progress);
        return;
      }
      if (renderType === 'approval_request' && msg.meta.approvalRequest) {
        appendApprovalRequestCard(msg.meta.approvalRequest);
        return;
      }
      if (msg.role === 'assistant') {
        appendAssistantText(msg.content || '');
        return;
      }
      appendMessage(msg.role, msg.content, msg.taskId, msg.taskStatus);
    }

    async function ensureSession() {
      if (sessionId) {
        sessionLabelEl.textContent = sessionId.slice(0, 12) + '...';
        await loadMessages();
        return;
      }

      try {
        const res = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Chat session' })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Failed to create session');
        sessionId = data.session.sessionId;
        localStorage.setItem('cloudflarebot:sessionId', sessionId);
        sessionLabelEl.textContent = sessionId.slice(0, 12) + '...';
        messagesEl.innerHTML = '';
        setStatus('Ready');
      } catch (err) {
        setStatus('Error: ' + (err.message || 'Failed to create session'), true);
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch('/api/chat/sessions/' + sessionId + '/messages');
        const data = await res.json();
        messagesEl.innerHTML = '';
        for (const msg of (data.messages || [])) {
          renderSavedMessage(msg);
        }
        setStatus('Ready');
      } catch (err) {
        setStatus('Error loading messages: ' + (err.message || 'Unknown'), true);
      }
    }

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || isSending) return;

      inputEl.value = '';
      await sendAction({ content: text });
    }

    async function sendAction(payload) {
      if (isSending) return;

      isSending = true;
      sendBtn.disabled = true;

      if (typeof payload.content === 'string' && payload.content.trim()) {
        appendMessage('user', payload.content.trim());
      }

      setStatus('<span class="spinner"></span> Processing...');

      try {
        const res = await fetch('/api/chat/sessions/' + sessionId + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Request failed');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantText = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n\\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const match = line.match(/^data: (.+)$/);
            if (!match) continue;

            try {
              const evt = JSON.parse(match[1]);

              if (evt.type === 'session') {
                // Session created or confirmed
              } else if (evt.type === 'assistant_text') {
                appendAssistantText(evt.data.content || '');
              } else if (evt.type === 'assistant_delta') {
                const chunk = evt.data.chunk || '';
                assistantText += chunk;
                updateLiveAssistant(assistantText);
              } else if (evt.type === 'task') {
                appendTaskCard(evt.data.taskId, evt.data.status || 'queued');
              } else if (evt.type === 'task_proposal') {
                appendTaskProposalCard(evt.data.proposal || {});
              } else if (evt.type === 'task_progress') {
                appendTaskProgress(evt.data);
              } else if (evt.type === 'task_result') {
                appendTaskResultCard(evt.data);
              } else if (evt.type === 'approval_request') {
                appendApprovalRequestCard(evt.data);
              } else if (evt.type === 'done') {
                finalizeLiveAssistant();
              }
            } catch (parseErr) {
              // Ignore JSON parse errors in stream
            }
          }
        }

        setStatus('Ready');
      } catch (err) {
        setStatus('Error: ' + (err.message || 'Failed to send message'), true);
      } finally {
        finalizeLiveAssistant();
        isSending = false;
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    newChatBtn.addEventListener('click', async () => {
      localStorage.removeItem('cloudflarebot:sessionId');
      sessionId = '';
      messagesEl.innerHTML = '';
      setStatus('Starting new chat...');
      await ensureSession();
    });

    ensureSession();
  </script>
</body>
</html>`;
}

export function sseEvent(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function keyChatSession(sessionId: string, orgPrefix = DEFAULT_ORG_PREFIX): string {
  return `${cleanPrefix(orgPrefix)}/chat/sessions/${safeSegment(sessionId)}/session.json`;
}

function keyChatMessagesPrefix(sessionId: string, orgPrefix = DEFAULT_ORG_PREFIX): string {
  return `${cleanPrefix(orgPrefix)}/chat/sessions/${safeSegment(sessionId)}/messages/`;
}

function keyChatMessage(sessionId: string, createdAt: string, messageId: string, orgPrefix = DEFAULT_ORG_PREFIX): string {
  return `${keyChatMessagesPrefix(sessionId, orgPrefix)}${safeSegment(createdAt)}_${safeSegment(messageId)}.json`;
}

function cleanPrefix(value: string): string {
  return value.replace(/\/$/, "");
}

function safeSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\s+/g, "_");
}

async function putJson(
  bucket: R2BucketLike,
  key: string,
  value: unknown
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  try {
    await bucket.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
    });
    return { ok: true, key };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `Failed to write ${key}`,
    };
  }
}

async function getJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return await obj.json<T>();
  } catch {
    return null;
  }
}
