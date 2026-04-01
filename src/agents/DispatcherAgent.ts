/**
 * agents/DispatcherAgent.ts
 * Cloudflare Dispatcher agent for task intake and routing.
 *
 * This file includes:
 * - deterministic-first classification helpers
 * - optional AI-assisted fallback classification (via AI Gateway)
 * - TaskPacket creation
 * - R2 persistence + worklog logging
 * - TaskCoordinatorDO initialization + QueueDO enqueue
 * - optional workflow start hook
 *
 * Note: Agents SDK surface evolves quickly. This class is SDK-ready and can be wrapped
 * by your chosen Cloudflare Agents SDK runtime entrypoint with minimal glue code.
 */

import {
  DomainType,
  TaskPacket,
  TaskType,
  WorklogEntry as CoreWorklogEntry,
} from "../lib/core-task-schema";
import { appendWorklogEntry, putTask } from "../lib/r2";
import { logAgentEvent } from "../lib/logger";
import { AgentContext, AgentResult, DispatchDecision, TaskKind } from "../lib/types";
import {
  coordinatorInitialize,
  InitializeTaskRequest,
} from "../durable/TaskCoordinatorDO";
import type { Env } from "../lib/types";

export interface DispatcherInboundRequest {
  userId: string;
  text: string;
  source: "chat" | "api";
  metadata?: Record<string, string>;
  inputArtifacts?: Array<{ artifactId: string; uri: string; kind?: "r2" | "url" | "inline" }>;
  startWorkflow?: boolean;
}

export interface DispatcherInboundResponse {
  ok: boolean;
  taskId?: string;
  taskType?: TaskType;
  domain?: DomainType;
  confidence?: number;
  classificationSource?: "deterministic" | "ai";
  humanReviewRequired?: boolean;
  workflowStarted?: boolean;
  reason?: string;
  error?: string;
}

export const LLM_CLASSIFICATION_PROMPT_TEMPLATE = `
You are a strict classifier for a Cloudflare-native network operations agent system.

Allowed taskType values:
- incident_triage
- change_review
- report_draft
- exec_summary
- vendor_followup
- root_cause_analysis

Allowed domain values:
- wifi
- nac
- ztna
- telecom
- content_filtering
- cross_domain

Return JSON only with keys:
{
  "taskType": "...",
  "domain": "...",
  "confidence": 0.0,
  "reason": "..."
}

User text:
{{TEXT}}
`.trim();

export const SAMPLE_DISPATCHER_REQUESTS: DispatcherInboundRequest[] = [
  {
    userId: "user-001",
    text: "Review this NAC policy change and draft CAB notes",
    source: "chat",
  },
  {
    userId: "user-002",
    text: "Summarize this WiFi outage for leadership",
    source: "api",
  },
  {
    userId: "user-003",
    text: "Create my weekly network report draft",
    source: "chat",
  },
  {
    userId: "user-004",
    text: "Analyze a ZTNA access problem from these notes",
    source: "api",
  },
];

export const SAMPLE_DISPATCHER_RESPONSE: DispatcherInboundResponse = {
  ok: true,
  taskId: "task-123",
  taskType: "change_review",
  domain: "nac",
  confidence: 0.88,
  classificationSource: "deterministic",
  humanReviewRequired: false,
  workflowStarted: false,
  reason: "Matched change + NAC + CAB terminology.",
};

export class DispatcherAgent {
  /**
   * Existing lightweight classifier used by the internal prototype workflow.
   */
  async run(
    context: AgentContext,
    objective: string,
    explicitKind?: TaskKind
  ): Promise<AgentResult<DispatchDecision>> {
    try {
      if (explicitKind) {
        return {
          agent: "dispatcher",
          ok: true,
          warnings: [],
          output: {
            kind: explicitKind,
            confidence: 1,
            reason: "Caller provided explicit task kind.",
          },
        };
      }

      const text = objective.toLowerCase();

      if (/(audit|verify|risk|compliance|validate)/.test(text)) {
        return this.result("audit", 0.79, "Objective matched audit terms.");
      }

      if (/(draft|report|summary|write|brief)/.test(text)) {
        return this.result("draft", 0.74, "Objective matched drafting terms.");
      }

      if (/(analy|investig|diagnos|assess|recommend|plan)/.test(text)) {
        return this.result("analyze", 0.76, "Objective matched analysis terms.");
      }

      return {
        agent: "dispatcher",
        ok: true,
        warnings: ["Low-confidence classification; defaulted to analyze."],
        output: {
          kind: "analyze",
          confidence: 0.51,
          reason: `No strong pattern matched for task ${context.taskId}.`,
        },
      };
    } catch (error: unknown) {
      return {
        agent: "dispatcher",
        ok: false,
        warnings: [],
        error: toMessage(error),
        output: {
          kind: "analyze",
          confidence: 0,
          reason: "Dispatcher failed.",
        },
      };
    }
  }

  private result(kind: TaskKind, confidence: number, reason: string): AgentResult<DispatchDecision> {
    return {
      agent: "dispatcher",
      ok: true,
      warnings: [],
      output: { kind, confidence, reason },
    };
  }

  /**
   * Inbound intake flow for chat/API requests.
   * Deterministic classification runs first; AI fallback only when confidence is low.
   */
  async handleInboundRequest(env: Env, request: DispatcherInboundRequest): Promise<DispatcherInboundResponse> {
    try {
      if (!request.userId || !request.text) {
        logAgentEvent(env, "dispatcher", "error", {
          message: "Inbound request missing userId or text",
        });
        return { ok: false, error: "userId and text are required" };
      }

      const taskId = crypto.randomUUID();
      logAgentEvent(env, "dispatcher", "start", {
        taskId,
        message: "Dispatching inbound request",
      });

      const deterministic = classifyDeterministic(request.text);
      let finalDecision = deterministic;

      if (deterministic.confidence < 0.7) {
        const aiDecision = await this.classifyWithAI(env, request.text);
        if (aiDecision && aiDecision.confidence > deterministic.confidence) {
          finalDecision = { ...aiDecision, source: "ai" };
        }
      }

      const humanReviewRequired = finalDecision.confidence < 0.65;
      const packet = buildTaskPacket(taskId, request, finalDecision.taskType, finalDecision.domain, humanReviewRequired);

      const saved = await putTask(env.R2_ARTIFACTS, packet);
      if (!saved.ok) {
        logAgentEvent(env, "dispatcher", "error", {
          taskId,
          message: "Failed to store task",
          data: { error: saved.error },
        });
        return { ok: false, error: `Failed to store task: ${saved.error}` };
      }

      const coordinatorStub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
      const initReq: InitializeTaskRequest = {
        taskId,
        initialStatus: "new",
        approvalState: mapApprovalForCoordinator(packet.approvalState),
      };
      const initRes = await coordinatorInitialize(coordinatorStub, initReq);
      if (!initRes.ok) {
        logAgentEvent(env, "dispatcher", "error", {
          taskId,
          message: "Failed to initialize TaskCoordinatorDO",
          data: { error: initRes.error || "unknown" },
        });
        return { ok: false, error: initRes.error || "Failed to initialize TaskCoordinatorDO" };
      }

      // Queue enqueue deferred for Phase 2 (MVP doesn't queue)

      const worklogEntry: CoreWorklogEntry = {
        entryId: crypto.randomUUID(),
        taskId,
        agentRole: "dispatcher",
        timestamp: new Date().toISOString(),
        action: "routing_decision",
        summary: `Routed to ${finalDecision.taskType}/${finalDecision.domain} with confidence ${finalDecision.confidence.toFixed(2)}.`,
        detail: {
          source: finalDecision.source,
          confidence: finalDecision.confidence,
          reason: finalDecision.reason,
          humanReviewRequired,
        },
      };
      await appendWorklogEntry(env.R2_WORKLOGS, worklogEntry);

      const shouldStartWorkflow = request.startWorkflow || env.AUTO_START_WORKFLOW === "true";
      let workflowStarted = false;
      if (shouldStartWorkflow) {
        workflowStarted = await maybeStartWorkflow(env, taskId, finalDecision.taskType);
      }

      logAgentEvent(env, "dispatcher", "complete", {
        taskId,
        message: "Dispatch complete",
        data: {
          taskType: finalDecision.taskType,
          domain: finalDecision.domain,
          workflowStarted,
        },
      });

      return {
        ok: true,
        taskId,
        taskType: finalDecision.taskType,
        domain: finalDecision.domain,
        confidence: finalDecision.confidence,
        classificationSource: finalDecision.source,
        humanReviewRequired,
        workflowStarted,
        reason: finalDecision.reason,
      };
    } catch (error: unknown) {
      logAgentEvent(env, "dispatcher", "error", {
        message: "Unhandled dispatcher error",
        data: { error: toMessage(error) },
      });
      return { ok: false, error: toMessage(error) };
    }
  }

  private async classifyWithAI(
    env: Env,
    text: string
  ): Promise<{ taskType: TaskType; domain: DomainType; confidence: number; reason: string } | null> {
    const base = env.AI_GATEWAY_BASE_URL;
    const token = env.AI_GATEWAY_TOKEN;
    const route = env.AI_GATEWAY_ROUTE_CLASSIFIER || env.AI_GATEWAY_ROUTE_ANALYST;

    if (!base || !token || !route) {
      // TODO: Configure AI Gateway classifier route in Wrangler vars for LLM-assisted classification.
      return null;
    }

    const prompt = LLM_CLASSIFICATION_PROMPT_TEMPLATE.replace("{{TEXT}}", text);
    const response = await fetch(`${base.replace(/\/$/, "")}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "Classify request into taskType/domain and output strict JSON." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      return null;
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const textOut = extractGatewayText(raw);
    const parsed = safeJsonParse(textOut);
    if (!parsed) return null;

    const taskType = parsed.taskType;
    const domain = parsed.domain;
    const confidence = parsed.confidence;
    const reason = parsed.reason;

    if (!isTaskType(taskType) || !isDomainType(domain)) return null;
    if (typeof confidence !== "number") return null;

    return {
      taskType,
      domain,
      confidence: Math.max(0, Math.min(1, confidence)),
      reason: typeof reason === "string" ? reason : "AI-assisted classification",
    };
  }
}

type Decision = {
  taskType: TaskType;
  domain: DomainType;
  confidence: number;
  reason: string;
  source: "deterministic" | "ai";
};

export function classifyDeterministic(text: string): Decision {
  const lower = text.toLowerCase();

  const taskScores: Record<TaskType, number> = {
    incident_triage: 0,
    change_review: 0,
    report_draft: 0,
    exec_summary: 0,
    vendor_followup: 0,
    root_cause_analysis: 0,
  };

  const domainScores: Record<DomainType, number> = {
    wifi: 0,
    nac: 0,
    ztna: 0,
    telecom: 0,
    content_filtering: 0,
    cross_domain: 0,
  };

  addScore(taskScores, "change_review", lower, [/\bchange\b/, /policy/, /cab/, /review/], 0.3);
  addScore(taskScores, "exec_summary", lower, [/leadership/, /executive/, /exec/, /brief/], 0.3);
  addScore(taskScores, "report_draft", lower, [/weekly/, /report/, /draft/], 0.25);
  addScore(taskScores, "incident_triage", lower, [/incident/, /outage/, /problem/, /triage/], 0.3);
  addScore(taskScores, "root_cause_analysis", lower, [/root cause/, /analy[sz]e/, /why did/], 0.28);
  addScore(taskScores, "vendor_followup", lower, [/vendor/, /provider/, /carrier/, /follow up/], 0.3);

  addScore(domainScores, "wifi", lower, [/wifi/, /wireless/, /ap\b/, /ssid/], 0.35);
  addScore(domainScores, "nac", lower, [/nac/, /802\.1x/, /policy change/], 0.35);
  addScore(domainScores, "ztna", lower, [/ztna/, /zero trust/, /access problem/], 0.35);
  addScore(domainScores, "telecom", lower, [/telecom/, /carrier/, /sip/, /pbx/], 0.35);
  addScore(domainScores, "content_filtering", lower, [/content filtering/, /web filter/, /dns filter/], 0.35);

  const taskType = maxKey(taskScores);
  let domain = maxKey(domainScores);

  const taskScore = taskScores[taskType];
  const domainScore = domainScores[domain];
  if (domainScore <= 0) {
    domain = "cross_domain";
  }

  const confidence = Math.max(0.35, Math.min(0.95, taskScore + (domainScore > 0 ? domainScore : 0.2)));
  return {
    taskType,
    domain,
    confidence,
    reason: `Deterministic match task=${taskType} (${taskScore.toFixed(2)}), domain=${domain} (${domainScore.toFixed(2)}).`,
    source: "deterministic",
  };
}

function addScore<T extends string>(scores: Record<T, number>, key: T, text: string, patterns: RegExp[], weight: number): void {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      scores[key] += weight;
    }
  }
}

function maxKey<T extends string>(scores: Record<T, number>): T {
  let bestKey = Object.keys(scores)[0] as T;
  let bestVal = scores[bestKey];

  for (const key of Object.keys(scores) as T[]) {
    if (scores[key] > bestVal) {
      bestKey = key;
      bestVal = scores[key];
    }
  }

  return bestKey;
}

function buildTaskPacket(
  taskId: string,
  request: DispatcherInboundRequest,
  taskType: TaskType,
  domain: DomainType,
  humanReviewRequired: boolean
): TaskPacket {
  const now = new Date().toISOString();
  return {
    taskId,
    taskType,
    domain,
    title: makeTitle(taskType, domain, request.text),
    goal: request.text,
    definitionOfDone: defaultDefinitionOfDone(taskType),
    allowedTools: ["r2.read", "r2.write", "do.task_coordinator", "do.queue"],
    forbiddenActions: ["direct_production_change", "secret_exfiltration", "pii_export"],
    inputArtifacts: (request.inputArtifacts || []).map((a) => ({
      artifactId: a.artifactId,
      kind: a.kind || "url",
      uri: a.uri,
      createdAt: now,
    })),
    dependencies: [],
    status: "queued",
    approvalState: humanReviewRequired ? "pending" : "not_required",
    escalationRules: [
      {
        level: "warn",
        condition: "No heartbeat update in 15 minutes",
        action: "notify_owner",
        timeoutMinutes: 15,
      },
      {
        level: "critical",
        condition: "Task retry count >= 3",
        action: "notify_oncall",
        timeoutMinutes: 5,
      },
    ],
    createdAt: now,
    updatedAt: now,
    assignedAgentRole: "dispatcher",
    metadata: {
      source: request.source === "chat" ? "manual" : "api",
      correlationId: request.metadata?.correlationId,
      priority: humanReviewRequired ? "high" : "normal",
      tags: [taskType, domain],
      custom: {
        humanReviewRequired,
        rawInput: request.text,
      },
    },
  };
}

function mapApprovalForCoordinator(
  value: TaskPacket["approvalState"]
): InitializeTaskRequest["approvalState"] {
  if (value === "not_required") return "not_required";
  if (value === "pending") return "pending";
  if (value === "approved") return "approved";
  return "rejected";
}

function defaultDefinitionOfDone(taskType: TaskType): string[] {
  if (taskType === "change_review") {
    return ["Risk summary complete", "CAB notes drafted", "Rollback considerations documented"];
  }
  if (taskType === "exec_summary") {
    return ["Executive summary drafted", "Top risks included", "Recommended next actions listed"];
  }
  if (taskType === "report_draft") {
    return ["Weekly report draft complete", "Metrics section included", "Action items listed"];
  }
  if (taskType === "root_cause_analysis") {
    return ["Probable root causes identified", "Evidence linked", "Mitigation plan drafted"];
  }
  if (taskType === "vendor_followup") {
    return ["Vendor follow-up brief drafted", "Open questions listed", "Escalation owner identified"];
  }
  return ["Incident triage summary complete", "Severity + impact captured", "Initial next steps proposed"];
}

function makeTitle(taskType: TaskType, domain: DomainType, text: string): string {
  const prefix = `${taskType.replace(/_/g, " ")} - ${domain.replace(/_/g, " ")}`;
  const tail = text.length > 72 ? `${text.slice(0, 72)}...` : text;
  return `${prefix}: ${tail}`;
}

function isTaskType(value: unknown): value is TaskType {
  return (
    value === "incident_triage" ||
    value === "change_review" ||
    value === "report_draft" ||
    value === "exec_summary" ||
    value === "vendor_followup" ||
    value === "root_cause_analysis"
  );
}

function isDomainType(value: unknown): value is DomainType {
  return (
    value === "wifi" ||
    value === "nac" ||
    value === "ztna" ||
    value === "telecom" ||
    value === "content_filtering" ||
    value === "cross_domain"
  );
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractGatewayText(raw: Record<string, unknown>): string {
  const result = raw.result as Record<string, unknown> | undefined;
  if (result && typeof result.response === "string") return result.response;
  if (typeof raw.response === "string") return raw.response;
  return JSON.stringify(raw);
}

async function maybeStartWorkflow(env: Env, taskId: string, taskType: TaskType): Promise<boolean> {
  const endpoint = env.WORKFLOW_START_ENDPOINT;
  if (!endpoint) {
    // TODO: Add workflow start endpoint/service binding when workflow engine routing is finalized.
    return false;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, taskType }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Future connector placement guidance:
 * - Teams connector: src/connectors/teams/
 * - Discord connector: src/connectors/discord/
 * - Web UI/API gateway adapters: src/connectors/web/
 *
 * Connectors should only normalize inbound payloads into DispatcherInboundRequest,
 * then call handleInboundRequest(). Keep classifier/routing logic in this agent.
 */

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown dispatcher error";
}
