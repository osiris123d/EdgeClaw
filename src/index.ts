/**
 * index.ts
 *
 * Cloudflare Worker HTTP entrypoint for the OpenClaw-style planning/task/audit prototype.
 *
 * Routes:
 *   GET  /health                       — basic runtime health check
 *   GET  /ready                        — dependency readiness check
 *   POST /tasks                        — create and queue a task
 *   POST /tasks/run-next               — dequeue and execute next task
 *   POST /tasks/:taskId/approve        — human approves a paused task
 *   POST /tasks/:taskId/reject         — human rejects a paused task
 *   GET  /tasks/:taskId/approval       — get current approval record + UI shapes
 *   GET  /tasks/:taskId                — get task packet + worklog
 */

import { TaskCoordinatorDO } from "./durable/TaskCoordinatorDO";
import { routeAgentRequest } from "agents";
import {
  coordinatorInitialize,
  coordinatorAcquireLease,
} from "./durable/TaskCoordinatorDO";
import { normalizeTaskRequest, validateTaskRequest } from "./lib/task-schema";
import { Env } from "./lib/types";
import { authenticateRequest, hasValidApiKey } from "./lib/auth";
import { putTask, getTask, listWorklogEntries, getArtifact } from "./lib/r2";
import { TaskPacket, TaskType, DomainType, isTaskType, isDomainType } from "./lib/core-task-schema";
import { TaskWorkflow } from "./workflows/TaskWorkflow";
import { AuditStructuredOutput } from "./agents/AuditAgent";
import { DispatcherAgent } from "./agents/DispatcherAgent";
import { ChatAgentImpl } from "./agents/ChatAgentImpl";
import {
  ApprovalRecord,
  ApprovalDecisionRequest,
  ApprovalTrigger,
  getApprovalRecord,
  putApprovalRecord,
  classifyApprovalTrigger,
  buildApprovalSummary,
  buildApprovalDecisionResponse,
  buildApprovalStatusResponse,
  buildApprovalPendingInfo,
} from "./lib/approval";
import {
  appendChatMessage,
  ChatMessage,
  ChatStreamEvent,
  createChatMessage,
  createChatSession,
  getChatSession,
  listChatMessages,
  putChatSession,
  renderChatPage,
  sseEvent,
} from "./lib/chat";
import {
  EdgeClawConfig,
  validateEdgeClawConfig,
  nextVersion,
  ConfigChangeEntry,
} from "./lib/edgeclaw-config";
import { selectAIGatewayRoute } from "./lib/ai-gateway-routing";

export { TaskCoordinatorDO, ChatAgentImpl };

// ─── Route patterns ───────────────────────────────────────────────────────────

const RE_APPROVE  = /^\/tasks\/([^/]+)\/approve$/;
const RE_REJECT   = /^\/tasks\/([^/]+)\/reject$/;
const RE_APPROVAL = /^\/tasks\/([^/]+)\/approval$/;
const RE_TASK_GET = /^\/tasks\/([^/]+)$/;
const RE_API_TASK_GET = /^\/api\/tasks\/([^/]+)$/;
const RE_CHAT_MESSAGES = /^\/api\/chat\/sessions\/([^/]+)\/messages$/;

function validateCriticalEnv(env: Env): string[] {
  const missing: string[] = [];
  if (!env.R2_ARTIFACTS) missing.push("R2_ARTIFACTS");
  if (!env.R2_WORKLOGS) missing.push("R2_WORKLOGS");
  if (!env.TASK_COORDINATOR || typeof env.TASK_COORDINATOR.get !== "function") {
    missing.push("TASK_COORDINATOR");
  }
  return missing;
}

function isProtectedApiPath(pathname: string): boolean {
  // Keep /tasks protected and explicitly include Agents SDK namespace.
  // /api remains protected for existing chat/API endpoints.
  return pathname.startsWith("/tasks") || pathname.startsWith("/api/agents") || pathname.startsWith("/api");
}

function isBrowserFacingRoute(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/config-ui" ||
    pathname === "/system" ||
    pathname === "/tasks-console" ||
    pathname === "/tasks/run-next" ||
    pathname === "/chat" ||
    pathname.startsWith("/api/chat/") ||
    pathname === "/api/chat/sessions" ||
    pathname.startsWith("/api/agents/") ||
    pathname === "/api/tasks" ||
    pathname.startsWith("/api/tasks/")
  );
}

function isConfigApiRoute(pathname: string): boolean {
  return pathname === "/config" || pathname === "/config/export" || pathname === "/config/validate";
}

function isApiKeyOnlyRoute(pathname: string): boolean {
  const isTasksMachineRoute =
    (pathname === "/tasks" || pathname.startsWith("/tasks/")) && pathname !== "/tasks/run-next";
  const isConfigMachineRoute = pathname === "/config" || pathname.startsWith("/config/");
  return isTasksMachineRoute || isConfigMachineRoute;
}

function getConfiguredApiKey(env: Env): string | undefined {
  const vars = env as unknown as Record<string, unknown>;
  const key =
    (typeof vars["API_KEY"] === "string" && vars["API_KEY"]) ||
    (typeof vars["MVP_API_KEY"] === "string" && vars["MVP_API_KEY"]);

  if (!key) return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getBrowserIdentity(auth: ReturnType<typeof authenticateRequest>): Record<string, unknown> {
  return {
    mode: auth.mode,
    userId: auth.userId ?? null,
    email: auth.email ?? null,
    accessSubject: auth.accessSubject ?? null,
  };
}

// ─── Config Storage Helpers ────────────────────────────────────────────────

function keyEdgeClawConfig(version?: string, orgPrefix = "org/hilton"): string {
  if (version) {
    return `${orgPrefix}/config/edgeclaw-v${version}.json`;
  }
  return `${orgPrefix}/config/edgeclaw-current.json`;
}

async function getEdgeClawConfig(
  bucket: any,
  version?: string,
  orgPrefix = "org/hilton"
): Promise<EdgeClawConfig | null> {
  const key = keyEdgeClawConfig(version, orgPrefix);
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as EdgeClawConfig;
  } catch {
    return null;
  }
}

async function saveEdgeClawConfig(
  bucket: any,
  config: EdgeClawConfig,
  orgPrefix = "org/hilton"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const currentKey = keyEdgeClawConfig(undefined, orgPrefix);
    const versionKey = keyEdgeClawConfig(config.metadata.version, orgPrefix);
    
    // Write versioned snapshot
    await bucket.put(versionKey, JSON.stringify(config, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    
    // Update current pointer
    await bucket.put(currentKey, JSON.stringify(config, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save config",
    };
  }
}

async function appendConfigHistory(
  bucket: any,
  entry: ConfigChangeEntry,
  orgPrefix = "org/hilton"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const historyKey = `${orgPrefix}/config/config-history.jsonl`;
    const line = JSON.stringify(entry);
    
    // Append mode: fetch existing, add new line, put back
    let existing = "";
    try {
      const obj = await bucket.get(historyKey);
      if (obj) existing = await obj.text();
    } catch {
      // File doesn't exist yet, that's fine
    }
    
    const newContent = existing ? existing + "\n" + line : line;
    await bucket.put(historyKey, newContent, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save history",
    };
  }
}

function renderTasksConsole(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tasks Console</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
      font-size: 14px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 2px solid #e0e0e0;
    }
    h1 { margin: 0; font-size: 24px; }
    .subtitle { color: #666; margin: 4px 0 0; }
    
    .layout { display: grid; grid-template-columns: 300px 1fr; gap: 20px; }
    
    .task-list {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      max-height: 600px;
      overflow-y: auto;
    }
    .task-item {
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
      cursor: pointer;
      transition: background 0.15s;
    }
    .task-item:hover { background: #f9f9f9; }
    .task-item.selected { background: #e3f2fd; border-left: 3px solid #2563eb; }
    .task-id { font-size: 13px; font-weight: 600; color: #2563eb; }
    .task-status { font-size: 12px; color: #999; margin-top: 4px; }
    
    .task-detail {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      padding: 20px;
      min-height: 600px;
    }
    .detail-empty { color: #999; font-style: italic; }
    
    .detail-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 12px;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #f0f0f0;
    }
    .detail-label { font-weight: 600; color: #666; }
    .detail-value { white-space: pre-wrap; word-break: break-word; }
    
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-queued { background: #fef3c7; color: #92400e; }
    .badge-in_progress { background: #dbeafe; color: #1e40af; }
    .badge-awaiting_approval { background: #fed7aa; color: #9a3412; }
    .badge-completed { background: #dcfce7; color: #166534; }
    .badge-failed { background: #fee2e2; color: #991b1b; }
    
    .section-title {
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
      color: #1a1a1a;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .worklog-entry {
      padding: 8px;
      margin-bottom: 8px;
      background: #f9f9f9;
      border-left: 3px solid #ddd;
      border-radius: 2px;
      font-size: 13px;
    }
    .worklog-action { font-weight: 500; color: #2563eb; }
    .worklog-time { color: #999; font-size: 12px; }
    
    .action-buttons {
      display: flex;
      gap: 8px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
    }
    button {
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: opacity 0.15s;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-approve {
      background: #10b981;
      color: white;
    }
    .btn-approve:hover:not(:disabled) { opacity: 0.9; }
    .btn-reject {
      background: #ef4444;
      color: white;
    }
    .btn-reject:hover:not(:disabled) { opacity: 0.9; }
    .btn-run {
      background: #2563eb;
      color: white;
    }
    .btn-run:hover:not(:disabled) { opacity: 0.9; }
    .status-msg { margin-top: 12px; padding: 8px; border-radius: 4px; font-size: 13px; }
    .status-msg.success { background: #dcfce7; color: #166534; }
    .status-msg.error { background: #fee2e2; color: #991b1b; }
    
    .list-loading { padding: 16px; color: #999; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Tasks Console</h1>
      <p class="subtitle">View task status, worklog, and audit results. Approve or reject paused tasks.</p>
    </header>

    <div class="layout">
      <div class="task-list">
        <div id="task-list-content" class="list-loading">Loading tasks...</div>
      </div>

      <div class="task-detail" id="task-detail">
        <p class="detail-empty">Select a task to view details</p>
      </div>
    </div>
  </div>

  <script>
    const listEl = document.getElementById('task-list-content');
    const detailEl = document.getElementById('task-detail');
    let tasks = [];
    let selectedTaskId = null;

    async function loadTasks() {
      try {
        const res = await fetch('/api/tasks');
        if (!res.ok) throw new Error('Failed to load tasks');
        const data = await res.json();
        tasks = data.tasks || [];
        renderTaskList();
      } catch (err) {
        listEl.innerHTML = '<div class="list-loading" style="color: #d32f2f;">Error loading tasks</div>';
      }
    }

    function renderTaskList() {
      if (tasks.length === 0) {
        listEl.innerHTML = '<div class="list-loading">No tasks</div>';
        return;
      }
      listEl.innerHTML = tasks.map(task => {
        const id = task.taskId || '';
        const status = task.status || 'unknown';
        return \`
        <div class="task-item \${selectedTaskId === id ? 'selected' : ''}" onclick="selectTask('\${id}')">
          <div class="task-id">\${id.slice(0, 12)}...</div>
          <div class="task-status">\${status}</div>
        </div>
      \`;
      }).join('');
    }

    async function selectTask(taskId) {
      selectedTaskId = taskId;
      renderTaskList();
      await loadTaskDetail(taskId);
    }

    async function loadTaskDetail(taskId) {
      try {
        detailEl.innerHTML = '<p style="color: #999;">Loading...</p>';
        const res = await fetch('/api/tasks/' + taskId);
        if (!res.ok) throw new Error('Task not found');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        renderTaskDetail(data);
      } catch (err) {
        detailEl.innerHTML = '<p style="color: #d32f2f;">Error: ' + (err.message || 'Failed to load') + '</p>';
      }
    }

    function renderTaskDetail(data) {
      const task = data.task;
      const worklog = data.worklog || [];
      const isAwaitingApproval = task.approvalState === 'pending' || task.status === 'awaiting_approval';
      
      let html = '';
      
      // Core task info
      html += '<div class="detail-row">';
      html += '  <div class="detail-label">Task ID</div>';
      html += '  <div class="detail-value">' + task.taskId + '</div>';
      html += '</div>';
      
      html += '<div class="detail-row">';
      html += '  <div class="detail-label">Status</div>';
      html += '  <div class="detail-value"><span class="badge badge-' + task.status + '">' + task.status + '</span></div>';
      html += '</div>';
      
      html += '<div class="detail-row">';
      html += '  <div class="detail-label">Type / Domain</div>';
      html += '  <div class="detail-value">' + (task.taskType || 'n/a') + ' / ' + (task.domain || 'n/a') + '</div>';
      html += '</div>';
      
      if (task.completedAt) {
        html += '<div class="detail-row">';
        html += '  <div class="detail-label">Completed</div>';
        html += '  <div class="detail-value">' + task.completedAt + '</div>';
        html += '</div>';
      }
      
      // Audit results
      if (data.resultAvailable) {
        html += '<div class="section-title">Audit Results</div>';
        
        if (data.auditVerdict) {
          html += '<div class="detail-row">';
          html += '  <div class="detail-label">Verdict</div>';
          html += '  <div class="detail-value">' + data.auditVerdict + '</div>';
          html += '</div>';
        }
        
        if (typeof data.auditScore === 'number') {
          html += '<div class="detail-row">';
          html += '  <div class="detail-label">Score</div>';
          html += '  <div class="detail-value">' + data.auditScore.toFixed(2) + '</div>';
          html += '</div>';
        }
        
        if (typeof data.findingCount === 'number') {
          html += '<div class="detail-row">';
          html += '  <div class="detail-label">Finding Count</div>';
          html += '  <div class="detail-value">' + data.findingCount + '</div>';
          html += '</div>';
        }
        
        if (data.analystOutput && data.analystOutput.recommendations) {
          html += '<div class="detail-row">';
          html += '  <div class="detail-label">Analyst</div>';
          html += '  <div class="detail-value">';
          html += data.analystOutput.recommendations.slice(0, 2).map(r => '• ' + r).join('\\n');
          html += '</div>';
          html += '</div>';
        }
      }
      
      // Worklog
      if (worklog.length > 0) {
        html += '<div class="section-title">Worklog</div>';
        for (const entry of worklog.slice(0, 5)) {
          html += '<div class="worklog-entry">';
          html += '  <div class="worklog-action">' + (entry.action || 'event') + '</div>';
          html += '  <div class="worklog-time">' + entry.timestamp + '</div>';
          if (entry.summary) {
            html += '  <div style="margin-top: 4px;">' + entry.summary + '</div>';
          }
          html += '</div>';
        }
      }
      
      // Action buttons
      html += '<div class="action-buttons">';
      if (isAwaitingApproval) {
        html += '  <button class="btn-approve" onclick="approve()">Approve</button>';
        html += '  <button class="btn-reject" onclick="reject()">Reject</button>';
      } else if (task.status === 'queued') {
        html += '  <button class="btn-run" onclick="runNext()">Run Next</button>';
      }
      html += '</div>';
      html += '<div id="action-status"></div>';
      
      detailEl.innerHTML = html;
    }

    async function approve() {
      const statusEl = document.getElementById('action-status');
      try {
        statusEl.innerHTML = '<div class="status-msg">Approving...</div>';
        const res = await fetch('/tasks/' + selectedTaskId + '/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewerNote: 'Approved from console' })
        });
        if (!res.ok) throw new Error('Approval failed');
        statusEl.innerHTML = '<div class="status-msg success">Approved successfully</div>';
        await loadTaskDetail(selectedTaskId);
      } catch (err) {
        statusEl.innerHTML = '<div class="status-msg error">Error: ' + (err.message || 'Failed') + '</div>';
      }
    }

    async function reject() {
      const statusEl = document.getElementById('action-status');
      try {
        statusEl.innerHTML = '<div class="status-msg">Rejecting...</div>';
        const res = await fetch('/tasks/' + selectedTaskId + '/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewerNote: 'Rejected from console' })
        });
        if (!res.ok) throw new Error('Rejection failed');
        statusEl.innerHTML = '<div class="status-msg success">Rejected successfully</div>';
        await loadTaskDetail(selectedTaskId);
      } catch (err) {
        statusEl.innerHTML = '<div class="status-msg error">Error: ' + (err.message || 'Failed') + '</div>';
      }
    }

    async function runNext() {
      const statusEl = document.getElementById('action-status');
      try {
        statusEl.innerHTML = '<div class="status-msg">Running...</div>';
        const res = await fetch('/tasks/run-next', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: selectedTaskId })
        });

        if (!res.ok) {
          let reason = 'Execution failed';
          try {
            const data = await res.json();
            reason = data?.error || data?.message || reason;
          } catch (_) {
            // Keep generic reason when non-JSON error responses are returned.
          }
          throw new Error(reason + ' (HTTP ' + res.status + ')');
        }

        statusEl.innerHTML = '<div class="status-msg success">Executed successfully</div>';
        await loadTaskDetail(selectedTaskId);
      } catch (err) {
        statusEl.innerHTML = '<div class="status-msg error">Error: ' + (err.message || 'Failed') + '</div>';
      }
    }

    loadTasks();
  </script>
</body>
</html>`;
}

function renderSystemPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>System Status</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
      font-size: 14px;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 2px solid #e0e0e0;
    }
    h1 { margin: 0; font-size: 24px; }
    .subtitle { color: #666; margin: 4px 0 0; }
    
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    
    .panel {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      padding: 16px;
    }
    
    .status-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 12px;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #f0f0f0;
    }
    .status-label { font-weight: 600; color: #666; }
    .status-value { display: flex; align-items: center; gap: 8px; }
    
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-healthy { background: #dcfce7; color: #166534; }
    .badge-warning { background: #fef3c7; color: #92400e; }
    .badge-error { background: #fee2e2; color: #991b1b; }
    .badge-unknown { background: #f3f4f6; color: #4b5563; }
    
    .check-item {
      padding: 8px;
      margin: 4px 0;
      background: #f9f9f9;
      border-left: 3px solid #e0e0e0;
      border-radius: 2px;
      font-size: 13px;
    }
    .check-item.pass { border-left-color: #10b981; background: #f0fdf4; }
    .check-item.fail { border-left-color: #ef4444; background: #fef2f2; }
    
    .task-summary {
      padding: 8px;
      margin: 4px 0;
      background: #f9f9f9;
      border-radius: 4px;
      font-size: 13px;
    }
    
    .status-loading { color: #999; font-style: italic; }
    .status-error { color: #d32f2f; font-weight: 500; }
    .status-ok { color: #2e7d32; font-weight: 500; }
    
    .full-width { grid-column: 1 / -1; }
    
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      color: #1a1a1a;
      border-bottom: 1px solid #e0e0e0;
      padding-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>System Status</h1>
      <p class="subtitle">Real-time health, readiness, and task activity monitoring</p>
    </header>

    <div class="grid">
      <!-- Health Check -->
      <div class="panel">
        <h2>Liveness</h2>
        <div class="status-row">
          <div class="status-label">/health</div>
          <div class="status-value">
            <span id="health-status" class="status-loading">Loading...</span>
          </div>
        </div>
      </div>

      <!-- Readiness Checks -->
      <div class="panel">
        <h2>Readiness</h2>
        <div id="ready-checks" class="status-loading">Loading...</div>
      </div>

      <!-- Task Statistics -->
      <div class="panel">
        <h2>Task Activity</h2>
        <div id="task-stats" class="status-loading">Loading...</div>
      </div>

      <!-- Environment -->
      <div class="panel">
        <h2>Environment</h2>
        <div class="status-row">
          <div class="status-label">Origin</div>
          <div class="status-value"><code id="env-origin">—</code></div>
        </div>
        <div class="status-row">
          <div class="status-label">Timestamp</div>
          <div class="status-value"><code id="env-timestamp">—</code></div>
        </div>
      </div>

      <!-- Errors (if any) -->
      <div class="panel full-width" id="error-panel" style="display:none;">
        <h2>Warnings</h2>
        <div id="error-messages"></div>
      </div>
    </div>
  </div>

  <script>
    const healthEl = document.getElementById('health-status');
    const readyEl = document.getElementById('ready-checks');
    const taskEl = document.getElementById('task-stats');
    const originEl = document.getElementById('env-origin');
    const timestampEl = document.getElementById('env-timestamp');
    const errorPanel = document.getElementById('error-panel');
    const errorMessages = document.getElementById('error-messages');

    const errors = [];

    async function checkHealth() {
      try {
        const res = await fetch('/health');
        if (res.ok) {
          healthEl.innerHTML = '<span class="badge badge-healthy">✓ Healthy</span>';
          return true;
        } else {
          healthEl.innerHTML = '<span class="badge badge-error">✗ Unhealthy</span>';
          errors.push('Health check returned non-2xx status');
          return false;
        }
      } catch (err) {
        healthEl.innerHTML = '<span class="badge badge-error">✗ Error</span>';
        errors.push('Failed to reach /health: ' + (err.message || 'Unknown'));
        return false;
      }
    }

    async function checkReadiness() {
      try {
        const res = await fetch('/ready');
        if (!res.ok) {
          readyEl.innerHTML = '<span class="status-error">Service not ready</span>';
          return;
        }
        const data = await res.json();
        const checks = data.checks || {};
        
        let html = '';
        for (const [check, passed] of Object.entries(checks)) {
          const label = check
            .replace(/([A-Z])/g, ' \$1')
            .trim()
            .charAt(0)
            .toUpperCase() + check.slice(1);
          html += '<div class="check-item ' + (passed ? 'pass' : 'fail') + '">' +
            (passed ? '✓' : '✗') + ' ' + label +
            '</div>';
        }
        if (data.errors && data.errors.length > 0) {
          for (const err of data.errors) {
            html += '<div class="check-item fail">⚠ ' + err + '</div>';
            errors.push('Readiness: ' + err);
          }
        }
        readyEl.innerHTML = html || '<span class="status-ok">All checks passed</span>';
      } catch (err) {
        readyEl.innerHTML = '<span class="status-error">Failed to check readiness</span>';
        errors.push('Readiness check error: ' + (err.message || 'Unknown'));
      }
    }

    async function loadTaskActivity() {
      try {
        const res = await fetch('/api/tasks');
        if (!res.ok) {
          taskEl.innerHTML = '<span class="status-loading">No task data available</span>';
          return;
        }
        const data = await res.json();
        const tasks = data.tasks || [];
        const count = data.count || 0;

        let html = '';
        html += '<div class="status-row">';
        html += '  <div class="status-label">Total</div>';
        html += '  <div class="status-value"><strong>' + count + '</strong></div>';
        html += '</div>';

        if (tasks.length > 0) {
          const statuses = {};
          for (const task of tasks) {
            statuses[task.status] = (statuses[task.status] || 0) + 1;
          }
          html += '<div><strong>By Status:</strong></div>';
          for (const [status, count] of Object.entries(statuses)) {
            html += '<div class="task-summary">' + status + ': <strong>' + count + '</strong></div>';
          }
        }

        taskEl.innerHTML = html;
      } catch (err) {
        taskEl.innerHTML = '<span class="status-loading">Unable to load task activity</span>';
      }
    }

    function updateEnvironment() {
      originEl.textContent = window.location.origin;
      timestampEl.textContent = new Date().toISOString();
    }

    function displayErrors() {
      if (errors.length > 0) {
        errorPanel.style.display = 'block';
        errorMessages.innerHTML = errors.map(e => '<div style="padding:4px;color:#d32f2f;">• ' + e + '</div>').join('');
      }
    }

    async function load() {
      updateEnvironment();
      await Promise.all([
        checkHealth(),
        checkReadiness(),
        loadTaskActivity(),
      ]);
      displayErrors();
    }

    load();
  </script>
</body>
</html>`;
}

function renderAppShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EdgeClaw</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
    }

    .navbar {
      background: white;
      border-bottom: 2px solid #e0e0e0;
      padding: 16px 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .navbar-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 32px;
    }

    .navbar-brand {
      font-size: 18px;
      font-weight: 700;
      color: #2563eb;
      text-decoration: none;
      margin: 0;
    }

    .navbar-nav {
      display: flex;
      gap: 24px;
      list-style: none;
      margin: 0;
      padding: 0;
      flex: 1;
    }

    .navbar-nav a {
      text-decoration: none;
      color: #666;
      font-weight: 500;
      font-size: 14px;
      padding: 8px 0;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .navbar-nav a:hover {
      color: #2563eb;
      border-bottom-color: #2563eb;
    }

    .navbar-nav a.active {
      color: #2563eb;
      border-bottom-color: #2563eb;
    }

    .container {
      max-width: 1200px;
      margin: 24px auto;
      padding: 0 24px;
    }

    .hero {
      background: white;
      border-radius: 8px;
      padding: 48px 24px;
      text-align: center;
      margin-bottom: 32px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .hero h1 {
      margin: 0 0 12px;
      font-size: 32px;
    }

    .hero p {
      margin: 0 0 24px;
      color: #666;
      font-size: 16px;
    }

    .nav-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 24px;
    }

    .nav-card {
      background: white;
      border-radius: 8px;
      padding: 24px;
      text-decoration: none;
      color: inherit;
      border: 1px solid #e0e0e0;
      transition: all 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      text-align: center;
    }

    .nav-card:hover {
      border-color: #2563eb;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.15);
      transform: translateY(-2px);
    }

    .nav-card-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .nav-card-title {
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 16px;
    }

    .nav-card-desc {
      font-size: 13px;
      color: #999;
    }

    footer {
      text-align: center;
      padding: 32px 24px;
      color: #999;
      font-size: 13px;
    }

    @media (max-width: 640px) {
      .navbar-content {
        flex-direction: column;
        gap: 16px;
        align-items: flex-start;
      }

      .navbar-nav {
        gap: 16px;
        flex-direction: column;
      }

      .nav-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="navbar-content">
      <h1 class="navbar-brand">EdgeClaw</h1>
      <ul class="navbar-nav" id="navbar-nav">
        <li><a href="/chat" data-route="/chat">Chat</a></li>
        <li><a href="/tasks-console" data-route="/tasks-console">Tasks</a></li>
        <li><a href="/config-ui" data-route="/config-ui">Config</a></li>
        <li><a href="/system" data-route="/system">System</a></li>
      </ul>
    </div>
  </nav>

  <div class="container">
    <div class="hero">
      <h1>Welcome to EdgeClaw</h1>
      <p>Enterprise network operations automation and analysis</p>
    </div>

    <div class="nav-grid">
      <a href="/chat" class="nav-card">
        <div class="nav-card-icon">💬</div>
        <div class="nav-card-title">Chat</div>
        <div class="nav-card-desc">Task creation and analysis via conversation</div>
      </a>

      <a href="/tasks-console" class="nav-card">
        <div class="nav-card-icon">📋</div>
        <div class="nav-card-title">Tasks</div>
        <div class="nav-card-desc">Monitor and manage task execution</div>
      </a>

      <a href="/config-ui" class="nav-card">
        <div class="nav-card-icon">⚙️</div>
        <div class="nav-card-title">Config</div>
        <div class="nav-card-desc">Edit project, models, channels, and security</div>
      </a>

      <a href="/system" class="nav-card">
        <div class="nav-card-icon">🔧</div>
        <div class="nav-card-title">System</div>
        <div class="nav-card-desc">Health, readiness, and diagnostics</div>
      </a>
    </div>
  </div>

  <footer>
    <p>EdgeClaw — AI-powered network operations</p>
  </footer>

  <script>
    // Simple client-side active link tracking
    function updateActiveLink() {
      const current = window.location.pathname;
      const links = document.querySelectorAll('.navbar-nav a');
      links.forEach(link => {
        if (link.getAttribute('data-route') === current) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      });
    }

    updateActiveLink();
    window.addEventListener('hashchange', updateActiveLink);
  </script>
</body>
</html>`;
}

function renderConfigPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EdgeClaw Config</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
    }
    .page {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid #e0e0e0;
    }
    h1 { margin: 0; font-size: 24px; }
    .subtitle { color: #666; margin: 4px 0 0; font-size: 13px; }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    button, .link-btn {
      padding: 10px 14px;
      border: 1px solid #d0d0d0;
      background: white;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
    }
    button.primary {
      background: #2563eb;
      border-color: #2563eb;
      color: white;
    }
    .status {
      margin-bottom: 16px;
      padding: 10px 12px;
      border-radius: 6px;
      background: #eef2ff;
      color: #1e3a8a;
      font-size: 13px;
    }
    .status.error {
      background: #fef2f2;
      color: #991b1b;
    }
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 16px;
      border-bottom: 2px solid #e5e7eb;
      background: white;
      border-radius: 8px 8px 0 0;
      overflow: hidden;
    }
    .tab-btn {
      flex: 1;
      padding: 12px 16px;
      border: none;
      background: #f9fafb;
      border-bottom: 3px solid #f9fafb;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: #666;
      transition: all 0.2s;
      text-align: center;
      white-space: nowrap;
    }
    .tab-btn.active {
      background: white;
      color: #2563eb;
      border-bottom-color: #2563eb;
    }
    .tab-btn:hover {
      background: white;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .layout {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .panel h2, .panel h3 {
      margin: 0 0 12px;
      font-size: 16px;
    }
    .panel h3 {
      font-size: 14px;
      margin-top: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    label {
      font-size: 12px;
      color: #555;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    input[type="text"],
    input[type="number"],
    textarea,
    select {
      width: 100%;
      padding: 9px 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font: inherit;
      background: white;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    .json-editor {
      min-height: 600px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
    }
    .check-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }
    .check-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
    .agent-card,
    .route-card,
    .channel-card,
    .route-class-card {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
      background: #fafafa;
    }
    .route-class-card {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 12px;
    }
    .warning {
      margin-bottom: 16px;
      padding: 12px 14px;
      border-radius: 6px;
      background: #fefce8;
      border: 1px solid #fde047;
      color: #854d0e;
      font-size: 13px;
      line-height: 1.5;
    }
    .warning-title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .hint {
      margin-top: 8px;
      font-size: 12px;
      color: #666;
    }
    .route-assignments {
      display: grid;
      gap: 10px;
    }
    .route-assignment {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 12px;
      align-items: center;
      padding: 10px;
      background: white;
      border-radius: 6px;
      border: 1px solid #f0f0f0;
    }
    .route-assignment label {
      margin: 0;
      min-width: 120px;
    }
    @media (max-width: 980px) {
      .tabs {
        flex-wrap: wrap;
      }
      .tab-btn {
        flex: none;
        min-width: 100px;
      }
      .grid, .check-grid {
        grid-template-columns: 1fr;
      }
      .two-col {
        grid-template-columns: 1fr;
      }
      header {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>EdgeClaw Config</h1>
        <p class="subtitle">Same-origin configuration editor for project settings, agents, models, channels, and security.</p>
      </div>
      <div class="toolbar">
        <a class="link-btn" href="/config/export">Export JSON</a>
        <button id="validate-btn">Validate</button>
        <button id="save-btn" class="primary">Save</button>
      </div>
    </header>

    <div id="status" class="status">Loading config...</div>

    <div id="warnings-container"></div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="general">General</button>
      <button class="tab-btn" data-tab="agents">Agents</button>
      <button class="tab-btn" data-tab="ai-gateway">AI Gateway</button>
      <button class="tab-btn" data-tab="features">Features</button>
      <button class="tab-btn" data-tab="channels">Channels</button>
      <button class="tab-btn" data-tab="security">Security</button>
      <button class="tab-btn" data-tab="mcp">MCP</button>
      <button class="tab-btn" data-tab="raw-json">Raw JSON</button>
    </div>

    <!-- General Tab -->
    <div id="tab-general" class="tab-content active">
      <div class="layout">
        <section class="panel">
          <h2>Project</h2>
          <div class="grid">
            <div class="field full">
              <label for="project-name">Project Name</label>
              <input id="project-name" type="text" />
            </div>
            <div class="field">
              <label for="project-version">Version</label>
              <input id="project-version" type="text" />
            </div>
            <div class="field">
              <label for="project-org">Org ID</label>
              <input id="project-org" type="text" />
            </div>
            <div class="field full">
              <label for="project-description">Description</label>
              <textarea id="project-description"></textarea>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>Default Model Routes</h2>
          <div class="grid">
            <div class="field">
              <label for="default-provider">Default Provider</label>
              <input id="default-provider" type="text" />
            </div>
            <div class="field">
              <label for="default-model">Default Model</label>
              <input id="default-model" type="text" />
            </div>
          </div>
          <p class="hint">These defaults apply to all agents unless overridden per-agent.</p>
        </section>
      </div>
    </div>

    <!-- Agents Tab -->
    <div id="tab-agents" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Agents</h2>
          <div id="agents-panel"></div>
        </section>
      </div>
    </div>

    <!-- AI Gateway Tab -->
    <div id="tab-ai-gateway" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>AI Gateway Configuration</h2>
          <div class="grid">
            <div class="field full check-item" style="margin-top: 12px;">
              <input id="ai-gateway-enabled" type="checkbox" />
              <label for="ai-gateway-enabled" style="margin: 0; text-transform: none; letter-spacing: 0;">Enable AI Gateway Integration</label>
            </div>
            <div class="field">
              <label for="ai-gateway-base-url">Gateway Base URL</label>
              <input id="ai-gateway-base-url" type="text" />
            </div>
            <div class="field">
              <label for="ai-gateway-default-class">Default Route Class</label>
              <select id="ai-gateway-default-class">
                <option value="utility">utility</option>
                <option value="tools">tools</option>
                <option value="reasoning">reasoning</option>
                <option value="vision">vision</option>
              </select>
            </div>
          </div>
          <p class="hint">AI Gateway integrates with Cloudflare's models API for intelligent routing and model selection.</p>

          <h3>Route Classes</h3>
          <div id="route-classes-panel"></div>

          <h3>Route Assignments</h3>
          <p style="margin: 0 0 12px; font-size: 13px; color: #666;">Assign specific route classes to different agents and operations:</p>
          <div class="route-assignments" id="route-assignments-panel"></div>
        </section>
      </div>
    </div>

    <!-- Features Tab -->
    <div id="tab-features" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Feature Flags</h2>
          <div id="features-panel" class="check-grid"></div>
        </section>
      </div>
    </div>

    <!-- Channels Tab -->
    <div id="tab-channels" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Channels</h2>
          <div id="channels-panel"></div>
        </section>
      </div>
    </div>

    <!-- Security Tab -->
    <div id="tab-security" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Security & Approval</h2>
          <div class="grid">
            <div class="field">
              <label for="security-threshold">Audit Score Threshold</label>
              <input id="security-threshold" type="number" step="0.01" min="0" max="1" />
            </div>
            <div class="field check-item" style="margin-top: 24px;">
              <input id="security-escalation" type="checkbox" />
              <label for="security-escalation" style="margin: 0; text-transform: none; letter-spacing: 0;">Require approval on escalation</label>
            </div>
            <div class="field full">
              <label for="security-roles">Approval Roles (comma separated)</label>
              <input id="security-roles" type="text" />
            </div>
            <div class="field full">
              <label for="security-teams">Allowed Access Teams (comma separated)</label>
              <input id="security-teams" type="text" />
            </div>
            <div class="field check-item" style="margin-top: 4px;">
              <input id="security-api-key" type="checkbox" />
              <label for="security-api-key" style="margin: 0; text-transform: none; letter-spacing: 0;">Allow API key auth</label>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- MCP Tab -->
    <div id="tab-mcp" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Model Context Protocol (MCP)</h2>
          <div class="grid">
            <div class="field full check-item" style="margin-top: 12px;">
              <input id="mcp-enabled" type="checkbox" />
              <label for="mcp-enabled" style="margin: 0; text-transform: none; letter-spacing: 0;">Enable MCP Support</label>
            </div>
          </div>
          <div id="mcp-servers-panel"></div>
          <p class="hint">MCP servers provide tools and resources to agents. Configure available servers below.</p>
        </section>
      </div>
    </div>

    <!-- Raw JSON Tab -->
    <div id="tab-raw-json" class="tab-content">
      <div class="layout">
        <section class="panel">
          <h2>Raw JSON Editor</h2>
          <textarea id="json-editor" class="json-editor"></textarea>
          <p class="hint">Edit the raw configuration directly. Changes are applied when you switch tabs or save.</p>
        </section>
      </div>
    </div>

  </div>

  <script>
    const statusEl = document.getElementById('status');
    const warningsContainerEl = document.getElementById('warnings-container');
    const jsonEditorEl = document.getElementById('json-editor');
    const agentsPanelEl = document.getElementById('agents-panel');
    const featuresPanelEl = document.getElementById('features-panel');
    const channelsPanelEl = document.getElementById('channels-panel');
    const routeClassesPanelEl = document.getElementById('route-classes-panel');
    const routeAssignmentsPanelEl = document.getElementById('route-assignments-panel');
    const mcpServersPanelEl = document.getElementById('mcp-servers-panel');

    const projectNameEl = document.getElementById('project-name');
    const projectVersionEl = document.getElementById('project-version');
    const projectOrgEl = document.getElementById('project-org');
    const projectDescriptionEl = document.getElementById('project-description');
    const defaultProviderEl = document.getElementById('default-provider');
    const defaultModelEl = document.getElementById('default-model');
    const aiGatewayEnabledEl = document.getElementById('ai-gateway-enabled');
    const aiGatewayBaseUrlEl = document.getElementById('ai-gateway-base-url');
    const aiGatewayDefaultClassEl = document.getElementById('ai-gateway-default-class');
    const mcpEnabledEl = document.getElementById('mcp-enabled');
    const securityThresholdEl = document.getElementById('security-threshold');
    const securityEscalationEl = document.getElementById('security-escalation');
    const securityRolesEl = document.getElementById('security-roles');
    const securityTeamsEl = document.getElementById('security-teams');
    const securityApiKeyEl = document.getElementById('security-api-key');

    const validateBtn = document.getElementById('validate-btn');
    const saveBtn = document.getElementById('save-btn');

    let configState = null;

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.className = isError ? 'status error' : 'status';
    }

    function commaSplit(value) {
      return value.split(',').map(v => v.trim()).filter(Boolean);
    }

    function switchTab(tabName) {
      // Always commit the current tab state before switching.
      const rawJsonTab = document.getElementById('tab-raw-json');
      const isLeavingRawJson = rawJsonTab && rawJsonTab.classList.contains('active');

      if (isLeavingRawJson) {
        // If JSON is invalid, stay on Raw JSON so the user can fix it.
        if (!updateStateFromRawEditor()) {
          return;
        }
      } else if (configState) {
        // Capture in-progress form edits even if a specific input/change event did not fire yet.
        updateStateFromForm();
      }

      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      
      const tabEl = document.getElementById('tab-' + tabName);
      if (tabEl) {
        tabEl.classList.add('active');
      }
      
      const btnEl = document.querySelector('[data-tab="' + tabName + '"]');
      if (btnEl) {
        btnEl.classList.add('active');
      }
    }

    function checkValidationWarnings() {
      const warnings = [];

      if (!configState) return warnings;

      const aiGateway = configState.aiGateway || {};
      if (aiGateway.enabled && !aiGateway.baseUrl) {
        warnings.push({
          type: 'warning',
          title: 'AI Gateway enabled but base URL missing',
          message: 'Enable AI Gateway in the AI Gateway tab and provide a base URL for the gateway service.'
        });
      }

      if (aiGateway.enabled) {
        const defaultClass = aiGateway.defaultRouteClass || 'utility';
        const routeClassCfg = (aiGateway.routeClasses || {})[defaultClass] || {};
        if (!routeClassCfg.enabled) {
          warnings.push({
            type: 'warning',
            title: 'Default route class is not enabled',
            message: 'Default route class "' + defaultClass + '" is disabled. Enable it in the Route Classes section.'
          });
        }
      }

      if (aiGateway.enabled) {
        const routeLabels = {
          classifier: 'Classifier Agent',
          analyst: 'Analyst Agent',
          audit: 'Audit Agent',
          chatFreeform: 'Chat: Freeform Q&A',
          chatDeepReasoning: 'Chat: Deep Reasoning'
        };
        const routes = aiGateway.routes;
        if (routes && typeof routes === 'object') {
          for (const [assignKey, assignedClass] of Object.entries(routes)) {
            const classCfg = (aiGateway.routeClasses || {})[assignedClass] || {};
            if (assignedClass && !classCfg.enabled) {
              const label = routeLabels[assignKey] || assignKey;
              warnings.push({
                type: 'warning',
                title: 'Assigned route class is disabled',
                message: '"' + label + '" is assigned to route class "' + assignedClass + '" but that class is disabled. Enable it in the Route Classes section.'
              });
            }
          }
        }
      }

      const mcpEnabled = configState.mcp?.enabled;
      const mcpServers = configState.mcp?.servers || {};
      if (mcpEnabled && Object.keys(mcpServers).length === 0) {
        warnings.push({
          type: 'warning',
          title: 'MCP enabled with no servers configured',
          message: 'Enable MCP support but no servers are configured. Add servers in the MCP tab.'
        });
      }

      return warnings;
    }

    function renderWarnings() {
      const warnings = checkValidationWarnings();
      warningsContainerEl.innerHTML = warnings.map(w => 
        '<div class="warning">' +
        '  <div class="warning-title">' + escapeHtml(w.title) + '</div>' +
        '  <div>' + escapeHtml(w.message) + '</div>' +
        '</div>'
      ).join('');
    }

    function createDefaultConfig() {
      const now = new Date().toISOString();
      return {
        metadata: {
          version: '1.0.0',
          name: 'EdgeClaw',
          description: '',
          orgId: 'hilton',
          createdAt: now,
          updatedAt: now,
          createdBy: 'config-ui'
        },
        agents: {
          analyst: { name: 'Analyst', systemPrompt: '', enabled: true },
          dispatcher: { name: 'Dispatcher', systemPrompt: '', enabled: true },
          chat: { name: 'Chat', systemPrompt: '', enabled: true }
        },
        features: {
          chatTaskCreation: true,
          approvalWorkflows: true,
          auditMode: true,
          aiGatewayIntegration: false,
          worklogPersistence: true
        },
        models: {
          default: { provider: 'cloudflare-ai', name: '@cf/meta/llama-3.1-8b-instruct', config: { useAIGateway: false } },
          byAgent: {
            analyst: { provider: 'cloudflare-ai', name: '@cf/meta/llama-3.1-8b-instruct', useAIGateway: false, routeClass: 'reasoning' },
            dispatcher: { provider: 'cloudflare-ai', name: '@cf/meta/llama-3.1-8b-instruct', config: { useAIGateway: false } },
            chat: { provider: 'cloudflare-ai', name: '@cf/meta/llama-3.1-8b-instruct', config: { useAIGateway: false } }
          }
        },
        aiGateway: {
          enabled: false,
          baseUrl: '',
          defaultRouteClass: 'utility',
          routeClasses: {
            utility: { enabled: true, route: 'utility' },
            tools: { enabled: true, route: 'tools' },
            reasoning: { enabled: true, route: 'reasoning' },
            vision: { enabled: false, route: 'vision' }
          },
          routes: {
            classifier: 'utility',
            analyst: 'reasoning',
            audit: 'reasoning',
            chatFreeform: 'utility',
            chatDeepReasoning: 'reasoning'
          }
        },
        channels: {
          chat: { enabled: true },
          tasksConsole: { enabled: true },
          system: { enabled: true },
          api: { enabled: true }
        },
        security: {
          approvalRules: {
            onEscalation: true,
            auditScoreThreshold: 0.75,
            domainsRequiringApproval: [],
            taskTypesRequiringApproval: []
          },
          approvalRoles: [],
          allowedAccessTeams: [],
          allowApiKeyAuth: true,
          rateLimiting: {}
        },
        mcp: {
          enabled: false,
          servers: {}
        },
        storage: {
          artifactBucket: 'R2_ARTIFACTS',
          worklogBucket: 'R2_WORKLOGS',
          orgPrefix: 'org/hilton',
          versionedConfigHistory: true
        }
      };
    }

    function syncRawEditor() {
      jsonEditorEl.value = JSON.stringify(configState, null, 2);
    }

    function ensureConfigShape() {
      configState.metadata = configState.metadata || {};
      configState.agents = configState.agents || {};
      configState.features = configState.features || {};
      configState.models = configState.models || {};
      configState.models.default = configState.models.default || { provider: '', name: '', config: {} };
      configState.models.byAgent = configState.models.byAgent || {};
      configState.models.byAgent.analyst = configState.models.byAgent.analyst || {
        provider: 'cloudflare-ai',
        name: '@cf/meta/llama-3.1-8b-instruct',
        useAIGateway: false,
        routeClass: 'reasoning'
      };
      configState.aiGateway = configState.aiGateway || {};
      configState.aiGateway.baseUrl = configState.aiGateway.baseUrl || '';
      configState.aiGateway.routeClasses = configState.aiGateway.routeClasses || {};
      configState.aiGateway.routeClasses.utility = configState.aiGateway.routeClasses.utility || { enabled: true, route: 'utility' };
      configState.aiGateway.routeClasses.tools = configState.aiGateway.routeClasses.tools || { enabled: true, route: 'tools' };
      configState.aiGateway.routeClasses.reasoning = configState.aiGateway.routeClasses.reasoning || { enabled: true, route: 'reasoning' };
      configState.aiGateway.routeClasses.vision = configState.aiGateway.routeClasses.vision || { enabled: false, route: 'vision' };
      configState.aiGateway.routes = configState.aiGateway.routes || {};
      configState.channels = configState.channels || {};
      configState.security = configState.security || {};
      configState.security.approvalRules = configState.security.approvalRules || {};
      configState.security.approvalRoles = Array.isArray(configState.security.approvalRoles) ? configState.security.approvalRoles : [];
      configState.security.allowedAccessTeams = Array.isArray(configState.security.allowedAccessTeams) ? configState.security.allowedAccessTeams : [];
      configState.mcp = configState.mcp || { enabled: false, servers: {} };
    }

    function renderAgents() {
      const agentKeys = Object.keys(configState.agents || {}).sort();
      agentsPanelEl.innerHTML = agentKeys.map((key) => {
        const agent = configState.agents[key] || {};
        return '<div class="agent-card">' +
          '<div class="grid">' +
          '  <div class="field">' +
          '    <label>' + key + ' Display Name</label>' +
          '    <input type="text" data-agent-name="' + key + '" value="' + escapeHtml(agent.name || '') + '" />' +
          '  </div>' +
          '  <div class="field check-item" style="margin-top: 24px;">' +
          '    <input type="checkbox" data-agent-enabled="' + key + '" ' + (agent.enabled ? 'checked' : '') + ' />' +
          '    <label style="margin: 0; text-transform: none; letter-spacing: 0;">Enabled</label>' +
          '  </div>' +
          '  <div class="field full">' +
          '    <label>' + key + ' Persona</label>' +
          '    <textarea data-agent-prompt="' + key + '">' + escapeHtml(agent.systemPrompt || '') + '</textarea>' +
          '  </div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderFeatures() {
      const keys = Object.keys(configState.features || {}).sort();
      featuresPanelEl.innerHTML = keys.map((key) => {
        return '<label class="check-item">' +
          '<input type="checkbox" data-feature-key="' + key + '" ' + (configState.features[key] ? 'checked' : '') + ' />' +
          '<span>' + key + '</span>' +
        '</label>';
      }).join('');
    }

    function renderRouteClasses() {
      const routeClasses = configState.aiGateway.routeClasses || {};
      const classNames = ['utility', 'tools', 'reasoning', 'vision'];
      routeClassesPanelEl.innerHTML = classNames.map((className) => {
        const cfg = routeClasses[className] || { enabled: false, route: className };
        return '<div class="route-class-card">' +
          '<input type="checkbox" data-route-class-toggle="' + className + '" ' + (cfg.enabled ? 'checked' : '') + ' />' +
          '<div style="display: flex; flex-direction: column; gap: 8px; flex: 1;">' +
          '  <label style="margin: 0; text-transform: none; font-weight: 600;">' + className + '</label>' +
          '  <input type="text" placeholder="Route name" data-route-class-name="' + className + '" value="' + escapeHtml(cfg.route || '') + '" style="font-size: 12px;" />' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderRouteAssignments() {
      const routes = configState.aiGateway.routes || {};
      const assignments = [
        { key: 'classifier', label: 'Classifier Agent' },
        { key: 'analyst', label: 'Analyst Agent' },
        { key: 'audit', label: 'Audit Agent' },
        { key: 'chatFreeform', label: 'Chat: Freeform Q&A' },
        { key: 'chatDeepReasoning', label: 'Chat: Deep Reasoning' }
      ];
      routeAssignmentsPanelEl.innerHTML = assignments.map(({ key, label }) => {
        const currentClass = routes[key] || 'utility';
        return '<div class="route-assignment">' +
          '<label style="margin: 0;">' + label + '</label>' +
          '<select data-route-assignment="' + key + '" style="width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px; font: inherit;">' +
          '  <option value="utility" ' + (currentClass === 'utility' ? 'selected' : '') + '>utility</option>' +
          '  <option value="tools" ' + (currentClass === 'tools' ? 'selected' : '') + '>tools</option>' +
          '  <option value="reasoning" ' + (currentClass === 'reasoning' ? 'selected' : '') + '>reasoning</option>' +
          '  <option value="vision" ' + (currentClass === 'vision' ? 'selected' : '') + '>vision</option>' +
          '</select>' +
        '</div>';
      }).join('');
    }

    function renderChannels() {
      const keys = Object.keys(configState.channels || {}).sort();
      channelsPanelEl.innerHTML = keys.map((key) => {
        const channel = configState.channels[key] || {};
        return '<div class="channel-card">' +
          '<label class="check-item">' +
          '<input type="checkbox" data-channel-key="' + key + '" ' + (channel.enabled ? 'checked' : '') + ' />' +
          '<span>' + key + ' enabled</span>' +
          '</label>' +
          '</div>';
      }).join('');
    }

    function renderMcpServers() {
      const mcp = configState.mcp || { enabled: false, servers: {} };
      const servers = mcp.servers || {};
      const serverNames = Object.keys(servers).sort();
      
      mcpServersPanelEl.innerHTML = '<div style="margin-top: 12px;">' +
        (serverNames.length === 0 
          ? '<p style="font-size: 13px; color: #666; margin: 0;">No MCP servers configured. Add servers by editing the raw JSON or extend this UI.</p>'
          : serverNames.map(name => {
              const server = servers[name] || {};
              return '<div class="route-card">' +
                '<label style="margin: 0; font-weight: 600; text-transform: none;">' + escapeHtml(name) + '</label>' +
                '<p style="margin: 4px 0 0; font-size: 12px; color: #666;">' + (server.description || 'No description') + '</p>' +
              '</div>';
            }).join('')
        ) +
        '</div>';
    }

    function renderForm() {
      ensureConfigShape();
      projectNameEl.value = configState.metadata.name || '';
      projectVersionEl.value = configState.metadata.version || '';
      projectOrgEl.value = configState.metadata.orgId || '';
      projectDescriptionEl.value = configState.metadata.description || '';
      defaultProviderEl.value = configState.models.default.provider || '';
      defaultModelEl.value = configState.models.default.name || '';
      aiGatewayEnabledEl.checked = !!configState.aiGateway.enabled;
      aiGatewayBaseUrlEl.value = configState.aiGateway.baseUrl || '';
      aiGatewayDefaultClassEl.value = configState.aiGateway.defaultRouteClass || 'utility';
      mcpEnabledEl.checked = !!configState.mcp.enabled;
      securityThresholdEl.value = configState.security.approvalRules.auditScoreThreshold ?? '';
      securityEscalationEl.checked = !!configState.security.approvalRules.onEscalation;
      securityRolesEl.value = (configState.security.approvalRoles || []).join(', ');
      securityTeamsEl.value = (configState.security.allowedAccessTeams || []).join(', ');
      securityApiKeyEl.checked = !!configState.security.allowApiKeyAuth;
      renderAgents();
      renderFeatures();
      renderChannels();
      renderRouteClasses();
      renderRouteAssignments();
      renderMcpServers();
      renderWarnings();
      syncRawEditor();
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function updateStateFromForm() {
      ensureConfigShape();
      configState.metadata.name = projectNameEl.value.trim();
      configState.metadata.version = projectVersionEl.value.trim();
      configState.metadata.orgId = projectOrgEl.value.trim();
      configState.metadata.description = projectDescriptionEl.value.trim();
      configState.models.default.provider = defaultProviderEl.value.trim();
      configState.models.default.name = defaultModelEl.value.trim();
      configState.models.default.config = configState.models.default.config || {};
      configState.models.default.config.useAIGateway = !!configState.features.aiGatewayIntegration;
      configState.aiGateway.enabled = !!aiGatewayEnabledEl.checked;
      configState.aiGateway.baseUrl = aiGatewayBaseUrlEl.value.trim();
      configState.aiGateway.defaultRouteClass = aiGatewayDefaultClassEl.value;
      configState.mcp.enabled = !!mcpEnabledEl.checked;
      configState.security.approvalRules.auditScoreThreshold = securityThresholdEl.value === '' ? undefined : Number(securityThresholdEl.value);
      configState.security.approvalRules.onEscalation = securityEscalationEl.checked;
      configState.security.approvalRoles = commaSplit(securityRolesEl.value);
      configState.security.allowedAccessTeams = commaSplit(securityTeamsEl.value);
      configState.security.allowApiKeyAuth = securityApiKeyEl.checked;

      // Keep route-related fields synchronized even if a specific change handler misses.
      document.querySelectorAll('[data-route-class-toggle]').forEach((el) => {
        const className = el.dataset.routeClassToggle;
        if (!className) return;
        configState.aiGateway.routeClasses[className] = configState.aiGateway.routeClasses[className] || { enabled: false, route: className };
        configState.aiGateway.routeClasses[className].enabled = !!el.checked;
      });

      document.querySelectorAll('[data-route-class-name]').forEach((el) => {
        const className = el.dataset.routeClassName;
        if (!className) return;
        configState.aiGateway.routeClasses[className] = configState.aiGateway.routeClasses[className] || { enabled: false, route: className };
        configState.aiGateway.routeClasses[className].route = (el.value || '').trim();
      });

      document.querySelectorAll('[data-route-assignment]').forEach((el) => {
        const assignmentKey = el.dataset.routeAssignment;
        if (!assignmentKey) return;
        configState.aiGateway.routes[assignmentKey] = el.value;
      });

      configState.metadata.updatedAt = new Date().toISOString();
      syncRawEditor();
      renderWarnings();
    }

    function updateStateFromRawEditor() {
      try {
        configState = JSON.parse(jsonEditorEl.value);
        renderForm();
        setStatus('Raw JSON applied.');
        return true;
      } catch (err) {
        setStatus('Raw JSON parse error: ' + (err.message || 'Invalid JSON'), true);
        return false;
      }
    }

    async function loadConfig() {
      try {
        const res = await fetch('/config');
        if (res.status === 404) {
          configState = createDefaultConfig();
          renderForm();
          setStatus('No config found. Started a new editable config.');
          return;
        }
        if (!res.ok) throw new Error('Failed to load config');
        const data = await res.json();
        configState = data.config || createDefaultConfig();
        renderForm();
        setStatus('Config loaded.');
      } catch (err) {
        configState = createDefaultConfig();
        renderForm();
        setStatus('Load failed: ' + (err.message || 'Unknown error'), true);
      }
    }

    async function validateConfig() {
      const payload = updateStateFromRawEditor() ? configState : null;
      if (!payload) return;
      try {
        const res = await fetch('/config/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error((data.errors || []).join('; ') || data.error || 'Validation failed');
        }
        setStatus('Validation passed.');
      } catch (err) {
        setStatus('Validation failed: ' + (err.message || 'Unknown error'), true);
      }
    }

    async function saveConfig() {
      const payload = updateStateFromRawEditor() ? configState : null;
      if (!payload) return;
      try {
        const res = await fetch('/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error((data.errors || []).join('; ') || data.error || 'Save failed');
        }
        configState = data.config || payload;
        renderForm();
        setStatus('Config saved as version ' + (data.version || configState.metadata.version) + '.');
      } catch (err) {
        setStatus('Save failed: ' + (err.message || 'Unknown error'), true);
      }
    }

    document.addEventListener('click', (event) => {
      const tabButton = event.target.closest('.tab-btn');
      if (!tabButton) return;
      const tabName = tabButton.dataset.tab;
      if (tabName) {
        switchTab(tabName);
      }
    });

    document.addEventListener('input', (event) => {
      if (!configState) return;
      const target = event.target;
      if (target === jsonEditorEl) return;

      if (target.dataset.agentName) {
        configState.agents[target.dataset.agentName].name = target.value;
      }
      if (target.dataset.agentPrompt) {
        configState.agents[target.dataset.agentPrompt].systemPrompt = target.value;
      }
      if (target.dataset.featureKey) {
        configState.features[target.dataset.featureKey] = !!target.checked;
      }
      updateStateFromForm();
    });

    document.addEventListener('change', (event) => {
      if (!configState) return;
      const target = event.target;

      if (target.dataset.agentEnabled) {
        configState.agents[target.dataset.agentEnabled].enabled = !!target.checked;
      }
      if (target.dataset.channelKey) {
        configState.channels[target.dataset.channelKey].enabled = !!target.checked;
      }
      if (target.dataset.routeClassToggle) {
        configState.aiGateway.routeClasses[target.dataset.routeClassToggle].enabled = !!target.checked;
        renderRouteClasses();
      }
        if (target.dataset.routeClassName) {
        configState.aiGateway.routeClasses[target.dataset.routeClassName].route = target.value;
      }
      if (target.dataset.routeAssignment) {
        configState.aiGateway.routes[target.dataset.routeAssignment] = target.value;
      }
      if (target === jsonEditorEl) {
        updateStateFromRawEditor();
        return;
      }
      updateStateFromForm();
    });

    validateBtn.addEventListener('click', validateConfig);
    saveBtn.addEventListener('click', saveConfig);

    loadConfig();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const missingEnv = validateCriticalEnv(env);
      if (missingEnv.length > 0) {
        const message = `Missing required environment bindings: ${missingEnv.join(", ")}`;
        console.error(message, {
          hasR2Artifacts: !!env.R2_ARTIFACTS,
          hasR2Worklogs: !!env.R2_WORKLOGS,
          hasTaskCoordinator: !!env.TASK_COORDINATOR,
        });
        return json({ ok: false, error: message }, 500);
      }

      const url = new URL(request.url);
      const { pathname, origin } = url;
      const baseUrl = origin;
      const browserAuth = isBrowserFacingRoute(pathname) || isConfigApiRoute(pathname)
        ? authenticateRequest(request, env)
        : null;

      // ── GET /health ───────────────────────────────────────────────────────
      // Lightweight liveness probe: process is up and serving requests.
      if (request.method === "GET" && pathname === "/health") {
        return json({ ok: true }, 200);
      }

      // ── GET /ready ────────────────────────────────────────────────────────
      // Non-destructive readiness checks for critical dependencies.
      if (request.method === "GET" && pathname === "/ready") {
        const checks: Record<string, boolean> = {
          r2ArtifactsAccess: false,
          r2WorklogsAccess: false,
          taskCoordinatorUsable: false,
        };
        const errors: string[] = [];

        try {
          await env.R2_ARTIFACTS.list({ prefix: "org/hilton/ready-check/" });
          checks.r2ArtifactsAccess = true;
        } catch (error: unknown) {
          errors.push(`R2_ARTIFACTS check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }

        try {
          await env.R2_WORKLOGS.list({ prefix: "org/hilton/ready-check/" });
          checks.r2WorklogsAccess = true;
        } catch (error: unknown) {
          errors.push(`R2_WORKLOGS check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }

        try {
          const probeTaskId = `ready-${crypto.randomUUID()}`;
          const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(probeTaskId));
          const stateResponse = await stub.fetch("https://task-coordinator/state");
          // 404 is acceptable for an uninitialized coordinator; binding is still usable.
          checks.taskCoordinatorUsable = stateResponse.status === 404 || stateResponse.ok;
          if (!checks.taskCoordinatorUsable) {
            errors.push(`TASK_COORDINATOR check returned status ${stateResponse.status}`);
          }
        } catch (error: unknown) {
          errors.push(`TASK_COORDINATOR check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }

        const ready = checks.r2ArtifactsAccess && checks.r2WorklogsAccess && checks.taskCoordinatorUsable;
        return json({ ok: ready, checks, errors: errors.length > 0 ? errors : undefined }, ready ? 200 : 503);
      }

      // ── GET / ─────────────────────────────────────────────────────────────
      // App shell with navigation hub to all main pages.
      if (request.method === "GET" && pathname === "/") {
        return new Response(renderAppShell(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── GET /system ────────────────────────────────────────────────────────
      // System status dashboard: health, readiness, task activity.
      if (request.method === "GET" && pathname === "/system") {
        return new Response(renderSystemPage(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── GET /config-ui ─────────────────────────────────────────────────────
      // Browser-facing configuration editor.
      if (request.method === "GET" && pathname === "/config-ui") {
        if (!browserAuth?.isAuthenticated) {
          return json({ ok: false, error: "Unauthorized." }, 401);
        }
        return new Response(renderConfigPage(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (isConfigApiRoute(pathname)) {
        if (!browserAuth?.isAuthenticated) {
          const configuredApiKey = getConfiguredApiKey(env);
          if (!configuredApiKey) {
            console.error("Protected routes requested but API key is not configured", { pathname });
            return json({ ok: false, error: "Server auth is not configured." }, 500);
          }

          if (!hasValidApiKey(request, configuredApiKey)) {
            return json({ ok: false, error: "Unauthorized." }, 401);
          }
        }
      } else if (isApiKeyOnlyRoute(pathname)) {
        const configuredApiKey = getConfiguredApiKey(env);
        if (!configuredApiKey) {
          console.error("Protected routes requested but API key is not configured", { pathname });
          return json({ ok: false, error: "Server auth is not configured." }, 500);
        }

        if (!hasValidApiKey(request, configuredApiKey)) {
          return json({ ok: false, error: "Unauthorized." }, 401);
        }
      } else if (isBrowserFacingRoute(pathname)) {
        if (!browserAuth?.isAuthenticated) {
          return json({ ok: false, error: "Unauthorized." }, 401);
        }
      } else if (isProtectedApiPath(pathname)) {
        const configuredApiKey = getConfiguredApiKey(env);
        if (!configuredApiKey) {
          console.error("Protected routes requested but API key is not configured", { pathname });
          return json({ ok: false, error: "Server auth is not configured." }, 500);
        }

        if (!hasValidApiKey(request, configuredApiKey)) {
          return json({ ok: false, error: "Unauthorized." }, 401);
        }
      }

      // Route Cloudflare Agents SDK requests before custom app routing.
      // Return directly to preserve WebSocket upgrades and stream semantics.
      const agentResponse = await routeAgentRequest(request, env, { prefix: "/api/agents" });
      if (agentResponse) return agentResponse;

      // ── GET /config ────────────────────────────────────────────────────────
      // Returns the current EdgeClaw configuration.
      if (request.method === "GET" && pathname === "/config") {
        const config = await getEdgeClawConfig(env.R2_ARTIFACTS);
        if (!config) {
          return json({ ok: false, error: "No configuration found." }, 404);
        }
        return json({ ok: true, config }, 200);
      }

      // ── POST /config/validate ──────────────────────────────────────────────
      // Validates a config without saving it.
      if (request.method === "POST" && pathname === "/config/validate") {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) return parsed.response;
        
        const validation = validateEdgeClawConfig(parsed.body);
        if (!validation.ok) {
          return json({
            ok: false,
            errors: validation.errors,
          }, 400);
        }
        return json({ ok: true, message: "Config is valid" }, 200);
      }

      // ── PUT /config ────────────────────────────────────────────────────────
      // Validates and saves a new configuration version.
      if (request.method === "PUT" && pathname === "/config") {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) return parsed.response;

        const validation = validateEdgeClawConfig(parsed.body);
        if (!validation.ok) {
          return json({
            ok: false,
            errors: validation.errors,
          }, 400);
        }

        const newConfig = validation.config!;
        const oldConfig = await getEdgeClawConfig(env.R2_ARTIFACTS);
        
        // Auto-increment version if not specified
        if (!oldConfig || oldConfig.metadata.version === newConfig.metadata.version) {
          newConfig.metadata.version = oldConfig 
            ? nextVersion(oldConfig.metadata.version)
            : "1.0.0";
        }

        newConfig.metadata.updatedAt = new Date().toISOString();

        const saved = await saveEdgeClawConfig(env.R2_ARTIFACTS, newConfig);
        if (!saved.ok) {
          return json({ ok: false, error: saved.error }, 500);
        }

        const historyEntry: ConfigChangeEntry = {
          timestamp: new Date().toISOString(),
          version: newConfig.metadata.version,
          actor:
            browserAuth?.mode === "access-browser" && browserAuth.userId
              ? browserAuth.userId
              : "api",
          summary: `Config updated to v${newConfig.metadata.version}`,
        };
        await appendConfigHistory(env.R2_ARTIFACTS, historyEntry);

        return json({
          ok: true,
          message: "Config saved",
          version: newConfig.metadata.version,
          config: newConfig,
        }, 200);
      }

      // ── GET /config/export ─────────────────────────────────────────────────
      // Returns raw config JSON suitable for file download.
      if (request.method === "GET" && pathname === "/config/export") {
        const config = await getEdgeClawConfig(env.R2_ARTIFACTS);
        if (!config) {
          return json({ ok: false, error: "No configuration found." }, 404);
        }
        return new Response(JSON.stringify(config, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="edgeclaw-v${config.metadata.version}.json"`,
          },
        });
      }

      // ── GET /chat ──────────────────────────────────────────────────────────
      // Minimal frontend entrypoint. No bundler or React runtime required.
      if (request.method === "GET" && pathname === "/chat") {
        return new Response(renderChatPage(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── GET /tasks-console ─────────────────────────────────────────────────
      // Minimal task management UI for viewing task status and approval.
      if (request.method === "GET" && pathname === "/tasks-console") {
        return new Response(renderTasksConsole(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── POST /api/chat/sessions ────────────────────────────────────────────
      // Creates a new persistent chat session.
      if (request.method === "POST" && pathname === "/api/chat/sessions") {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        const body = parsed.body as Record<string, unknown>;
        const userId =
          browserAuth?.mode === "access-browser" && browserAuth.userId
            ? browserAuth.userId
            : typeof body.userId === "string" && body.userId
              ? body.userId
              : "anonymous-user";
        const title = typeof body.title === "string" ? body.title : "New chat";
        const session = createChatSession(userId, title);
        const saved = await putChatSession(env.R2_ARTIFACTS, session);
        if (!saved.ok) {
          return json({ ok: false, error: saved.error }, 500);
        }
        return json({ ok: true, session, messages: [] }, 201);
      }

      // ── GET /api/chat/sessions/:sessionId/messages ────────────────────────
      // Replays persisted message history from R2 on page load/refresh.
      const chatMessagesMatch = RE_CHAT_MESSAGES.exec(pathname);
      if (request.method === "GET" && chatMessagesMatch) {
        const sessionId = chatMessagesMatch[1];
        const session = await getChatSession(env.R2_ARTIFACTS, sessionId);
        if (!session) {
          return json({ ok: false, error: "Chat session not found." }, 404);
        }
        const messages = await listChatMessages(env.R2_ARTIFACTS, sessionId);
        return json({ ok: true, session, messages }, 200);
      }

      // ── POST /api/chat/sessions/:sessionId/messages ───────────────────────
      // Chat-agent pattern:
      //   1. persist user message
      //   2. optionally route task-like text into DispatcherAgent
      //   3. stream assistant response via SSE
      //   4. persist assistant message when complete
      if (request.method === "POST" && chatMessagesMatch) {
        const sessionId = chatMessagesMatch[1];
        const session = await getChatSession(env.R2_ARTIFACTS, sessionId);
        if (!session) {
          return json({ ok: false, error: "Chat session not found." }, 404);
        }
        const historyMessages = await listChatMessages(env.R2_ARTIFACTS, sessionId);

        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        const body = parsed.body as Record<string, unknown>;
        const action = typeof body.action === "string" ? body.action : "message";
        const content = typeof body.content === "string" ? body.content.trim() : "";
        const proposalInput = toRecord(body.proposal);
        const declaredUserName = action === "message" ? extractDeclaredUserName(content) : null;
        const userId =
          browserAuth?.mode === "access-browser" && browserAuth.userId
            ? browserAuth.userId
            : typeof body.userId === "string" && body.userId
              ? body.userId
              : session.userId;
        let sessionUserName = typeof session.userName === "string" && session.userName.trim()
          ? session.userName.trim()
          : null;

        if (declaredUserName) {
          session.userName = declaredUserName;
          session.updatedAt = new Date().toISOString();
          sessionUserName = declaredUserName;
          await putChatSession(env.R2_ARTIFACTS, session);
        }

        if (action === "message" && !content) {
          return json({ ok: false, error: "content is required." }, 400);
        }

        const userTextForLog =
          action === "run_task"
            ? `Run proposed task${proposalInput?.title && typeof proposalInput.title === "string" ? `: ${proposalInput.title}` : ""}`
            : action === "cancel_proposal"
              ? "Cancel proposed task"
              : content;

        const userMessage = createChatMessage(sessionId, { role: "user", content: userTextForLog });
        await appendChatMessage(env.R2_ARTIFACTS, userMessage);

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            void (async () => {
              try {
                controller.enqueue(encoder.encode(sseEvent({
                  type: "session",
                  data: { sessionId, userMessageId: userMessage.messageId },
                })));

                let assistantText = "";
                let taskId: string | undefined;
                let taskStatus: string | undefined;
                let assistantMeta: Record<string, unknown> | undefined;

                const requestedTaskId = extractTaskIdFromText(content);
                if (declaredUserName) {
                  assistantText = `Nice to meet you, ${declaredUserName}. I will remember your name in this chat session.`;
                  assistantMeta = {
                    renderType: "assistant_text",
                    userName: declaredUserName,
                  };
                } else if (action === "cancel_proposal") {
                  assistantText = "Canceled. No task was created. Share a new request when you want another proposal.";
                } else if (requestedTaskId && isStatusQuery(content)) {
                  const task = await getTask(env.R2_ARTIFACTS, requestedTaskId);
                  if (task) {
                    taskId = task.taskId;
                    taskStatus = task.status;
                    assistantText = [
                      `Task ${task.taskId} is currently ${task.status}.`,
                      `Approval state: ${task.approvalState}.`,
                      `Type/domain: ${task.taskType}/${task.domain}.`,
                    ].join(" ");
                  } else {
                    assistantText = `I could not find task ${requestedTaskId}. Try the exact task ID shown in an earlier message.`;
                  }
                } else if (action === "run_task") {
                  const proposal = parseTaskProposalInput(proposalInput);
                  if (!proposal) {
                    assistantText = "I could not run that proposal because required task fields were missing.";
                  } else {
                    const dispatchText = buildDispatcherTextFromProposal(proposal);
                    const dispatcher = new DispatcherAgent();
                    const routed = await dispatcher.handleInboundRequest(env, {
                      userId,
                      text: dispatchText,
                      source: "chat",
                      startWorkflow: false,
                    });

                    if (routed.ok && routed.taskId) {
                      taskId = routed.taskId;
                      taskStatus = "queued";

                      controller.enqueue(encoder.encode(sseEvent({
                        type: "task",
                        data: {
                          taskId,
                          status: taskStatus,
                          taskType: routed.taskType,
                          domain: routed.domain,
                          title: proposal.title,
                        },
                      })));

                      controller.enqueue(encoder.encode(sseEvent({
                        type: "task_progress",
                        data: {
                          taskId,
                          status: "in_progress",
                          stage: "workflow_start",
                          message: "Workflow started from chat",
                          timestamp: new Date().toISOString(),
                        },
                      })));

                      const workflow = new TaskWorkflow();
                      const runResult = await workflow.run(env, {
                        taskId,
                        workflowRunId: crypto.randomUUID(),
                      });

                      const leaseConflict = isLeaseConflictRunFailure(runResult.status, runResult.error);
                      const currentTaskState = leaseConflict ? await getTask(env.R2_ARTIFACTS, taskId) : null;
                      const effectiveStatus = leaseConflict
                        ? (currentTaskState?.status ?? "in_progress")
                        : runResult.status;
                      taskStatus = effectiveStatus;

                      for (const step of runResult.completedSteps ?? []) {
                        controller.enqueue(encoder.encode(sseEvent({
                          type: "task_progress",
                          data: {
                            taskId,
                            status: "step_complete",
                            stage: step,
                            message: `Step completed: ${step}`,
                            timestamp: new Date().toISOString(),
                          },
                        })));
                      }

                      controller.enqueue(encoder.encode(sseEvent({
                        type: "task_progress",
                        data: {
                          taskId,
                          status: effectiveStatus,
                          stage: "workflow_end",
                          message:
                            leaseConflict
                              ? "This task is already running. Showing current status instead."
                              : runResult.status === "completed"
                              ? "Task completed"
                              : runResult.error ?? `Task ended with status ${runResult.status}`,
                          timestamp: new Date().toISOString(),
                        },
                      })));

                      if (leaseConflict) {
                        assistantMeta = {
                          renderType: "task_progress",
                          progress: {
                            taskId,
                            status: effectiveStatus,
                            stage: "workflow_end",
                            message: "This task is already running. Showing current status instead.",
                            timestamp: new Date().toISOString(),
                          },
                        };
                        assistantText = `This task is already running. Showing current status instead: ${taskId} is ${effectiveStatus}.`;
                      } else if (runResult.status === "completed") {
                        const finalTask = await getTask(env.R2_ARTIFACTS, taskId);
                        const finalOutputArtifact = await getArtifact(env.R2_ARTIFACTS, taskId, "final-output.json");
                        const finalOutput = (finalOutputArtifact?.body ?? {}) as Record<string, unknown>;
                        const auditOutput =
                          finalOutput.auditOutput && typeof finalOutput.auditOutput === "object"
                            ? (finalOutput.auditOutput as Record<string, unknown>)
                            : null;
                        const findings = Array.isArray(auditOutput?.findings)
                          ? (auditOutput?.findings as unknown[])
                          : [];

                        const resultCard = {
                          taskId,
                          auditVerdict: typeof auditOutput?.verdict === "string" ? auditOutput.verdict : null,
                          auditScore: typeof auditOutput?.score === "number" ? auditOutput.score : null,
                          findingCount: findings.length,
                          completedAt:
                            (typeof finalOutput.completedAt === "string" && finalOutput.completedAt) ||
                            finalTask?.updatedAt ||
                            null,
                          detailsUrl: `/api/tasks/${taskId}`,
                        };

                        controller.enqueue(encoder.encode(sseEvent({
                          type: "task_result",
                          data: resultCard,
                        })));

                        assistantMeta = {
                          renderType: "task_result",
                          result: resultCard,
                        };

                        assistantText = [
                          `Task ${taskId} completed successfully.`,
                          `Audit: ${resultCard.auditVerdict ?? "n/a"} (score ${resultCard.auditScore ?? "n/a"}).`,
                          `Findings: ${resultCard.findingCount}.`,
                        ].join(" ");
                      } else {
                        assistantMeta = {
                          renderType: "task_progress",
                          progress: {
                            taskId,
                            status: runResult.status,
                            stage: "workflow_end",
                            message: runResult.error ?? `Task ended with status ${runResult.status}`,
                            timestamp: new Date().toISOString(),
                          },
                        };
                        assistantText = [
                          `Task ${taskId} was created but ended with status ${runResult.status}.`,
                          runResult.error ? `Reason: ${runResult.error}` : "",
                        ].filter(Boolean).join(" ");
                      }
                    } else {
                      assistantText = `I could not create a task from that proposal: ${routed.error ?? routed.reason ?? "unknown dispatcher error"}.`;
                    }
                  }
                } else if (isTaskLikeMessage(content)) {
                  const proposal = inferTaskProposal(content);
                  if (proposal) {
                    assistantMeta = {
                      renderType: "task_proposal",
                      proposal,
                    };
                    assistantText = [
                      "I drafted a task proposal from your request.",
                      "Review the card and choose Run now, Edit, or Cancel.",
                    ].join(" ");

                    controller.enqueue(encoder.encode(sseEvent({
                      type: "task_proposal",
                      data: { proposal },
                    })));
                  } else {
                    assistantText = "I could not confidently infer a task proposal from that message. Please add more detail and expected outcome.";
                  }
                } else {
                  const actionResult = await resolveChatActionFromHistory(env, content, historyMessages);
                  if (actionResult.handled) {
                    assistantText = actionResult.assistantText;
                    taskId = actionResult.taskId;
                    taskStatus = actionResult.taskStatus;
                    assistantMeta = actionResult.assistantMeta;

                    for (const evt of actionResult.events) {
                      controller.enqueue(encoder.encode(sseEvent(evt)));
                    }
                  } else {
                    const freeform = await answerFreeformWithAIGateway(
                      env,
                      content,
                      historyMessages,
                      sessionUserName
                    );
                    if (freeform.ok && freeform.text) {
                      assistantText = freeform.text;
                      assistantMeta = {
                        renderType: "assistant_text",
                        aiRouteClass: freeform.routeClass,
                        aiRoute: freeform.route,
                        aiRouteSource: freeform.routeSource,
                        userName: sessionUserName,
                      };
                    } else {
                      // Deterministic fallback is used only after chat_action and AI freeform paths fail.
                      assistantText = buildGeneralChatReply(content, sessionUserName);
                    }
                  }
                }

                for (const chunk of chunkText(assistantText, 24)) {
                  controller.enqueue(encoder.encode(sseEvent({
                    type: "assistant_delta",
                    data: { chunk },
                  })));
                }

                const assistantMessage = createChatMessage(sessionId, {
                  role: "assistant",
                  content: assistantText,
                  taskId,
                  taskStatus,
                  meta: assistantMeta,
                });
                await appendChatMessage(env.R2_ARTIFACTS, assistantMessage);

                controller.enqueue(encoder.encode(sseEvent({
                  type: "done",
                  data: {
                    messageId: assistantMessage.messageId,
                    content: assistantMessage.content,
                    taskId,
                    taskStatus,
                  },
                })));
                controller.close();
              } catch (error: unknown) {
                logRouteError("POST /api/chat/sessions/:sessionId/messages [SSE]", error, {
                  sessionId,
                });
                controller.enqueue(encoder.encode(sseEvent({
                  type: "error",
                  data: { message: "Internal server error." },
                })));
                controller.close();
              }
            })();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }

      // ── POST /tasks ─────────────────────────────────────────────────────────
      // Creates a TaskPacket, stores to R2, initializes coordinator, and enqueues.
      if (request.method === "POST" && pathname === "/tasks") {
        const body = await request.json().catch(() => null);
        if (body === null) {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const validation = validateTaskRequest(body);
        if (!validation.ok) {
          return json({ ok: false, errors: validation.errors }, 400);
        }

        const normalized = normalizeTaskRequest(body);
        const taskId = crypto.randomUUID();
        const now = new Date().toISOString();

        // Map legacy TaskKind → core TaskType / DomainType.
        // TODO: replace with DispatcherAgent.handleInboundRequest() for full classification.
        const taskType: TaskType = kindToTaskType(normalized.kind);
        const domain: DomainType = "wifi";

        const packet: TaskPacket = {
          taskId,
          taskType,
          domain,
          title: normalized.input.objective.slice(0, 120),
          goal: normalized.input.objective,
          definitionOfDone: [],
          allowedTools: ["r2.read", "worklog.append", "ai_gateway.analyze"],
          forbiddenActions: [
            "direct_device_config_change",
            "credential_exfiltration",
            "customer_pii_export",
          ],
          inputArtifacts: [],
          dependencies: [],
          status: "queued",
          approvalState: "not_required",
          escalationRules: [],
          createdAt: now,
          updatedAt: now,
          assignedAgentRole: "dispatcher",
          metadata: {
            tenantId: normalized.userId,
            source: "api",
            custom: (normalized.metadata as Record<string, unknown>) ?? {},
          },
        };

        // R2: persist task packet — workflow reads from here, not from the DO.
        const stored = await putTask(env.R2_ARTIFACTS, packet);
        if (!stored.ok) {
          return json({ ok: false, error: `Failed to store task: ${stored.error}` }, 500);
        }

        // DO: initialize the per-task coordinator.
        const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
        const coordInit = await coordinatorInitialize(stub, { taskId });
        if (!coordInit.ok) {
          return json({ ok: false, error: `Failed to initialize coordinator: ${coordInit.error}` }, 500);
        }

        return json({ ok: true, taskId, status: "queued" }, 202);
      }

      // ── POST /tasks/run-next ────────────────────────────────────────────────
      // Runs the full workflow pipeline for a single task.
      // TODO (Phase 2): integrate with native Cloudflare Queues for proper queueing.
      if (request.method === "POST" && pathname === "/tasks/run-next") {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        const body = parsed.body as Record<string, unknown>;
        const taskId = typeof body.taskId === "string" ? body.taskId : null;

        if (!taskId) {
          return json({ ok: false, error: "taskId is required." }, 400);
        }

        const task = await getTask(env.R2_ARTIFACTS, taskId);
        if (!task) {
          return json({ ok: false, error: "Task not found." }, 404);
        }

        // Idempotency guard: never re-run tasks that already reached a terminal or gated state.
        if (task.status === "completed") {
          return json(
            {
              ok: true,
              taskId,
              status: "completed",
              message: "Task already completed.",
            },
            200
          );
        }

        if (task.status === "in_progress") {
          return json(
            {
              ok: true,
              taskId,
              status: "in_progress",
              message: "Task is already running.",
            },
            202
          );
        }

        if (task.status === "awaiting_approval") {
          return json(
            {
              ok: true,
              taskId,
              status: "awaiting_approval",
              message: "Task is waiting for approval. Use /tasks/:taskId/approve or /reject.",
            },
            202
          );
        }

        const workflowRunId = crypto.randomUUID();
        const workflow = new TaskWorkflow();
        const result = await workflow.run(env, { taskId, workflowRunId });

        // ── Approval pause path ─────────────────────────────────────────────
        // HUMAN-IN-THE-LOOP: workflow paused; create and persist ApprovalRecord.
        // The response contains ApprovalPendingInfo for the caller to route to
        // the appropriate notification channel (chat, email, UI poll).
        // SECURITY: do not distribute any draft output while state = "pending".
        if (result.status === "paused_for_approval") {
          const auditCache = await getArtifact(env.R2_ARTIFACTS, taskId, "_wf_step_audit.json");
          const auditOutput = auditCache?.body as AuditStructuredOutput | null;

          const auditVerdict = (result.auditVerdict ?? "revise") as "revise" | "escalate_human";
          const auditScore = result.auditScore ?? 0;
          const auditFindings = auditOutput?.findings ?? [];

          const task = await getTask(env.R2_ARTIFACTS, taskId);
          const trigger: ApprovalTrigger = classifyApprovalTrigger(
            auditVerdict,
            auditFindings,
            task?.domain ?? "",
            task?.taskType ?? "",
            undefined,
            undefined
          );

          const record: ApprovalRecord = {
            approvalId: crypto.randomUUID(),
            taskId,
            trigger,
            summary: buildApprovalSummary({ trigger, auditVerdict, auditScore, auditFindings }),
            auditVerdict,
            auditScore,
            auditFindings,
            state: "pending",
            requestedAt: new Date().toISOString(),
          };

          await putApprovalRecord(env.R2_ARTIFACTS, record);
          return json(buildApprovalPendingInfo(record, baseUrl), 202);
        }

        return json(
          {
            ok: result.status === "completed",
            taskId,
            status: result.status,
            auditVerdict: result.auditVerdict,
            auditScore: result.auditScore,
            completedSteps: result.completedSteps,
            error: result.error,
          },
          result.status === "completed" ? 200 : 422
        );
      }

      // ── POST /tasks/:taskId/approve ─────────────────────────────────────────
      // Human reviewer approves a paused task.
      const approveMatch = RE_APPROVE.exec(pathname);
      if (request.method === "POST" && approveMatch) {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        return handleDecision(env, approveMatch[1], true, parsed.body, baseUrl);
      }

      // ── POST /tasks/:taskId/reject ──────────────────────────────────────────
      // Human reviewer rejects a paused task.
      const rejectMatch = RE_REJECT.exec(pathname);
      if (request.method === "POST" && rejectMatch) {
        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        return handleDecision(env, rejectMatch[1], false, parsed.body, baseUrl);
      }

      // ── GET /api/tasks/:taskId ─────────────────────────────────────────────
      // Browser-facing task detail for Access-authenticated UI flows.
      const apiTaskGetMatch = RE_API_TASK_GET.exec(pathname);
      if (request.method === "GET" && apiTaskGetMatch) {
        const taskId = apiTaskGetMatch[1];
        const task = await getTask(env.R2_ARTIFACTS, taskId);
        if (!task) {
          return json({ ok: false, error: "Task not found." }, 404);
        }
        const worklog = await listWorklogEntries(env.R2_WORKLOGS, taskId);

        const finalOutputArtifact = await getArtifact(
          env.R2_ARTIFACTS,
          taskId,
          "final-output.json"
        );

        const response: Record<string, unknown> = {
          ok: true,
          viewer: getBrowserIdentity(browserAuth ?? { mode: "unauthenticated", isAuthenticated: false }),
          task,
          worklog,
          resultAvailable: false,
        };
        if (finalOutputArtifact) {
          const finalOutput = finalOutputArtifact.body as Record<string, unknown>;
          const auditOutput =
            finalOutput.auditOutput && typeof finalOutput.auditOutput === "object"
              ? (finalOutput.auditOutput as Record<string, unknown>)
              : undefined;

          const findings = Array.isArray(auditOutput?.findings)
            ? (auditOutput?.findings as unknown[])
            : undefined;

          response.resultAvailable = true;
          response.auditVerdict = typeof auditOutput?.verdict === "string" ? auditOutput.verdict : undefined;
          response.auditScore = typeof auditOutput?.score === "number" ? auditOutput.score : undefined;
          response.findingCount = findings ? findings.length : undefined;
          response.analystOutput = finalOutput.analystOutput;
          response.auditOutput = finalOutput.auditOutput;
          response.completedAt = finalOutput.completedAt;
        }
        return json(response, 200);
      }

      // ── GET /api/tasks ─────────────────────────────────────────────────────
      // Browser-facing task summary list for Access-authenticated UI flows.
      if (request.method === "GET" && pathname === "/api/tasks") {
        try {
          const listed = await env.R2_ARTIFACTS.list({ prefix: "org/hilton/tasks/" });
          const taskIds = new Set<string>();
          for (const obj of listed.objects) {
            const match = obj.key.match(/^org\/hilton\/tasks\/([^/]+)\//);
            if (match) taskIds.add(match[1]);
          }

          const taskSummaries: Record<string, unknown>[] = [];
          for (const taskId of Array.from(taskIds)) {
            const task = await getTask(env.R2_ARTIFACTS, taskId);
            if (task) {
              taskSummaries.push({
                taskId: task.taskId,
                title: task.title,
                taskType: task.taskType,
                domain: task.domain,
                status: task.status,
                approvalState: task.approvalState,
                updatedAt: task.updatedAt,
              });
            }
          }

          taskSummaries.sort((a, b) => {
            const aTime = new Date(a.updatedAt as string).getTime();
            const bTime = new Date(b.updatedAt as string).getTime();
            return bTime - aTime;
          });

          return json({
            ok: true,
            viewer: getBrowserIdentity(browserAuth ?? { mode: "unauthenticated", isAuthenticated: false }),
            tasks: taskSummaries.slice(0, 50),
            count: taskSummaries.length,
          }, 200);
        } catch (error: unknown) {
          logRouteError("GET /api/tasks", error, {});
          return json({ ok: false, error: "Failed to list tasks." }, 500);
        }
      }

      // ── GET /tasks/:taskId/approval ─────────────────────────────────────────
      // Returns the current approval record and UI placeholder shapes.
      // WEB UI: poll this endpoint to check whether approval is still pending.
      // CHAT:   use chatCard.pendingCard to post the initial approval prompt.
      const approvalStatusMatch = RE_APPROVAL.exec(pathname);
      if (request.method === "GET" && approvalStatusMatch) {
        const taskId = approvalStatusMatch[1];
        const approval = await getApprovalRecord(env.R2_ARTIFACTS, taskId);
        return json(buildApprovalStatusResponse(taskId, approval, baseUrl), 200);
      }

      // ── GET /tasks/:taskId ─────────────────────────────────────────────────
      // Returns task packet + worklog from R2, plus optional analysis/audit results.
      const taskGetMatch = RE_TASK_GET.exec(pathname);
      if (request.method === "GET" && taskGetMatch) {
        const taskId = taskGetMatch[1];
        const task = await getTask(env.R2_ARTIFACTS, taskId);
        if (!task) {
          return json({ ok: false, error: "Task not found." }, 404);
        }
        const worklog = await listWorklogEntries(env.R2_WORKLOGS, taskId);
        
        // Attempt to load completed analysis/audit artifact if it exists
        const finalOutputArtifact = await getArtifact(
          env.R2_ARTIFACTS,
          taskId,
          'final-output.json'
        );
        
        const response: Record<string, unknown> = {
          ok: true,
          task,
          worklog,
          resultAvailable: false,
        };
        if (finalOutputArtifact) {
          const finalOutput = finalOutputArtifact.body as Record<string, unknown>;
          const auditOutput =
            finalOutput.auditOutput && typeof finalOutput.auditOutput === "object"
              ? (finalOutput.auditOutput as Record<string, unknown>)
              : undefined;

          const findings = Array.isArray(auditOutput?.findings)
            ? (auditOutput?.findings as unknown[])
            : undefined;

          response.resultAvailable = true;
          response.auditVerdict = typeof auditOutput?.verdict === "string" ? auditOutput.verdict : undefined;
          response.auditScore = typeof auditOutput?.score === "number" ? auditOutput.score : undefined;
          response.findingCount = findings ? findings.length : undefined;
          response.analystOutput = finalOutput.analystOutput;
          response.auditOutput = finalOutput.auditOutput;
          response.completedAt = finalOutput.completedAt;
        }
        return json(response, 200);
      }

      // ── GET /tasks ──────────────────────────────────────────────────────────
      // List recent tasks for the Task Console UI.
      if (request.method === "GET" && pathname === "/tasks") {
        try {
          const listed = await env.R2_ARTIFACTS.list({ prefix: "org/hilton/tasks/" });
          const taskIds = new Set<string>();
          for (const obj of listed.objects) {
            const match = obj.key.match(/^org\/hilton\/tasks\/([^/]+)\//);
            if (match) taskIds.add(match[1]);
          }

          const taskSummaries: Record<string, unknown>[] = [];
          for (const taskId of Array.from(taskIds)) {
            const task = await getTask(env.R2_ARTIFACTS, taskId);
            if (task) {
              taskSummaries.push({
                taskId: task.taskId,
                title: task.title,
                taskType: task.taskType,
                domain: task.domain,
                status: task.status,
                approvalState: task.approvalState,
                updatedAt: task.updatedAt,
              });
            }
          }

          taskSummaries.sort((a, b) => {
            const aTime = new Date(a.updatedAt as string).getTime();
            const bTime = new Date(b.updatedAt as string).getTime();
            return bTime - aTime;
          });

          return json({
            ok: true,
            tasks: taskSummaries.slice(0, 50),
            count: taskSummaries.length,
          }, 200);
        } catch (error: unknown) {
          logRouteError("GET /tasks", error, {});
          return json({ ok: false, error: "Failed to list tasks." }, 500);
        }
      }

      // ── Route listing ───────────────────────────────────────────────────────
      return json(
        {
          ok: true,
          routes: [
            "GET  /chat",
            "GET  /system",
            "GET  /tasks-console",
            "GET  /config-ui",
            "GET  /config",
            "POST /config/validate",
            "PUT  /config",
            "GET  /config/export",
            "GET  /health",
            "GET  /ready",
            "POST /api/chat/sessions",
            "GET  /api/chat/sessions/:sessionId/messages",
            "POST /api/chat/sessions/:sessionId/messages",
            "GET  /api/tasks",
            "GET  /api/tasks/:taskId",
            "GET  /tasks",
            "POST /tasks",
            "POST /tasks/run-next",
            "POST /tasks/:taskId/approve",
            "POST /tasks/:taskId/reject",
            "GET  /tasks/:taskId/approval",
            "GET  /tasks/:taskId",
          ],
        },
        200
      );
    } catch (error: unknown) {
      return routeUnhandledError(request.method, pathnameFromRequest(request), error);
    }
  },
};

// ─── Approval decision handler ────────────────────────────────────────────────

/**
 * handleDecision — shared for /approve and /reject.
 *
 * 1. Validates body (reviewerId required).
 * 2. Loads ApprovalRecord from R2 — missing → 404.
 * 3. IDEMPOTENCY GATE: if record.state ≠ "pending" → 409 Conflict.
 * 4. Acquires a fresh coordinator lease.
 * 5. Re-triggers TaskWorkflow with resumeAfterApproval=true.
 * 6. Updates and persists ApprovalRecord.
 * 7. Returns ApprovalDecisionResponse.
 *
 * APPROVAL GATE ENFORCEMENT:
 *   Once state = "approved" or "rejected", a second call returns 409.
 *   To retry after rejection, the caller must create a new task via POST /tasks.
 */
async function handleDecision(
  env: Env,
  taskId: string,
  approved: boolean,
  body: unknown,
  baseUrl: string
): Promise<Response> {
  try {
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as Record<string, unknown>)["reviewerId"] !== "string" ||
      !(body as Record<string, unknown>)["reviewerId"]
    ) {
      return json({ ok: false, error: "reviewerId is required." }, 400);
    }

    const { reviewerId, reason } = body as ApprovalDecisionRequest;

    const record = await getApprovalRecord(env.R2_ARTIFACTS, taskId);
    if (!record) {
      return json({ ok: false, error: `No approval record found for taskId "${taskId}".` }, 404);
    }

    // IDEMPOTENCY GUARD — APPROVAL GATE: once decided, this record is immutable.
    if (record.state !== "pending") {
      return json(
        {
          ok: false,
          error: `Approval record is already "${record.state}". Create a new task to retry.`,
          approvalRecord: record,
        },
        409
      );
    }

    const decision = approved ? ("approved" as const) : ("rejected" as const);
    const now = new Date().toISOString();

    // Acquire coordinator lease with a fresh run ID.
    const workflowRunId = crypto.randomUUID();
    const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
    const leaseResult = await coordinatorAcquireLease(stub, {
      ownerId: workflowRunId,
      leaseMs: 60_000,
      stepName: "approval_resume",
    });

    if (!leaseResult.ok || !leaseResult.acquired) {
      return json(
        {
          ok: false,
          error: `Could not acquire coordinator lease: ${leaseResult.reason ?? leaseResult.error}`,
        },
        503
      );
    }

    // Re-trigger workflow with the human decision.
    const workflow = new TaskWorkflow();
    const result = await workflow.run(env, {
      taskId,
      workflowRunId,
      resumeAfterApproval: true,
      approvedByHuman: approved,
    });

    // Update and persist the ApprovalRecord.
    const updatedRecord: ApprovalRecord = {
      ...record,
      state: decision,
      decidedAt: now,
      reviewerId,
      reviewerNote: typeof reason === "string" ? reason : undefined,
    };
    await putApprovalRecord(env.R2_ARTIFACTS, updatedRecord);

    const workflowStatus =
      result.status === "completed" ? ("completed" as const)
      : result.status === "rejected" ? ("rejected" as const)
      : ("failed" as const);

    const statusCode = workflowStatus === "failed" ? 422 : 200;

    return json(
      buildApprovalDecisionResponse(updatedRecord, decision, workflowStatus, baseUrl, result.error),
      statusCode
    );
  } catch (error: unknown) {
    logRouteError(`POST /tasks/${taskId}/${approved ? "approve" : "reject"}`, error, {
      taskId,
    });
    return json({ ok: false, error: "Internal server error." }, 500);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function parseJsonOr400(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    const body = await request.json();
    return { ok: true, body };
  } catch {
    return { ok: false, response: json({ ok: false, error: "Invalid JSON body" }, 400) };
  }
}

function routeUnhandledError(method: string, pathname: string, error: unknown): Response {
  logRouteError(`${method} ${pathname}`, error);
  return json({ ok: false, error: "Internal server error." }, 500);
}

function logRouteError(route: string, error: unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error("Unknown route error");
  const details: Record<string, unknown> = {
    route,
    message: err.message,
    name: err.name,
  };
  if (err.stack) details.stack = err.stack;
  if (context && Object.keys(context).length > 0) details.context = context;
  console.error("[route_error]", details);
}

function pathnameFromRequest(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "unknown_path";
  }
}

function kindToTaskType(kind: string | undefined): TaskType {
  if (kind === "draft") return "report_draft";
  if (kind === "audit") return "root_cause_analysis";
  return "incident_triage";
}

function isTaskLikeMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(create|draft|summari[sz]e|report|review|analy[sz]e|investigat|triage|plan|prepare|assess|run task|work item|ticket)\b/.test(lower);
}

type ChatRouteClass = "utility" | "tools" | "reasoning" | "vision";

interface ChatTaskProposal {
  proposalId: string;
  sourceText: string;
  taskType: TaskType;
  domain: DomainType;
  title: string;
  confidence: number;
  routeClass: ChatRouteClass;
  mcpHints: string[];
}

function parseTaskProposalInput(value: Record<string, unknown> | null): ChatTaskProposal | null {
  if (!value) return null;
  const proposalId = typeof value.proposalId === "string" && value.proposalId ? value.proposalId : crypto.randomUUID();
  const sourceText = typeof value.sourceText === "string" ? value.sourceText.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const taskType = value.taskType;
  const domain = value.domain;
  const confidenceRaw = typeof value.confidence === "number" ? value.confidence : 0.5;
  const routeClass = value.routeClass;
  const mcpHints = Array.isArray(value.mcpHints)
    ? (value.mcpHints.filter((hint) => typeof hint === "string") as string[])
    : [];

  if (!title || !sourceText) return null;
  if (!isTaskType(taskType) || !isDomainType(domain)) return null;
  if (!isRouteClass(routeClass)) return null;

  return {
    proposalId,
    sourceText,
    title,
    taskType,
    domain,
    confidence: Math.max(0, Math.min(1, confidenceRaw)),
    routeClass,
    mcpHints,
  };
}

function buildDispatcherTextFromProposal(proposal: ChatTaskProposal): string {
  return [
    proposal.title,
    proposal.sourceText,
    `taskType=${proposal.taskType}`,
    `domain=${proposal.domain}`,
    `routeClass=${proposal.routeClass}`,
  ].join(" | ");
}

function inferTaskProposal(text: string): ChatTaskProposal | null {
  const input = text.trim();
  if (!input) return null;

  const lower = input.toLowerCase();
  const taskType = inferTaskType(lower);
  const domain = inferDomain(lower);
  const confidence = inferProposalConfidence(lower, domain !== "cross_domain");
  const title = inferTitle(input, taskType);
  const routeClass = defaultRouteClassForTaskType(taskType);

  return {
    proposalId: crypto.randomUUID(),
    sourceText: input,
    taskType,
    domain,
    title,
    confidence,
    routeClass,
    mcpHints: [],
  };
}

function inferTaskType(lower: string): TaskType {
  if (/\b(root cause|rca|postmortem|post-mortem|why did|diagnos|investigat|failure analys)\b/.test(lower)) {
    return "root_cause_analysis";
  }
  if (/\b(change|rollback|deploy|release|cab|approval|policy review)\b/.test(lower)) {
    return "change_review";
  }
  if (/\b(executive|leadership|board|briefing|exec summary|tl;dr)\b/.test(lower)) {
    return "exec_summary";
  }
  if (/\b(vendor|provider|carrier|supplier|partner follow|escalation ticket)\b/.test(lower)) {
    return "vendor_followup";
  }
  if (/\b(draft|write|prepare|report|document|memo|notes)\b/.test(lower)) {
    return "report_draft";
  }
  return "incident_triage";
}

function inferDomain(lower: string): DomainType {
  if (/\bwifi|wireless|ssid|access point\b/.test(lower)) return "wifi";
  if (/\bnac|802\.1x|radius|network access\b/.test(lower)) return "nac";
  if (/\bztna|zero trust|identity-aware\b/.test(lower)) return "ztna";
  if (/\btelecom|voice|sip|pbx|carrier\b/.test(lower)) return "telecom";
  if (/\bcontent filter|web filter|dns filter|secure web gateway\b/.test(lower)) return "content_filtering";
  return "cross_domain";
}

function inferProposalConfidence(lower: string, hasDomain: boolean): number {
  let score = 0.46;
  if (/\b(create|draft|summari[sz]e|analy[sz]e|review|investigat|triage|prepare|run)\b/.test(lower)) score += 0.2;
  if (/\b(task|ticket|work item|proposal|plan|report|summary|analysis)\b/.test(lower)) score += 0.16;
  if (hasDomain) score += 0.08;
  if (lower.length > 60) score += 0.05;
  return Math.max(0.35, Math.min(0.98, score));
}

function defaultRouteClassForTaskType(taskType: TaskType): ChatRouteClass {
  if (taskType === "root_cause_analysis") return "reasoning";
  if (taskType === "change_review" || taskType === "vendor_followup") return "tools";
  if (taskType === "report_draft" || taskType === "exec_summary") return "utility";
  return "reasoning";
}

function inferTitle(input: string, taskType: TaskType): string {
  const firstLine = input.split(/[\n\.]/)[0]?.trim() ?? "";
  const clean = firstLine.replace(/^please\s+/i, "").replace(/^can you\s+/i, "").trim();
  if (clean.length >= 12) {
    return clean.slice(0, 120);
  }
  return `Proposed ${taskType.replace(/_/g, " ")}`;
}

function isRouteClass(value: unknown): value is ChatRouteClass {
  return value === "utility" || value === "tools" || value === "reasoning" || value === "vision";
}

function buildGeneralChatReply(content: string, userName?: string | null): string {
  const prompt = content.trim();
  const namePrefix = userName ? `${userName}, ` : "";
  if (!prompt) {
    return `${namePrefix}I can help with both general questions and task proposals. Ask a question, or describe work and I will propose a structured task card.`;
  }

  if (/\b(help|what can you do|capabilit|commands)\b/i.test(prompt)) {
    return [
      `${namePrefix}I can answer general questions conversationally and also convert task-like requests into structured task proposals.`,
      "When I detect task intent, I show a proposal card with task type, domain, title, and confidence.",
      "You can Run now, Edit, or Cancel directly from chat.",
    ].join(" ");
  }

  if (/\b(route class|gateway|mcp|tooling)\b/i.test(prompt)) {
    return [
      "This chat is forward-compatible with AI Gateway route classes (utility/tools/reasoning/vision) and MCP-backed capabilities.",
      "Current proposals include route-class hints and reserved MCP hints for future orchestration.",
    ].join(" ");
  }

  return [
    "I can discuss this with you directly, and if you decide to operationalize it, I can draft a task proposal card in chat.",
    "If you want a task, describe the objective, desired output, and any constraints.",
  ].join(" ");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function isStatusQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(status|state|progress|update)\b/.test(lower);
}

function extractTaskIdFromText(text: string): string | null {
  const taskIdMatch = /\b(task-[a-z0-9-]+)\b/i.exec(text);
  if (taskIdMatch) return taskIdMatch[1];
  const uuidMatch = /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i.exec(text);
  return uuidMatch ? uuidMatch[1] : null;
}

interface ChatActionResolution {
  handled: boolean;
  assistantText: string;
  taskId?: string;
  taskStatus?: string;
  assistantMeta?: Record<string, unknown>;
  events: ChatStreamEvent[];
}

async function resolveChatActionFromHistory(
  env: Env,
  content: string,
  historyMessages: ChatMessage[]
): Promise<ChatActionResolution> {
  const normalized = content.toLowerCase();
  const summary = summarizeHistoryContext(historyMessages);
  const backendSnapshot = await loadTaskSnapshotFromBackend(env);
  const explicitTaskId = extractTaskIdFromText(content);
  const targetTaskId = explicitTaskId ?? summary.lastTaskId ?? backendSnapshot.latestTaskId;

  if (/\b(show|what(?:'s| is)|check|get)\b.*\b(last|latest|previous)\s+task\b/.test(normalized)) {
    const candidateTaskId = summary.lastTaskId ?? backendSnapshot.latestTaskId;
    if (!candidateTaskId) {
      return { handled: true, assistantText: "I do not see any prior task in this chat yet.", events: [] };
    }
    const task = await getTask(env.R2_ARTIFACTS, candidateTaskId);
    if (!task) {
      return { handled: true, assistantText: `I could not load the last task (${candidateTaskId}).`, events: [] };
    }
    return {
      handled: true,
      assistantText: `Last task ${task.taskId} is ${task.status}. Approval state: ${task.approvalState}. Type/domain: ${task.taskType}/${task.domain}.`,
      taskId: task.taskId,
      taskStatus: task.status,
      assistantMeta: {
        renderType: "assistant_text",
      },
      events: [],
    };
  }

  if (/\b(open)\b.*\b(failed one|failed task|last failed)\b/.test(normalized)) {
    const failedTaskId = await findMostRecentFailedTask(
      env,
      summary.taskIds,
      backendSnapshot.latestFailedTaskId
    );
    if (!failedTaskId) {
      return { handled: true, assistantText: "I could not find a failed task in this chat history.", events: [] };
    }
    return {
      handled: true,
      assistantText: `Open details for failed task ${failedTaskId}: /api/tasks/${failedTaskId}`,
      taskId: failedTaskId,
      taskStatus: "failed",
      assistantMeta: {
        renderType: "assistant_text",
      },
      events: [],
    };
  }

  if (/\b(run|start|execute|launch)\b\s+(that|it|this)(\s+now)?\b/.test(normalized) || /\brun\s+now\b/.test(normalized)) {
    if (!targetTaskId && backendSnapshot.runningTaskId) {
      return {
        handled: true,
        assistantText: `Task ${backendSnapshot.runningTaskId} is currently running.`,
        taskId: backendSnapshot.runningTaskId,
        taskStatus: "in_progress",
        assistantMeta: {
          renderType: "task_progress",
          progress: {
            taskId: backendSnapshot.runningTaskId,
            status: "in_progress",
            stage: "chat_action",
            message: "Task is currently running",
            timestamp: new Date().toISOString(),
          },
        },
        events: [],
      };
    }

    if (!targetTaskId) {
      return {
        handled: true,
        assistantText: "I do not know which task to run yet. Mention a task ID or create a task first.",
        events: [],
      };
    }

    const task = await getTask(env.R2_ARTIFACTS, targetTaskId);
    if (!task) {
      return { handled: true, assistantText: `I could not find task ${targetTaskId}.`, events: [] };
    }

    if (task.status === "completed" || task.status === "in_progress" || task.status === "awaiting_approval") {
      return {
        handled: true,
        assistantText: `Task ${task.taskId} is already ${task.status}.`,
        taskId: task.taskId,
        taskStatus: task.status,
        assistantMeta: {
          renderType: "task_progress",
          progress: {
            taskId: task.taskId,
            status: task.status,
            stage: "chat_action",
            message: `Task already ${task.status}`,
            timestamp: new Date().toISOString(),
          },
        },
        events: [],
      };
    }

    const workflow = new TaskWorkflow();
    const run = await workflow.run(env, {
      taskId: task.taskId,
      workflowRunId: crypto.randomUUID(),
    });

    const leaseConflict = isLeaseConflictRunFailure(run.status, run.error);
    const currentTaskState = leaseConflict ? await getTask(env.R2_ARTIFACTS, task.taskId) : null;
    const effectiveStatus = leaseConflict ? (currentTaskState?.status ?? "in_progress") : run.status;
    const effectiveMessage = leaseConflict
      ? "This task is already running. Showing current status instead."
      : run.status === "completed"
        ? "Task completed from follow-up command."
        : run.error ?? `Task ended with status ${run.status}`;

    const events: ChatStreamEvent[] = [
      {
        type: "task_progress",
        data: {
          taskId: task.taskId,
          status: effectiveStatus,
          stage: "chat_action_run",
          message: effectiveMessage,
          timestamp: new Date().toISOString(),
        },
      },
    ];

    return {
      handled: true,
      assistantText:
        leaseConflict
          ? `This task is already running. Showing current status instead: ${task.taskId} is ${effectiveStatus}.`
          : run.status === "completed"
          ? `Ran task ${task.taskId}. It completed successfully.`
          : `Ran task ${task.taskId}. It ended with status ${run.status}${run.error ? `: ${run.error}` : ""}.`,
      taskId: task.taskId,
      taskStatus: effectiveStatus,
      assistantMeta: {
        renderType: "task_progress",
        progress: {
          taskId: task.taskId,
          status: effectiveStatus,
          stage: "chat_action_run",
          message: leaseConflict
            ? "This task is already running. Showing current status instead."
            : run.status === "completed"
              ? "Task completed."
              : run.error ?? `Task ended with status ${run.status}`,
          timestamp: new Date().toISOString(),
        },
      },
      events,
    };
  }

  return {
    handled: false,
    assistantText: "",
    events: [],
  };
}

async function answerFreeformWithAIGateway(
  env: Env,
  content: string,
  historyMessages: ChatMessage[],
  userName?: string | null
): Promise<{
  ok: boolean;
  text: string | null;
  routeClass: ChatRouteClass;
  route: string | null;
  routeSource: string;
}> {
  const token = env.AI_GATEWAY_TOKEN;
  if (!token) {
    return { ok: false, text: null, routeClass: "utility", route: null, routeSource: "missing_token" };
  }

  const config = await getEdgeClawConfig(env.R2_ARTIFACTS);
  const routeAttempt = selectFreeformRouteAttempt(config, content);
  const selected = routeAttempt.selected;

  if (!selected.enabled || !selected.baseUrl || !selected.route) {
    return {
      ok: false,
      text: null,
      routeClass: selected.routeClass,
      route: selected.route,
      routeSource: selected.reason,
    };
  }

  const promptContext = buildRecentContextForFreeform(historyMessages);
  const primary = await callFreeformAIGateway(
    token,
    selected,
    content,
    promptContext,
    userName
  );

  if (primary.ok) {
    return {
      ok: true,
      text: primary.text,
      routeClass: selected.routeClass,
      route: selected.route,
      routeSource: selected.source,
    };
  }

  const alternate = routeAttempt.alternate;
  if (alternate && alternate.enabled && alternate.baseUrl && alternate.route) {
    const secondary = await callFreeformAIGateway(
      token,
      alternate,
      content,
      promptContext,
      userName
    );
    if (secondary.ok) {
      return {
        ok: true,
        text: secondary.text,
        routeClass: alternate.routeClass,
        route: alternate.route,
        routeSource: alternate.source,
      };
    }
  }

  return {
    ok: false,
    text: null,
    routeClass: selected.routeClass,
    route: selected.route,
    routeSource: primary.routeSource,
  };
}

function selectFreeformRouteAttempt(
  config: EdgeClawConfig | null,
  content: string
): {
  selected: ReturnType<typeof selectAIGatewayRoute>;
  alternate: ReturnType<typeof selectAIGatewayRoute> | null;
} {
  const preferred = inferPreferredRouteClassForFreeform(content);
  const alternateClass: ChatRouteClass = preferred === "reasoning" ? "utility" : "reasoning";

  const selected = selectAIGatewayRoute(config, {
    workflowType: "chat",
    agentRole: "chat",
    preferredRouteClass: preferred,
  });

  const alternate = selectAIGatewayRoute(config, {
    workflowType: "chat",
    agentRole: "chat",
    preferredRouteClass: alternateClass,
  });

  // If preferred route is unavailable, but alternate is configured, promote alternate.
  if ((!selected.enabled || !selected.baseUrl || !selected.route) && alternate.enabled && alternate.baseUrl && alternate.route) {
    return {
      selected: alternate,
      alternate: null,
    };
  }

  return {
    selected,
    alternate,
  };
}

async function callFreeformAIGateway(
  token: string,
  selected: ReturnType<typeof selectAIGatewayRoute>,
  content: string,
  promptContext: string,
  userName?: string | null
): Promise<{ ok: boolean; text: string | null; routeSource: string }> {
  if (!selected.baseUrl || !selected.route) {
    return { ok: false, text: null, routeSource: selected.reason };
  }

  const identityContext = userName
    ? `The user's preferred name in this session is \"${userName}\". Use it naturally when appropriate.`
    : "The user name is unknown for this session.";

  const response = await fetch(`${selected.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "cf-aig-metadata": JSON.stringify({
        workflowType: "chat",
        agentRole: "chat",
        routeClass: selected.routeClass,
      }),
    },
    body: JSON.stringify({
      model: selected.route,
      messages: [
        {
          role: "system",
          content:
            "You are an operator assistant. Answer clearly and concisely. Do not invent unavailable task state; ask for clarification when needed.",
        },
        {
          role: "system",
          content: identityContext,
        },
        {
          role: "system",
          content: promptContext,
        },
        {
          role: "user",
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    return { ok: false, text: null, routeSource: `gateway_http_${response.status}` };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractFreeformModelText(payload);

  return {
    ok: !!text,
    text,
    routeSource: selected.source,
  };
}

function summarizeHistoryContext(messages: ChatMessage[]): {
  taskIds: string[];
  lastTaskId: string | null;
} {
  const taskIds: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    const taskId = typeof msg.taskId === "string" && msg.taskId.trim() ? msg.taskId.trim() : null;
    if (taskId && !seen.has(taskId)) {
      seen.add(taskId);
      taskIds.push(taskId);
    }

    const text = typeof msg.content === "string" ? msg.content : "";
    const extracted = extractTaskIdFromText(text);
    if (extracted && !seen.has(extracted)) {
      seen.add(extracted);
      taskIds.push(extracted);
    }
  }

  return {
    taskIds,
    lastTaskId: taskIds.length > 0 ? taskIds[taskIds.length - 1] : null,
  };
}

async function findMostRecentFailedTask(
  env: Env,
  taskIds: string[],
  backendFailedTaskId?: string | null
): Promise<string | null> {
  for (let i = taskIds.length - 1; i >= 0; i -= 1) {
    const taskId = taskIds[i];
    const task = await getTask(env.R2_ARTIFACTS, taskId);
    if (task?.status === "failed") return taskId;
  }
  if (backendFailedTaskId) return backendFailedTaskId;
  return null;
}

interface TaskSnapshot {
  latestTaskId: string | null;
  latestFailedTaskId: string | null;
  runningTaskId: string | null;
}

async function loadTaskSnapshotFromBackend(env: Env): Promise<TaskSnapshot> {
  try {
    const listed = await env.R2_ARTIFACTS.list({ prefix: "org/hilton/tasks/" });
    const taskKeys = listed.objects
      .map((obj) => obj.key)
      .filter((key) => key.endsWith("/task.json"));

    const tasks: TaskPacket[] = [];
    for (const key of taskKeys) {
      try {
        const obj = await env.R2_ARTIFACTS.get(key);
        if (!obj) continue;
        const task = await obj.json<TaskPacket>();
        if (task?.taskId) tasks.push(task);
      } catch {
        // Ignore unreadable task packet and continue scanning.
      }
    }

    tasks.sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || "");
      const bTime = Date.parse(b.updatedAt || b.createdAt || "");
      return bTime - aTime;
    });

    const latestTask = tasks[0] ?? null;
    const latestFailedTask = tasks.find((task) => task.status === "failed") ?? null;
    const runningTask = tasks.find((task) => task.status === "in_progress") ?? null;

    return {
      latestTaskId: latestTask?.taskId ?? null,
      latestFailedTaskId: latestFailedTask?.taskId ?? null,
      runningTaskId: runningTask?.taskId ?? null,
    };
  } catch {
    return {
      latestTaskId: null,
      latestFailedTaskId: null,
      runningTaskId: null,
    };
  }
}

function inferPreferredRouteClassForFreeform(content: string): ChatRouteClass {
  const lower = content.toLowerCase();
  if (/\b(image|diagram|visual|screenshot|vision)\b/.test(lower)) return "vision";
  if (/\b(tool|command|action|steps|api call)\b/.test(lower)) return "tools";
  if (/\b(why|difference|compare|explain|reason|tradeoff)\b/.test(lower)) return "reasoning";
  return "utility";
}

function buildRecentContextForFreeform(messages: ChatMessage[]): string {
  const snippets = messages
    .slice(-6)
    .map((msg) => {
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      const content = typeof msg.content === "string" ? msg.content.replace(/\s+/g, " ").trim() : "";
      if (!content) return "";
      return `${role}: ${content.slice(0, 220)}`;
    })
    .filter(Boolean);

  if (snippets.length === 0) {
    return "No prior session context.";
  }
  return `Recent session context:\n${snippets.join("\n")}`;
}

function extractFreeformModelText(payload: Record<string, unknown>): string | null {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const choiceRec = toRecord(choice);
    if (!choiceRec) continue;
    const message = toRecord(choiceRec.message);
    const content = message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }

  const outputText = payload.output_text;
  if (typeof outputText === "string" && outputText.trim()) return outputText.trim();
  return null;
}

function extractDeclaredUserName(content: string): string | null {
  const match = content.match(/\bmy name is\s+([a-z][a-z\-'\s]{0,50})$/i);
  if (!match) return null;
  const cleaned = match[1].trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  // Keep lightweight and safe: letters, spaces, apostrophes, hyphens only.
  if (!/^[a-z][a-z\-'\s]{0,50}$/i.test(cleaned)) return null;
  return cleaned;
}

function isLeaseConflictRunFailure(status: string, error: string | undefined): boolean {
  if (status !== "failed" || !error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("could not acquire coordinator lease") ||
    lower.includes("lease") && lower.includes("held") ||
    lower.includes("lease") && lower.includes("acquire")
  );
}

function chunkText(text: string, wordsPerChunk: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += wordsPerChunk) {
    const slice = words.slice(index, index + wordsPerChunk).join(" ");
    chunks.push(`${slice}${index + wordsPerChunk < words.length ? " " : ""}`);
  }
  return chunks.length > 0 ? chunks : [text];
}
