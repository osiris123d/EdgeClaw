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
    body { font-family: sans-serif; margin: 0; background: #fafafa; color: #111; }
    .wrap { max-width: 840px; margin: 0 auto; padding: 16px; }
    .bar { display: flex; gap: 8px; margin-bottom: 12px; }
    .messages { border: 1px solid #ddd; background: #fff; min-height: 420px; padding: 12px; overflow-y: auto; }
    .msg { margin: 0 0 12px; padding: 10px; border-radius: 6px; }
    .msg.user { background: #f1f5f9; }
    .msg.assistant { background: #f8fafc; border: 1px solid #e5e7eb; }
    .meta { font-size: 12px; color: #555; margin-top: 6px; }
    form { display: flex; gap: 8px; margin-top: 12px; }
    input, button { font: inherit; padding: 10px; }
    input { flex: 1; border: 1px solid #ccc; }
    button { border: 1px solid #bbb; background: #fff; cursor: pointer; }
    .status { font-size: 12px; color: #444; margin-top: 8px; }
    code { background: #f1f5f9; padding: 1px 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CloudflareBot Chat</h1>
    <p>Minimal chat interface. Task-style messages are routed into the dispatcher and may create queued tasks.</p>
    <div class="bar">
      <button id="new-chat">New chat</button>
      <div id="session-label"></div>
    </div>
    <div id="messages" class="messages"></div>
    <div id="status" class="status"></div>
    <form id="chat-form">
      <input id="message-input" autocomplete="off" placeholder="Ask for an analysis, draft, summary, or status update" />
      <button type="submit">Send</button>
    </form>
  </div>
  <script>
    const messagesEl = document.getElementById('messages');
    const statusEl = document.getElementById('status');
    const inputEl = document.getElementById('message-input');
    const formEl = document.getElementById('chat-form');
    const sessionLabelEl = document.getElementById('session-label');
    const newChatEl = document.getElementById('new-chat');
    let sessionId = localStorage.getItem('cloudflarebot:sessionId') || '';

    async function ensureSession() {
      if (sessionId) {
        sessionLabelEl.textContent = 'Session: ' + sessionId;
        await loadMessages();
        return;
      }
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'demo-user', title: 'Chat session' })
      });
      const data = await res.json();
      sessionId = data.session.sessionId;
      localStorage.setItem('cloudflarebot:sessionId', sessionId);
      sessionLabelEl.textContent = 'Session: ' + sessionId;
      renderMessages(data.messages || []);
    }

    async function loadMessages() {
      const res = await fetch('/api/chat/sessions/' + sessionId + '/messages');
      const data = await res.json();
      renderMessages(data.messages || []);
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = '';
      for (const message of messages) {
        appendMessage(message.role, message.content, message.taskId, message.taskStatus);
      }
    }

    function appendMessage(role, content, taskId, taskStatus) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const text = document.createElement('div');
      text.textContent = content;
      div.appendChild(text);
      if (taskId || taskStatus) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'taskId=' + (taskId || 'n/a') + ' status=' + (taskStatus || 'n/a');
        div.appendChild(meta);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      appendMessage('user', text);
      inputEl.value = '';
      statusEl.textContent = 'Sending...';

      // Chat-agent mapping:
      // 1. frontend sends the raw user message
      // 2. server persists it as a ChatMessage
      // 3. server may route task-like text into DispatcherAgent.handleInboundRequest()
      // 4. assistant response is streamed back token-by-token over SSE
      const res = await fetch('/api/chat/sessions/' + sessionId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ content: text, userId: 'demo-user' })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let liveText = '';
      let liveNode = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'assistant_delta') {
            liveText += String(evt.data.chunk || '');
            if (!liveNode) {
              liveNode = document.createElement('div');
              liveNode.className = 'msg assistant';
              liveNode.dataset.live = 'true';
              messagesEl.appendChild(liveNode);
            }
            liveNode.textContent = liveText;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (evt.type === 'task') {
            statusEl.textContent = 'Created task ' + evt.data.taskId + ' (' + evt.data.status + ')';
          }
          if (evt.type === 'done') {
            if (liveNode) {
              liveNode.removeAttribute('data-live');
              if (evt.data.taskId || evt.data.taskStatus) {
                const meta = document.createElement('div');
                meta.className = 'meta';
                meta.textContent = 'taskId=' + (evt.data.taskId || 'n/a') + ' status=' + (evt.data.taskStatus || 'n/a');
                liveNode.appendChild(meta);
              }
            } else {
              appendMessage('assistant', evt.data.content, evt.data.taskId, evt.data.taskStatus);
            }
            statusEl.textContent = 'Ready';
          }
          if (evt.type === 'error') {
            statusEl.textContent = 'Error: ' + evt.data.message;
          }
        }
      }
    });

    newChatEl.addEventListener('click', async () => {
      localStorage.removeItem('cloudflarebot:sessionId');
      sessionId = '';
      messagesEl.innerHTML = '';
      statusEl.textContent = 'Starting new chat...';
      await ensureSession();
      statusEl.textContent = 'Ready';
    });

    ensureSession().then(() => { statusEl.textContent = 'Ready'; });
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
