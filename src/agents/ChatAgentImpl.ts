import { getCurrentAgent } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DispatcherAgent } from "./DispatcherAgent";
import { getAccessIdentity } from "../lib/auth";
import { getTask } from "../lib/r2";
import type { Env } from "../lib/types";
import { TaskWorkflow } from "../workflows/TaskWorkflow";

/**
 * Minimal Phase 1 Cloudflare Agents SDK integration.
 *
 * Important boundary in this phase:
 * - AIChatAgent manages chat history/state in Durable Object SQLite automatically.
 * - Existing EdgeClaw task execution remains unchanged (Dispatcher -> TaskCoordinatorDO -> Workflow -> R2 artifacts/worklogs).
 * - Existing R2 chat routes are not removed or cut over yet.
 */
export class ChatAgentImpl extends AIChatAgent {
  async onChatMessage(_onFinish?: unknown, options?: { body?: Record<string, unknown> }): Promise<Response> {
    const env = (this as unknown as { env: Env }).env;
    const historyMessages = this.messages as unknown[];
    const content = extractLatestUserText(historyMessages);
    const { request } = getCurrentAgent();
    const accessIdentity = request ? getAccessIdentity(request) : null;
    const userId = accessIdentity?.userId ?? resolveUserId(options?.body);

    if (!content) {
      return textResponse("I could not find a user message to process.");
    }

    const history = buildChatHistoryContext(historyMessages, content);
    const priorRef = formatPriorRequestReference(history.previousUserRequest);

    if (isShowLastTaskFollowUp(content)) {
      if (!history.latestTaskId) {
        return textResponse("I do not see a prior task in this chat yet.");
      }
      const status = await this.getTaskStatus(env, history.latestTaskId);
      if (!status.ok) {
        return textResponse(`I could not load the last task (${history.latestTaskId}).`);
      }
      return textResponse(
        [
          `Last task is ${status.taskId} and it is ${status.status}.`,
          `Approval state: ${status.approvalState}.`,
          priorRef,
        ]
          .filter(Boolean)
          .join(" ")
      );
    }

    if (isOpenFailedOneFollowUp(content)) {
      const failedTaskId = await this.findMostRecentFailedTask(env, history.taskIds);
      if (!failedTaskId) {
        return textResponse("I could not find a failed task in this chat history.");
      }
      return textResponse(
        [
          `Open details for failed task ${failedTaskId}: /api/tasks/${failedTaskId}`,
          priorRef,
        ]
          .filter(Boolean)
          .join(" ")
      );
    }

    const requestedTaskId = extractTaskIdFromText(content);
    if (isRunReferenceFollowUp(content)) {
      const targetTaskId = requestedTaskId ?? history.latestTaskId;
      if (!targetTaskId) {
        return textResponse("I do not know which task to run yet. Mention a task ID or create one first.");
      }

      const run = await this.runTaskNow(env, targetTaskId);
      if (!run.ok) {
        return textResponse(`I could not run task ${targetTaskId}: ${run.error}`);
      }

      return textResponse(
        [
          `Ran task ${targetTaskId}. Status: ${run.status}.`,
          run.error ? `Reason: ${run.error}` : "",
          priorRef,
        ]
          .filter(Boolean)
          .join(" ")
      );
    }

    if (requestedTaskId && isStatusQuery(content)) {
      const status = await this.getTaskStatus(env, requestedTaskId);
      if (!status.ok) {
        return textResponse(`I could not find task ${requestedTaskId}.`);
      }

      return textResponse(
        [
          `Task ${status.taskId} is currently ${status.status}.`,
          `Approval state: ${status.approvalState}.`,
          `Type/domain: ${status.taskType}/${status.domain}.`,
        ].join(" ")
      );
    }

    if (requestedTaskId && isApproveCommand(content)) {
      const approved = await this.approveTask(env, requestedTaskId, userId, extractReason(content));
      return textResponse(
        approved.ok
          ? `Approved task ${requestedTaskId}. Workflow resume response: ${approved.message}`
          : `I could not approve task ${requestedTaskId}: ${approved.error}`
      );
    }

    if (requestedTaskId && isRejectCommand(content)) {
      const rejected = await this.rejectTask(env, requestedTaskId, userId, extractReason(content));
      return textResponse(
        rejected.ok
          ? `Rejected task ${requestedTaskId}. Workflow response: ${rejected.message}`
          : `I could not reject task ${requestedTaskId}: ${rejected.error}`
      );
    }

    if (isTaskLikeMessage(content)) {
      const runNow = isRunNowRequest(content);
      const created = await this.createTaskFromChat(env, {
        userId,
        text: content,
        runNow,
      });

      if (created.ok && created.taskId) {
        return textResponse(
          [
            `I created task ${created.taskId}.`,
            `Classification: ${created.taskType}/${created.domain} with confidence ${(created.confidence ?? 0).toFixed(2)}.`,
            `Route-class hint: ${created.routeClassHint}.`,
            runNow
              ? `Run result: ${created.runStatus ?? "started"}${created.runError ? ` (${created.runError})` : ""}.`
              : `Use "status ${created.taskId}" to check progress or ask me to run it now.`,
          ].join(" ")
        );
      }

      return textResponse(
        `I could not create a task from that request: ${created.error ?? "unknown dispatcher error"}.`
      );
    }

    return textResponse(buildConversationalReply(content));
  }

  // Creates a task using the existing dispatcher + task packet pipeline.
  async createTaskFromChat(
    env: Env,
    input: { userId: string; text: string; runNow?: boolean }
  ): Promise<{
    ok: boolean;
    taskId?: string;
    taskType?: string;
    domain?: string;
    confidence?: number;
    routeClassHint?: "utility" | "tools" | "reasoning" | "vision";
    runStatus?: string;
    runError?: string;
    error?: string;
  }> {
    const dispatcher = new DispatcherAgent();
    const routed = await dispatcher.handleInboundRequest(env, {
      userId: input.userId,
      text: input.text,
      source: "chat",
      startWorkflow: false,
    });

    if (!routed.ok || !routed.taskId) {
      return {
        ok: false,
        error: routed.error ?? routed.reason ?? "unknown dispatcher error",
      };
    }

    const routeClassHint = selectRouteClassHint(input.text, routed.taskType);
    let runStatus: string | undefined;
    let runError: string | undefined;

    if (input.runNow) {
      const workflow = new TaskWorkflow();
      const run = await workflow.run(env, {
        taskId: routed.taskId,
        workflowRunId: crypto.randomUUID(),
      });
      runStatus = run.status;
      runError = run.error;
    }

    return {
      ok: true,
      taskId: routed.taskId,
      taskType: routed.taskType,
      domain: routed.domain,
      confidence: routed.confidence,
      routeClassHint,
      runStatus,
      runError,
    };
  }

  // Runs an existing task via the current workflow engine.
  async runTaskNow(
    env: Env,
    taskId: string
  ): Promise<{ ok: boolean; status?: string; error?: string }> {
    const task = await getTask(env.R2_ARTIFACTS, taskId);
    if (!task) return { ok: false, error: "Task not found." };

    if (task.status === "completed") return { ok: true, status: "completed" };
    if (task.status === "in_progress") return { ok: true, status: "in_progress" };
    if (task.status === "awaiting_approval") return { ok: true, status: "awaiting_approval" };

    const workflow = new TaskWorkflow();
    const run = await workflow.run(env, {
      taskId,
      workflowRunId: crypto.randomUUID(),
    });
    return {
      ok: true,
      status: run.status,
      error: run.error,
    };
  }

  // Reads task status from the existing task store.
  async getTaskStatus(
    env: Env,
    taskId: string
  ): Promise<{ ok: boolean; taskId?: string; status?: string; approvalState?: string; taskType?: string; domain?: string }> {
    const task = await getTask(env.R2_ARTIFACTS, taskId);
    if (!task) return { ok: false };
    return {
      ok: true,
      taskId: task.taskId,
      status: task.status,
      approvalState: task.approvalState,
      taskType: task.taskType,
      domain: task.domain,
    };
  }

  // Uses existing /tasks/:taskId/approve route so approval logic stays centralized.
  async approveTask(
    env: Env,
    taskId: string,
    reviewerId: string,
    reason?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    return this.callTaskDecisionRoute(env, `tasks/${taskId}/approve`, { reviewerId, reason });
  }

  // Uses existing /tasks/:taskId/reject route so rejection logic stays centralized.
  async rejectTask(
    env: Env,
    taskId: string,
    reviewerId: string,
    reason?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    return this.callTaskDecisionRoute(env, `tasks/${taskId}/reject`, { reviewerId, reason });
  }

  async findMostRecentFailedTask(env: Env, taskIds: string[]): Promise<string | null> {
    for (let i = taskIds.length - 1; i >= 0; i -= 1) {
      const taskId = taskIds[i];
      const task = await getTask(env.R2_ARTIFACTS, taskId);
      if (task?.status === "failed") return taskId;
    }
    return null;
  }

  private async callTaskDecisionRoute(
    env: Env,
    path: string,
    body: { reviewerId: string; reason?: string }
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const { request } = getCurrentAgent();
    if (!request) {
      return { ok: false, error: "No active request context for task decision." };
    }

    const apiKey = getConfiguredApiKey(env);
    if (!apiKey) {
      return { ok: false, error: "API key not configured for task decision routes." };
    }

    const url = `${new URL(request.url).origin}/${path.replace(/^\/+/, "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        error:
          (payload && typeof payload.error === "string" && payload.error) ||
          `Task decision failed with status ${res.status}`,
      };
    }

    return {
      ok: true,
      message:
        (payload && typeof payload.message === "string" && payload.message) ||
        (payload && typeof payload.workflowStatus === "string" && `workflow=${payload.workflowStatus}`) ||
        "ok",
    };
  }
}

function textResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function resolveUserId(body?: Record<string, unknown>): string {
  if (!body) return "anonymous-user";
  const value = body.userId;
  return typeof value === "string" && value.trim() ? value.trim() : "anonymous-user";
}

function getConfiguredApiKey(env: Env): string | null {
  const vars = env as unknown as Record<string, unknown>;
  const key =
    (typeof vars.API_KEY === "string" && vars.API_KEY) ||
    (typeof vars.MVP_API_KEY === "string" && vars.MVP_API_KEY) ||
    "";
  return key.trim() ? key.trim() : null;
}

function extractLatestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = toRecord(messages[i]);
    if (!msg || msg.role !== "user") continue;

    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const textParts = parts
      .map((part) => {
        const rec = toRecord(part);
        if (!rec || rec.type !== "text") return "";
        return typeof rec.text === "string" ? rec.text : "";
      })
      .filter(Boolean);

    const joined = textParts.join(" ").trim();
    if (joined) return joined;
  }

  return "";
}

function isTaskLikeMessage(content: string): boolean {
  const text = content.toLowerCase();
  return /(create task|run task|draft|summarize|summary|review|analy|assess|investig|audit|report|triage|incident|status|approve|reject)/.test(text);
}

function isStatusQuery(content: string): boolean {
  const text = content.toLowerCase();
  return /(status|state|progress|where is|check)/.test(text);
}

function isApproveCommand(content: string): boolean {
  return /\b(approve|accept|okay this task)\b/i.test(content);
}

function isRejectCommand(content: string): boolean {
  return /\b(reject|deny|decline)\b/i.test(content);
}

function isRunNowRequest(content: string): boolean {
  return /\b(run now|start now|execute now|launch now)\b/i.test(content);
}

function isRunReferenceFollowUp(content: string): boolean {
  return /\b(run|start|execute|launch)\b\s+(that|it|this)(\s+now)?\b/i.test(content);
}

function isShowLastTaskFollowUp(content: string): boolean {
  return /\b(show|check|get|what(?:'s| is))\b.*\b(last|latest|previous)\s+task\b/i.test(content);
}

function isOpenFailedOneFollowUp(content: string): boolean {
  return /\bopen\b.*\b(failed one|failed task|last failed)\b/i.test(content);
}

function extractReason(content: string): string | undefined {
  const match = content.match(/\bbecause\b\s+(.+)$/i);
  if (!match) return undefined;
  const reason = match[1].trim();
  return reason ? reason.slice(0, 500) : undefined;
}

function extractTaskIdFromText(content: string): string | null {
  const taskPrefixed = content.match(/\btask-[a-z0-9-]+\b/i);
  if (taskPrefixed) return taskPrefixed[0];

  const uuid = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  return uuid ? uuid[0] : null;
}

function extractTaskIdsFromText(content: string): string[] {
  const ids: string[] = [];
  const matches = content.match(/\btask-[a-z0-9-]+\b/gi) ?? [];
  for (const match of matches) ids.push(match);

  const uuids = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi) ?? [];
  for (const uuid of uuids) ids.push(uuid);

  return ids;
}

interface ChatHistoryContext {
  previousUserRequest: string | null;
  latestTaskId: string | null;
  taskIds: string[];
}

function buildChatHistoryContext(messages: unknown[], latestUserContent: string): ChatHistoryContext {
  const userRequests: string[] = [];
  const taskIds: string[] = [];
  const seen = new Set<string>();

  for (const item of messages) {
    const msg = toRecord(item);
    if (!msg) continue;

    const text = extractTextFromMessage(msg);
    if (msg.role === "user" && text) {
      userRequests.push(text);
    }

    for (const id of extractTaskIdsFromText(text)) {
      const normalized = id.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      taskIds.push(normalized);
    }

    if (typeof msg.taskId === "string" && msg.taskId.trim() && !seen.has(msg.taskId.trim())) {
      const tid = msg.taskId.trim();
      seen.add(tid);
      taskIds.push(tid);
    }
  }

  let previousUserRequest: string | null = null;
  for (let i = userRequests.length - 1; i >= 0; i -= 1) {
    const candidate = userRequests[i];
    if (candidate && candidate !== latestUserContent) {
      previousUserRequest = candidate;
      break;
    }
  }

  return {
    previousUserRequest,
    latestTaskId: taskIds.length > 0 ? taskIds[taskIds.length - 1] : null,
    taskIds,
  };
}

function extractTextFromMessage(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string" && msg.content.trim()) {
    return msg.content.trim();
  }

  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text = parts
    .map((part) => {
      const rec = toRecord(part);
      if (!rec || rec.type !== "text" || typeof rec.text !== "string") return "";
      return rec.text;
    })
    .filter(Boolean)
    .join(" ")
    .trim();

  return text;
}

function formatPriorRequestReference(previousUserRequest: string | null): string {
  if (!previousUserRequest) return "";
  const compact = previousUserRequest.replace(/\s+/g, " ").trim();
  const clipped = compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
  return `From your earlier request: "${clipped}".`;
}

function selectRouteClassHint(
  content: string,
  taskType?: string
): "utility" | "tools" | "reasoning" | "vision" {
  const text = content.toLowerCase();
  if (/\b(image|diagram|screenshot|visual|vision)\b/.test(text)) return "vision";
  if (/\b(change|deploy|rollback|action plan|tool|command)\b/.test(text)) return "tools";
  if (taskType === "root_cause_analysis" || /\b(analy|investig|rca|why)\b/.test(text)) return "reasoning";
  return "utility";
}

function buildConversationalReply(content: string): string {
  const text = content.trim();
  if (/\b(hello|hi|hey)\b/i.test(text)) {
    return "Hi. I can help with task operations and regular conversation. Ask a question or describe work you want turned into a task.";
  }

  if (/\b(help|what can you do|capabilities)\b/i.test(text)) {
    return [
      "I support both task-oriented and freeform chat.",
      "Task actions: create/run tasks, check task status, approve, reject.",
      "Future-ready: route-class hints (utility/tools/reasoning/vision) and MCP-friendly task shaping.",
    ].join(" ");
  }

  // Preserve the prior fallback behavior while broadening beyond any single domain.
  return [
    "I can turn task-style requests into queued work items.",
    "Examples:",
    "- Draft an executive summary from incident notes",
    "- Review a proposed change and suggest risks",
    "- Create a weekly operations report draft",
    "- Status <task-id>",
  ].join(" ");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
