import {
  normalizeToolAgentWorkloadKind,
  type ToolAgentWorkloadKind,
} from "../lib/toolAgentWorkloadKind";

/** Caller-facing task kind (includes `unknown`; maps to a concrete workload for ToolAgent metadata). */
export type DelegateToolTaskKind = "mcp_api" | "external_api" | "tool_orchestration" | "unknown";

/** Map UI / tool enum → first-line EdgeClaw workload marker (unknown → tool_orchestration). */
export function delegateToolTaskKindToWorkload(kind: DelegateToolTaskKind): ToolAgentWorkloadKind {
  if (kind === "unknown") return "tool_orchestration";
  return normalizeToolAgentWorkloadKind(kind);
}

const MAX_GUIDANCE_KEY = 512;
const MAX_CONSTRAINTS = 32_000;

/**
 * Builds the RPC body MainAgent sends to {@link ToolAgent} (workload lead line + guardrails + user text).
 */
export function formatDelegateToolAgentMessage(input: {
  userRequest: string;
  taskKind: DelegateToolTaskKind;
  guidanceSkillKey?: string;
  constraints?: string;
  /** When set, ToolAgent should use this account for Cloudflare API / codemode (do not ask the user for account id). */
  cloudflareAccountId?: string;
}): string {
  const wk = delegateToolTaskKindToWorkload(input.taskKind);
  let skill = typeof input.guidanceSkillKey === "string" ? input.guidanceSkillKey.trim() : "";
  if (skill.length > MAX_GUIDANCE_KEY) {
    skill = `${skill.slice(0, MAX_GUIDANCE_KEY)}…`;
  }
  let constraints = typeof input.constraints === "string" ? input.constraints.trim() : "";
  if (constraints.length > MAX_CONSTRAINTS) {
    constraints = `${constraints.slice(0, MAX_CONSTRAINTS)}…`;
  }
  const req = typeof input.userRequest === "string" ? input.userRequest.trim() : "";
  const cfAcct =
    typeof input.cloudflareAccountId === "string" ? input.cloudflareAccountId.trim() : "";
  const lines: string[] = [
    `[[edgeclaw:tool-task-kind=${wk}]]`,
    "",
    "**Delegation policy (must follow):** Do not deploy workloads, delete resources, cancel persisted scheduled tasks, mutate workflow definitions or runs, or change other durable orchestration state unless the **User request** section below **explicitly** asks for that outcome. Prefer read-only discovery and API calls unless the user clearly requested a write/mutation.",
    "",
  ];
  if (cfAcct) {
    lines.push(
      "**Cloudflare account (preset for MCP execute / codemode):**",
      "",
      `The mirrored MCP execute environment is already scoped to Cloudflare account id \`${cfAcct}\`. Use codemode \`openapi_search\` → \`openapi_describe_operation\` → \`cloudflare_request\` (or inner \`cloudflare.request\`) with \`/accounts/{account_id}/...\` paths — **do not** ask the user for an account id unless the user request explicitly concerns a different account.`,
      ""
    );
  }
  if (skill) {
    lines.push(`Optional guidance skill key (context only — load via normal skills flow if needed): \`${skill.replace(/`/g, "'")}\``, "");
  }
  if (constraints) {
    lines.push("**Constraints**", "", constraints, "");
  }
  lines.push("---", "", "**User request**", "", req);
  return lines.join("\n");
}
