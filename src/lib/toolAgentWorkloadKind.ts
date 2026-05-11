/**
 * Workload classification for {@link ToolAgent} — stored in AI Gateway `task` metadata (see
 * {@link buildAiGatewayMetadataRecord} / `AgentObservabilityContext.taskId`).
 */

export const TOOL_AGENT_WORKLOAD_KINDS = ["mcp_api", "external_api", "tool_orchestration"] as const;

export type ToolAgentWorkloadKind = (typeof TOOL_AGENT_WORKLOAD_KINDS)[number];

const KIND_LEAD_REGEX =
  /^\[\[edgeclaw:tool-task-kind=(mcp_api|external_api|tool_orchestration)\]\]\s*\r?\n?/;

export function normalizeToolAgentWorkloadKind(v: unknown): ToolAgentWorkloadKind {
  const s = typeof v === "string" ? v.trim() : "";
  if (
    (TOOL_AGENT_WORKLOAD_KINDS as readonly string[]).includes(s)
  ) {
    return s as ToolAgentWorkloadKind;
  }
  return "tool_orchestration";
}

/**
 * Strips optional first-line workload marker (`[[edgeclaw:tool-task-kind=…]]`) so delegation
 * bodies (including envelopes) reach the LLM unchanged otherwise.
 */
export function peelToolAgentWorkloadKindLeadLine(message: string): {
  strippedMessage: string;
  kind: ToolAgentWorkloadKind;
} {
  const raw = typeof message === "string" ? message : "";
  const trimmedStart = raw.replace(/^\uFEFF/, "").trimStart();
  const match = trimmedStart.match(KIND_LEAD_REGEX);
  if (!match || !match[0]) {
    return { strippedMessage: raw, kind: "tool_orchestration" };
  }
  const k = normalizeToolAgentWorkloadKind(match[1]);
  const strippedMessage = trimmedStart.slice(match[0].length);
  return { strippedMessage, kind: k };
}
