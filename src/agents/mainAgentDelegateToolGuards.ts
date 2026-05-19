/**
 * MainAgent delegation terminal behavior for Gateway steps and tool calls — Think-free for Node tests.
 */

import type { LanguageModel } from "ai";
import type { StepConfig, ToolCallDecision } from "@cloudflare/think";
import { createDeterministicTextModel } from "./browserToolAvailability";
import {
  isMainAgentDelegateFailureBlockedToolName,
  isMainAgentReductionHiddenToolName,
} from "./mainAgentToolSurfaceReduction";

/**
 * Locate "ToolAgent" / "tool agent" / "tool-agent" phrasing for delegation intent (case-insensitive).
 * Returns starting index or -1 when absent.
 */
function findToolAgentMentionIndex(normalized: string): number {
  const patterns = [/\btoolagent\b/i, /\btool\s+agent\b/i, /\btool[- ]agent\b/i];
  let best = -1;
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m.index !== undefined && (best === -1 || m.index < best)) {
      best = m.index;
    }
  }
  return best;
}

/**
 * True when the latest user text clearly instructs MainAgent to hand work to ToolAgent
 * (e.g. "Delegate … to ToolAgent"). Drives a first-step `delegate_tool_task` gate in `beforeTurn`.
 */
export function isExplicitDelegateToToolAgentUserMessage(text: string): boolean {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t.length) return false;
  const normalized = t.replace(/\s+/g, " ");
  const idxTa = findToolAgentMentionIndex(normalized);
  if (idxTa < 0) return false;
  const delegateLike = /\bdelegat(?:e|ed|es|ing)\b/i;
  if (!delegateLike.test(normalized)) return false;
  const matchDa = normalized.match(delegateLike);
  if (!matchDa || matchDa.index === undefined) return false;
  return Math.abs(matchDa.index - idxTa) <= 400;
}

export function mergeStepConfigFreezeToolsForDelegationTerminal(
  parent: StepConfig | void | undefined
): Record<string, unknown> & { activeTools: string[]; toolChoice: "none" } {
  const parentObj = parent && typeof parent === "object" ? parent : undefined;
  return {
    ...(parentObj ?? {}),
    activeTools: [],
    toolChoice: "none",
  };
}

/**
 * After `delegate_tool_task` fails, the next model step must emit the exact tool-returned failure text —
 * not a free-form continuation that could hallucinate success. Uses the same deterministic guard model
 * pattern as browser-tools-unavailable short-circuit.
 */
export function mergeDelegationFailureTerminalStepConfig(
  parent: StepConfig | void | undefined,
  delegateFailureExactReply: string
): Record<string, unknown> & {
  activeTools: string[];
  toolChoice: "none";
  model: LanguageModel;
} {
  const frozen = mergeStepConfigFreezeToolsForDelegationTerminal(parent);
  return {
    ...frozen,
    model: createDeterministicTextModel(delegateFailureExactReply),
  };
}

export const MAIN_AGENT_DELEGATE_FAILURE_BEFORE_TOOL_CALL_REASON =
  "ToolAgent delegation failed this turn (including MCP bootstrap). Do not invoke codemode, execute, MCP/OpenAPI tools, or relay tool_* search/execute — reconnect/re-save the MCP server or verify EDGECLAW_PUBLIC_ORIGIN.";

export const MAIN_AGENT_DELEGATE_SUCCESS_TERMINAL_BEFORE_TOOL_CALL_REASON =
  "This turn already delegated tool orchestration to ToolAgent via delegate_tool_task — do not invoke codemode, execute, or raw MCP/OpenAPI tools again.";

/**
 * Result of {@link detectMcpToolApiDelegationIntent}.
 */
export interface McpToolApiDelegationIntent {
  /** True when the message should force `delegate_tool_task` via the MCP/API tool-action path. */
  matched: boolean;
  /** Suggested `taskKind` for the `delegate_tool_task` call. */
  taskKind: "mcp_api" | "tool_orchestration";
  /** Short human-readable reason for the routing decision — included in telemetry logs. */
  reason: string;
}

/**
 * Detects when a user message implicitly requests ToolAgent delegation because it asks to use an
 * MCP server/tool, external tool, OpenAPI tool, or connected API to perform a data-fetching /
 * inspection action — without needing to say "delegate to ToolAgent" explicitly.
 *
 * Rules (all provider-agnostic):
 * - Matches when a tool/MCP/API trigger phrase co-occurs with an action verb.
 * - Does NOT match pure conceptual questions ("What is MCP?"), browser tasks, or general chat.
 */
export function detectMcpToolApiDelegationIntent(text: string): McpToolApiDelegationIntent {
  const NO_MATCH: McpToolApiDelegationIntent = { matched: false, taskKind: "tool_orchestration", reason: "no_match" };
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return NO_MATCH;
  const s = t.toLowerCase();

  // ── Exclusion: pure conceptual / definitional questions ───────────────────
  // "What is MCP?", "Explain what an API gateway is", "How does OpenAPI work?"
  // Match if the sentence starts with (or is predominantly) a definition request.
  const conceptualPrefixes = [
    /^\s*what\s+(is|are|does|do)\b/,
    /^\s*explain\b/,
    /^\s*define\b/,
    /^\s*how\s+does\b/,
    /^\s*how\s+do\b/,
    /^\s*can\s+you\s+explain\b/,
    /^\s*tell\s+me\s+(what|about|how)\b/,
    /^\s*describe\s+(what|how)\b/,
  ];
  if (conceptualPrefixes.some((re) => re.test(s))) return { ...NO_MATCH, reason: "conceptual_question" };

  // ── Exclusion: browser / dashboard / UI tasks ─────────────────────────────
  if (/\b(open|show|navigate|go\s+to)\b.*(dashboard|browser|tab|page|url|link)\b/.test(s)) {
    return { ...NO_MATCH, reason: "browser_task" };
  }

  // ── Step 1: detect an MCP / tool-server trigger phrase ────────────────────
  const mcpPhrases = [
    /\buse\s+(the\s+)?mcp(\s+(server|tool|tools))?\b/,
    /\bmcp\s+(server|tool|tools|connection|gateway)\b/,
    /\bvia\s+mcp\b/,
    /\bcall\s+(the\s+)?mcp\b/,
    /\bconnected\s+tool(s)?\b/,
    /\bexternal\s+tool(s)?\b/,
    /\btool\s+server\b/,
    /\buse\s+(the\s+)?tool\s+server\b/,
  ];
  const apiPhrases = [
    /\bopenapi\b/,
    /\bapi\s+tool(s)?\b/,
    /\bcall\s+the\s+api\b/,
    /\bquery\s+the\s+api\b/,
    /\buse\s+the\s+api\b/,
    /\bvia\s+(the\s+)?api\b/,
    /\bthrough\s+(the\s+)?api\b/,
  ];

  const hasMcpTrigger = mcpPhrases.some((re) => re.test(s));
  const hasApiTrigger = apiPhrases.some((re) => re.test(s));

  // Additional Cloudflare/OpenAPI route cues for API tasks that often omit explicit
  // "use MCP" phrasing (for example: account_id + gateway/rules lookup requests).
  // Intentionally does NOT match plain "read-only" by itself.
  const hasRouteCueTrigger =
    /\/accounts\/(?:\{account_id\}|[a-f0-9]{32})\//i.test(s) ||
    (/\baccount[_\s-]?id\b/i.test(s) &&
      (/\bgateway\s*\/\s*rules\b/i.test(s) || /\bgateway[_\s-]?rules\b/i.test(s)));

  // ── Step 2: require an action verb ────────────────────────────────────────
  // Includes data-fetching verbs AND analysis/generation verbs, so requests like
  // "use MCP to review policies and draft a script" still route to ToolAgent.
  const actionVerbs = /\b(list|get|fetch|retrieve|query|search|inspect|describe|summarize|call|check|look\s+up|lookup|find|show|enumerate|pull|read|count|filter|review|analyze|analyse|audit|assess|inventory|compare|map|generate|create|draft|write|build)\b/;
  if (!actionVerbs.test(s)) return { ...NO_MATCH, reason: "no_action_verb" };

  if (!hasMcpTrigger && !hasApiTrigger && !hasRouteCueTrigger) return NO_MATCH;

  const taskKind: "mcp_api" | "tool_orchestration" =
    hasMcpTrigger || hasApiTrigger || hasRouteCueTrigger ? "mcp_api" : "tool_orchestration";
  const triggerLabel = hasMcpTrigger
    ? "mcp_trigger"
    : hasApiTrigger
      ? "api_trigger"
      : "route_cue_trigger";
  return { matched: true, taskKind, reason: triggerLabel };
}

export function evaluateMainAgentDelegateBeforeToolCallDecision(
  toolName: string,
  delegationFailed: boolean,
  delegationTerminal: boolean
): ToolCallDecision | undefined {
  if (delegationFailed && isMainAgentDelegateFailureBlockedToolName(toolName)) {
    return {
      action: "block",
      reason: MAIN_AGENT_DELEGATE_FAILURE_BEFORE_TOOL_CALL_REASON,
    };
  }
  if (delegationTerminal && !delegationFailed && isMainAgentReductionHiddenToolName(toolName)) {
    return {
      action: "block",
      reason: MAIN_AGENT_DELEGATE_SUCCESS_TERMINAL_BEFORE_TOOL_CALL_REASON,
    };
  }
  return undefined;
}
