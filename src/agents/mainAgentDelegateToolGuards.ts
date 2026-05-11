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
