/**
 * EdgeClaw observability helpers for Cloudflare AI Gateway.
 *
 * Custom request metadata is sent as the `cf-aig-metadata` header (JSON object).
 * AI Gateway documents a maximum of **5** custom metadata entries per request;
 * we reserve keys: `worker`, `agent`, `project`, `task`, `run` (all scalar strings).
 *
 * @see https://developers.cloudflare.com/ai-gateway/configuration/custom-metadata/
 */

import type { ModelBindings } from "../models/types";
import { parseSharedDelegationEnvelope } from "../workspace/delegationEnvelope";

/** Full context we may thread through coordinator paths (session is UI / logs, not sent as a 6th gateway key). */
export interface AgentObservabilityContext {
  worker: string;
  agent: EdgeClawGatewayAgentName;
  projectId?: string;
  taskId?: string;
  runId?: string;
  /** Chat / DO session id — not included in AI Gateway metadata (5-key cap). */
  sessionId?: string;
}

/** Canonical agent labels for AI Gateway `agent` metadata. */
export type EdgeClawGatewayAgentName =
  | "MainAgent"
  | "SubagentCoordinatorThink"
  | "CoderAgent"
  | "TesterAgent";

const GATEWAY_META_KEYS = ["worker", "agent", "project", "task", "run"] as const;

export type AiGatewayLogMetadata = Partial<
  Record<(typeof GATEWAY_META_KEYS)[number], string | number | boolean>
> & { worker?: string; agent?: string };

/**
 * Builds the JSON object for `cf-aig-metadata`, enforcing the 5-key limit and scalar values.
 * Omits empty / undefined fields. `worker` defaults to `"EdgeClaw"`.
 */
export function buildAiGatewayMetadataRecord(
  input: Partial<AgentObservabilityContext> & { agent: EdgeClawGatewayAgentName | string }
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const worker = input.worker?.trim() || "EdgeClaw";
  out.worker = worker;

  const agent = String(input.agent).trim();
  if (agent) out.agent = agent;

  const project = pickScalar(input.projectId);
  if (project !== undefined) out.project = project;

  const task = pickScalar(input.taskId);
  if (task !== undefined) out.task = task;

  const run = pickScalar(input.runId);
  if (run !== undefined) out.run = run;

  // Hard cap: keep only canonical keys (defensive if callers extend types later).
  const capped: Record<string, string | number | boolean> = {};
  for (const k of GATEWAY_META_KEYS) {
    if (out[k] !== undefined) capped[k] = out[k] as string | number | boolean;
  }
  return capped;
}

function pickScalar(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, 512);
}

/** JSON string for the `cf-aig-metadata` header. */
export function serializeAiGatewayMetadata(
  record: Record<string, string | number | boolean>
): string {
  return JSON.stringify(record);
}

/** Map Think subclass name to AI Gateway `agent` metadata (main chat omits envelope). */
export function edgeClawGatewayAgentFromConstructorName(className: string): EdgeClawGatewayAgentName {
  if (className === "MainAgent") return "MainAgent";
  if (className === "SubagentCoordinatorThink") return "SubagentCoordinatorThink";
  if (className === "CoderAgent") return "CoderAgent";
  if (className === "TesterAgent") return "TesterAgent";
  return "MainAgent";
}

/**
 * Derives AI Gateway metadata fields from a delegated sub-agent user message that may include
 * `[EdgeClawSharedWorkspace]…[/EdgeClawSharedWorkspace]` JSON (see `delegationEnvelope.ts`).
 */
export function gatewayObservabilityFromDelegatedUserMessage(
  rawMessage: string,
  fallbackAgent: EdgeClawGatewayAgentName
): Partial<AgentObservabilityContext> & { agent: EdgeClawGatewayAgentName } {
  const trimmed = typeof rawMessage === "string" ? rawMessage.trim() : "";
  const parsed = parseSharedDelegationEnvelope(trimmed);
  if (!parsed) {
    return { agent: fallbackAgent };
  }
  const agent: EdgeClawGatewayAgentName =
    parsed.role === "coder" ? "CoderAgent" : "TesterAgent";
  const projectId = (parsed.controlPlaneProjectId?.trim() || parsed.projectId).trim() || undefined;
  return {
    agent,
    ...(projectId ? { projectId } : {}),
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.runId ? { runId: parsed.runId } : {}),
  };
}

/** Merges explicit turn observability with defaults for `cf-aig-metadata`. */
export function buildModelBindingsForAiGateway(
  aiGatewayToken: string | undefined,
  obs: Partial<AgentObservabilityContext> & { agent: EdgeClawGatewayAgentName }
): ModelBindings {
  const record = buildAiGatewayMetadataRecord(obs);
  return {
    aiGatewayToken,
    aiGatewayMetadataJson: serializeAiGatewayMetadata(record),
  };
}
