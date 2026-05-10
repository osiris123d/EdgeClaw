import type { ToolSet } from "ai";
import { estimateActiveToolSurfaceTokens } from "./toolSurfaceTelemetry";

/**
 * How a tool landed in the Gateway-bound tool roster (semantic label for logs only).
 *
 * Think merges `workspace + getTools + extensions + session + MCP + callerTools`,
 * then patch-merges `TurnConfig.tools` (our `codemode` sandbox shell).
 *
 * Names are categorized as either the Codemode relay shell or ordinary registered tools.
 */
export type AiGatewayToolBinding = "codemode_relay_shell" | "registered";

export function classifyGatewayToolBinding(name: string): AiGatewayToolBinding {
  return name === "codemode" ? "codemode_relay_shell" : "registered";
}

export interface AiGatewayToolsAuditSnapshot {
  /** Names in the provider request after `activeTools` filtering (`streamText`). */
  activeToolsOrdered: string[];
  /** Approximate aggregate schema-token estimate for visible tools only. */
  approxSchemaTokens: number;
  /** Ordered binding labels keyed by visible tool names. */
  bindings: Record<string, AiGatewayToolBinding>;
}

/** Build a deterministic audit blob for `[EdgeClaw][gateway-tools-debug]` logging (names + bindings). */
export function buildAiGatewayToolsAuditSnapshot(
  augmentedTools: ToolSet,
  activeToolsOrdered: readonly string[]
): AiGatewayToolsAuditSnapshot {
  const ordered = [...activeToolsOrdered];
  const approxSchemaTokens = estimateActiveToolSurfaceTokens(
    augmentedTools,
    ordered
  );
  const bindings = Object.fromEntries(
    ordered.map((n) => [n, classifyGatewayToolBinding(n)])
  );
  return { activeToolsOrdered: ordered, approxSchemaTokens, bindings };
}

/**
 * Simulate AI SDK filtering of `prepareToolsAndToolChoice` visibility.
 * Mirrors `activeTools != null ? filter : expose all`.
 */
export function simulateProviderVisibleToolKeys(
  allToolKeys: readonly string[],
  activeTools?: readonly string[] | null
): string[] {
  // AI SDK: `activeTools === undefined | null` → every tool stays visible.
  // Explicit `[]` hides all tool schemas from the Gateway request body.
  if (activeTools === undefined || activeTools === null) return [...allToolKeys];
  const set = new Set(allToolKeys);
  return [...activeTools].filter((name) => set.has(name));
}

/**
 * If {@link simulateProviderVisibleToolKeys} hides a tool, it can still execute when the
 * definition exists in Think's merged host `ToolSet` (MCP, workspace, session, …).
 */
export function assertToolRunnableInRegistry(tools: ToolSet, toolName: string): void {
  const t = tools[toolName];
  if (!t || typeof t !== "object") {
    throw new Error(`Expected registry tool "${toolName}" to exist`);
  }
  const exec = (t as { execute?: unknown }).execute;
  if (typeof exec !== "function") {
    throw new Error(`Expected registry tool "${toolName}" to expose execute()`);
  }
}

/**
 * Detect `prepareStep` / `beforeStep` attempts to **widen** Gateway visibility beyond
 * MainAgent's frozen `activeTools` (e.g. Think pipeline extensions merging after `beforeTurn`).
 */
export function diagnosePrepareStepWidenAgainstFreeze(
  frozen: readonly string[] | null,
  parentPrepareStepResult: Partial<{ activeTools?: string[] }> | undefined | null
): string | undefined {
  if (frozen === null || frozen.length === 0) return undefined;
  const proposed = parentPrepareStepResult?.activeTools;
  if (!Array.isArray(proposed) || proposed.length === 0) return undefined;

  const allowed = new Set(frozen);
  const extras = proposed.filter((n) => !allowed.has(n));
  if (extras.length === 0) return undefined;

  return (
    `[EdgeClaw][gateway-tools-clamp] Ignoring prepareStep widen beyond MainAgent.freeze ` +
    `(likely pipeline extension or superclass beforeStep). extras=${[...extras].sort().join(",")} ` +
    `remediation=re_applied_frozen_activeTools`
  );
}

/**
 * Mirror `MainAgent.beforeStep` merge semantics for tests.
 */
export function mergePrepareStepWithFrozenActiveTools(
  frozen: readonly string[] | null,
  parentPrepareStepResult: Partial<{ activeTools?: string[] }> | undefined | null
): Partial<{ activeTools?: string[] }> | undefined {
  if (frozen === null) {
    if (!parentPrepareStepResult || Object.keys(parentPrepareStepResult).length === 0) {
      return undefined;
    }
    return { ...parentPrepareStepResult };
  }
  return {
    ...(parentPrepareStepResult ?? {}),
    activeTools: [...frozen],
  };
}
