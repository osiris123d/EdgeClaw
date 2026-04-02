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
  type: "session" | "message_saved" | "assistant_delta" | "task" | "done" | "error";
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
  <title>CloudflareBot Chat</title>
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
      <h1>CloudflareBot Chat</h1>
      <button class="new-chat-btn" id="new-chat">New Chat</button>
    </header>

    <div class="chat-panel">
      <div class="messages" id="messages"></div>
      <div class="status" id="status">Ready</div>
      <div class="input-area">
        <input
          id="message-input"
          type="text"
          placeholder="Ask for an analysis, draft, summary, or status update..."
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

    function setStatus(text, isError = false) {
      statusEl.textContent = text;
      statusEl.className = isError ? 'status error' : 'status';
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
          appendMessage(msg.role, msg.content, msg.taskId, msg.taskStatus);
        }
        setStatus('Ready');
      } catch (err) {
        setStatus('Error loading messages: ' + (err.message || 'Unknown'), true);
      }
    }

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || isSending) return;

      isSending = true;
      sendBtn.disabled = true;
      appendMessage('user', text);
      inputEl.value = '';
      setStatus('<span class="spinner"></span> Processing...');

      try {
        const res = await fetch('/api/chat/sessions/' + sessionId + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Request failed');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantText = '';
        let taskCreatedId = null;

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
              } else if (evt.type === 'assistant_delta') {
                const chunk = evt.data.chunk || '';
                assistantText += chunk;
                // Update live assistant message in UI
                let assistantMsg = messagesEl.querySelector('[data-live]');
                if (!assistantMsg) {
                  assistantMsg = document.createElement('div');
                  assistantMsg.className = 'message assistant';
                  assistantMsg.dataset.live = true;
                  const bubble = document.createElement('div');
                  bubble.className = 'message-bubble';
                  assistantMsg.appendChild(bubble);
                  messagesEl.appendChild(assistantMsg);
                }
                assistantMsg.querySelector('.message-bubble').textContent = assistantText;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              } else if (evt.type === 'task') {
                taskCreatedId = evt.data.taskId;
                const status = evt.data.status || 'queued';
                appendTaskCard(taskCreatedId, status);
              } else if (evt.type === 'done') {
                // Mark assistant message as complete
                const liveMsg = messagesEl.querySelector('[data-live]');
                if (liveMsg) {
                  liveMsg.removeAttribute('data-live');
                }
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
