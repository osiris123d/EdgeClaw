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

function requiresStrictOpenApiChain(userRequest: string): boolean {
  const lower = userRequest.toLowerCase();
  const hasLiteralChain =
    lower.includes("openapi_search") &&
    lower.includes("openapi_describe_operation") &&
    lower.includes("cloudflare_request");

  if (hasLiteralChain) return true;

  const hasSearchDescribeCue =
    /openapi\s+search\s*\/\s*describe/i.test(lower) ||
    /search\s*\/\s*describe/i.test(lower) ||
    (/openapi\s+search/i.test(lower) && /openapi\s+describe/i.test(lower));

  const hasGetOnlyConstraint =
    /then\s+call\s+only\s+get/i.test(lower) ||
    /call\s+only\s+get/i.test(lower) ||
    /only\s+get\s*\/accounts\/\{account_id\}\/gateway\/rules/i.test(lower);

  const hasVerificationCue =
    /describestatus/i.test(lower) ||
    /describestatekeys/i.test(lower) ||
    /invocationstoreid/i.test(lower) ||
    /invocationstorepresent/i.test(lower);

  return hasSearchDescribeCue && hasGetOnlyConstraint && hasVerificationCue;
}

/**
 * Builds the RPC body MainAgent sends to {@link ToolAgent} (workload lead line + guardrails + user text).
 */
export function formatDelegateToolAgentMessage(input: {
  userRequest: string;
  taskKind: DelegateToolTaskKind;
  guidanceSkillKey?: string;
  constraints?: string;
  /** Runtime account for AI Gateway / mirrored execution context only (not the user target API account). */
  runtimeAccountId?: string;
  /** Explicit target API account id extracted from user intent when available. */
  targetAccountId?: string;
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
  const strictOpenApiChain = requiresStrictOpenApiChain(req);
  const runtimeAcct =
    typeof input.runtimeAccountId === "string" ? input.runtimeAccountId.trim() : "";
  const targetAcct =
    typeof input.targetAccountId === "string" ? input.targetAccountId.trim() : "";
  const lines: string[] = [
    `[[edgeclaw:tool-task-kind=${wk}]]`,
    "",
    "**Delegation policy (must follow):** Do not deploy workloads, delete resources, cancel persisted scheduled tasks, mutate workflow definitions or runs, or change other durable orchestration state unless the **User request** section below **explicitly** asks for that outcome. Prefer read-only discovery and API calls unless the user clearly requested a write/mutation.",
    "",
  ];
  if (runtimeAcct) {
    lines.push(
      "**Cloudflare runtime account (AI Gateway / mirrored MCP execute context only):**",
      "",
      `Runtime context account id: \`${runtimeAcct}\`.`,
      "",
      "Treat `CLOUDFLARE_ACCOUNT_ID` as runtime/AI-Gateway context only. For API calls, use the account id explicitly provided by the user request as the target account. Do not inject the runtime account as `account_id` for user API actions.",
      ""
    );
  }
  if (targetAcct) {
    lines.push(
      "**Target API account (from user request):**",
      "",
      `Use \`${targetAcct}\` as the target \`account_id\` for API operations.`,
      "",
      "When codemode/cloudflare_request uses knownValues, set `knownValues.account_id` to this target account id.",
      "",
      "The user already supplied the target account id; do not ask for account id again unless they ask to switch accounts.",
      ""
    );
  }
  if (skill) {
    lines.push(`Optional guidance skill key (context only — load via normal skills flow if needed): \`${skill.replace(/`/g, "'")}\``, "");
  }
  if (constraints) {
    lines.push("**Constraints**", "", constraints, "");
  }
  if (strictOpenApiChain) {
    lines.push(
      "**OpenAPI chain contract (explicit user requirement):**",
      "",
      "Use this exact chain: `openapi_search` -> `openapi_describe_operation` -> `cloudflare_request`.",
      "Do not substitute `tools_call_code` for this path unless fallback is explicitly requested, and always disclose fallback use in the final answer.",
      ""
    );
  }
  lines.push("---", "", "**User request**", "", req);
  return lines.join("\n");
}
