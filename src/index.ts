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
import { TaskPacket, TaskType, DomainType } from "./lib/core-task-schema";
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
  createChatMessage,
  createChatSession,
  getChatSession,
  listChatMessages,
  putChatSession,
  renderChatPage,
  sseEvent,
} from "./lib/chat";

export { TaskCoordinatorDO, ChatAgentImpl };

// ─── Route patterns ───────────────────────────────────────────────────────────

const RE_APPROVE  = /^\/tasks\/([^/]+)\/approve$/;
const RE_REJECT   = /^\/tasks\/([^/]+)\/reject$/;
const RE_APPROVAL = /^\/tasks\/([^/]+)\/approval$/;
const RE_TASK_GET = /^\/tasks\/([^/]+)$/;
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
  return pathname === "/chat" || pathname.startsWith("/api/chat/") || pathname === "/api/chat/sessions" || pathname.startsWith("/api/agents/");
}

function isApiKeyOnlyRoute(pathname: string): boolean {
  return pathname.startsWith("/tasks");
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
      const browserAuth = isBrowserFacingRoute(pathname) ? authenticateRequest(request, env) : null;

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

      if (isApiKeyOnlyRoute(pathname)) {
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

      // ── GET /chat ──────────────────────────────────────────────────────────
      // Minimal frontend entrypoint. No bundler or React runtime required.
      if (request.method === "GET" && pathname === "/chat") {
        return new Response(renderChatPage(), {
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

        const parsed = await parseJsonOr400(request);
        if (!parsed.ok) {
          return parsed.response;
        }
        const body = parsed.body as Record<string, unknown>;
        const content = typeof body.content === "string" ? body.content.trim() : "";
        const userId =
          browserAuth?.mode === "access-browser" && browserAuth.userId
            ? browserAuth.userId
            : typeof body.userId === "string" && body.userId
              ? body.userId
              : session.userId;

        if (!content) {
          return json({ ok: false, error: "content is required." }, 400);
        }

        const userMessage = createChatMessage(sessionId, { role: "user", content });
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

                const requestedTaskId = extractTaskIdFromText(content);
                if (requestedTaskId && isStatusQuery(content)) {
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
                } else if (isTaskLikeMessage(content)) {
                  // Message-to-task mapping:
                  // - raw chat text becomes DispatcherInboundRequest.text
                  // - DispatcherAgent classifies it and creates the TaskPacket
                  // - assistant response returns the new taskId and queue status
                  const dispatcher = new DispatcherAgent();
                  const routed = await dispatcher.handleInboundRequest(env, {
                    userId,
                    text: content,
                    source: "chat",
                    startWorkflow: false,
                  });

                  if (routed.ok && routed.taskId) {
                    taskId = routed.taskId;
                    taskStatus = "queued";
                    assistantText = [
                      `I created task ${routed.taskId}.`,
                      `Classification: ${routed.taskType}/${routed.domain} with confidence ${(routed.confidence ?? 0).toFixed(2)}.`,

                      `Use “status ${routed.taskId}” here to check progress later.`,
                    ].join(" ");

                    controller.enqueue(encoder.encode(sseEvent({
                      type: "task",
                      data: { taskId, status: taskStatus, taskType: routed.taskType, domain: routed.domain },
                    })));
                  } else {
                    assistantText = `I could not create a task from that message: ${routed.error ?? routed.reason ?? "unknown dispatcher error"}.`;
                  }
                } else {
                  assistantText = [
                    "I can turn task-style requests into queued work items.",
                    "Examples:",
                    "- Draft CAB notes for a NAC policy rollback",
                    "- Summarize this WiFi outage for leadership",
                    "- Create a weekly network report draft",
                    "- Status task-123",
                  ].join(" ");
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

      // ── Route listing ───────────────────────────────────────────────────────
      return json(
        {
          ok: true,
          routes: [
            "GET  /chat",
            "GET  /health",
            "GET  /ready",
            "POST /api/chat/sessions",
            "GET  /api/chat/sessions/:sessionId/messages",
            "POST /api/chat/sessions/:sessionId/messages",
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
  return /\b(draft|summari[sz]e|summary|report|cab|review|analy[sz]e|investigate|triage|vendor|leadership|executive|status)\b/.test(lower);
}

function isStatusQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(status|state|progress|update)\b/.test(lower);
}

function extractTaskIdFromText(text: string): string | null {
  const match = /\b(task-[a-z0-9-]+)\b/i.exec(text);
  return match ? match[1] : null;
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
