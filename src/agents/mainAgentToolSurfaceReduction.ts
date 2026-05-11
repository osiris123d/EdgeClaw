/**
 * Opt-in narrowing of MainAgent's Gateway-visible tool names (`activeTools`) while keeping the full
 * merged registry for execution. MCP / Codemode / legacy execute are hidden so work routes through
 * {@link delegate_tool_task} → ToolAgent.
 */

/** Tools removed from MainAgent LLM visibility when {@link applyMainAgentReducedActiveTools} runs. */
export function isMainAgentReductionHiddenToolName(name: string): boolean {
  if (name === "codemode" || name === "execute") return true;
  if (name.startsWith("mcp_")) return true;
  if (name.startsWith("openapi_")) return true;
  return false;
}

/**
 * Tools MainAgent must not invoke after `delegate_tool_task` fails (especially MCP bootstrap),
 * including Codemode relay-shaped `tool_*_search` / `tool_*_execute` tools.
 */
export function isMainAgentDelegateFailureBlockedToolName(name: string): boolean {
  if (isMainAgentReductionHiddenToolName(name)) return true;
  if (/^tool_.*_search$/.test(name) || /^tool_.*_execute$/.test(name)) return true;
  return false;
}

/**
 * Filters an `activeTools` list (or full registry names when `activeTools` is undefined-wide).
 * Preserves scheduling, workflows, skills session bridge, workspace/orchestrator tools, and optional
 * `delegate_tool_task` / browser tools already present in `names`.
 */
export function applyMainAgentReducedActiveTools(names: readonly string[]): string[] {
  const out = names.filter((n) => !isMainAgentReductionHiddenToolName(n));
  return [...new Set(out)].sort();
}
