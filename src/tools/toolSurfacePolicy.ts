import type { ToolSet } from "ai";

/** Session / Skills tools — UX expectations and Think contracts keep these top-level. */
const SESSION_AGENT_CONTEXT_TOOLS = new Set([
  "set_context",
  "load_context",
  "unload_context",
  "search_context",
  "session_search",
]);

/** Workspace mutation primitives from Think workspace tools. */
const WORKSPACE_DESTRUCTIVE = new Set(["write", "edit", "delete"]);

/** Scheduling / destructive automation — always top-level per product policy. */
const SCHEDULING_TOOLS = new Set(["schedule_task", "list_tasks", "cancel_task"]);

const WORKFLOW_LAUNCH = new Set(["run_workflow"]);

const BROWSER_HITL_TOOLS = new Set(["browser_session"]);

/** Shared workspace tools that mutate external collaboration state / lifecycle. */
const SHARED_WORKSPACE_MUTATORS = new Set([
  "shared_workspace_write",
  "shared_workspace_write_staging",
  "shared_workspace_put_patch",
  "shared_workspace_approve_patch",
  "shared_workspace_reject_patch",
  "shared_workspace_apply_patch",
  "shared_workspace_register_project",
]);

const META_DEDUP = new Set(["codemode", "execute"]);

function toolDeclaresApproval(tool: ToolSet[string] | undefined): boolean {
  if (!tool || typeof tool !== "object") return false;
  const t = tool as { needsApproval?: unknown };
  if (t.needsApproval === true) return true;
  return typeof t.needsApproval === "function";
}

/** @internal Exported for tests */
export interface ToolClassification {
  direct: Set<string>;
  wrapped: Set<string>;
  excluded: Set<string>;
}

/**
 * Decide how each merged tool participates in AI Gateway requests.
 *
 * - **direct**: full JSON Schema is advertised to the model (approval, HITL, mutations, bootstrap context tools).
 * - **codemode_wrap**: routed only through sandbox `codemode.tools_*` helpers (schemas hidden from Gateway).
 * - **exclude**: never wrapped and never surfaced (relay recursion / superseded registrations).
 *
 * Classification is intentionally generic — no vendor- or domain-specific literals beyond stable tool prefixes.
 */
export function classifyMergedToolsForSurface(tools: ToolSet): ToolClassification {
  const direct = new Set<string>();
  const wrapped = new Set<string>();
  const excluded = new Set<string>();

  for (const name of Object.keys(tools)) {
    if (META_DEDUP.has(name)) {
      excluded.add(name);
      continue;
    }

    const def = tools[name];

    if (SESSION_AGENT_CONTEXT_TOOLS.has(name)) {
      direct.add(name);
      continue;
    }

    if (WORKFLOW_LAUNCH.has(name) || SCHEDULING_TOOLS.has(name) || BROWSER_HITL_TOOLS.has(name)) {
      direct.add(name);
      continue;
    }

    if (WORKSPACE_DESTRUCTIVE.has(name) || SHARED_WORKSPACE_MUTATORS.has(name)) {
      direct.add(name);
      continue;
    }

    if (toolDeclaresApproval(def)) {
      direct.add(name);
      continue;
    }

    wrapped.add(name);
  }

  return { direct, wrapped, excluded };
}

export function pickToolsByName(tools: ToolSet, names: Iterable<string>): ToolSet {
  const out: ToolSet = {};
  for (const n of names) {
    const t = tools[n];
    if (t) out[n] = t;
  }
  return out;
}

export type ToolSurfaceSelectionReason =
  | "codemode-surface-disabled"
  | "no-loader-binding"
  | "code-execution-disabled"
  | "continuation-no-change"
  | "browser-grounding-active-tools-only"
  | "tool-choice-none"
  | "codemode-surface-applied-default"
  | "no-wrapped-tools";

export interface ToolSurfaceBuildInput {
  mergedTools: ToolSet;
  /** When false, callers skip attaching `codemode` and widening activeTools (legacy wide surface). */
  codemodeSurfaceEnabled: boolean;
  /** Sandbox requires WorkerLoader. */
  hasLoaderBinding: boolean;
  /** Relay Codemode is built on `@cloudflare/think`'s sandboxed runner — gated like legacy `execute`. */
  codeExecutionEnabled: boolean;
}

/** Plan for narrowing AI Gateway-visible tools (`activeTools`). */
export interface ToolSurfacePlan {
  wrappedNames: string[];
  /** Always exposed top-level alongside `codemode` while compression is enabled. */
  directNames: string[];
  reason: ToolSurfaceSelectionReason;
}

/** Default: advertise `codemode` plus direct-policy tools only (requires caller to attach `codemode` Tool). */
export function planMinimalToolSurface(input: ToolSurfaceBuildInput): ToolSurfacePlan {
  const { mergedTools, codemodeSurfaceEnabled, hasLoaderBinding, codeExecutionEnabled } =
    input;

  if (!codemodeSurfaceEnabled) {
    const { direct } = classifyMergedToolsForSurface(mergedTools);
    return {
      wrappedNames: [],
      directNames: [...direct].sort(),
      reason: "codemode-surface-disabled",
    };
  }

  if (!hasLoaderBinding) {
    const { direct } = classifyMergedToolsForSurface(mergedTools);
    return {
      wrappedNames: [],
      directNames: [...direct].sort(),
      reason: "no-loader-binding",
    };
  }

  if (!codeExecutionEnabled) {
    const { direct } = classifyMergedToolsForSurface(mergedTools);
    return {
      wrappedNames: [],
      directNames: [...direct].sort(),
      reason: "code-execution-disabled",
    };
  }

  const { direct, wrapped } = classifyMergedToolsForSurface(mergedTools);

  if (wrapped.size === 0) {
    return {
      wrappedNames: [],
      directNames: [...direct].sort(),
      reason: "no-wrapped-tools",
    };
  }

  return {
    wrappedNames: [...wrapped].sort(),
    directNames: [...direct].sort(),
    reason: "codemode-surface-applied-default",
  };
}
