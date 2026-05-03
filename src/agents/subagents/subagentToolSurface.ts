/**
 * Filters delegated sub-agent `getTools()` output (see {@link BaseSubAgentThink} / {@link MainAgent}).
 *
 * Promotion/release/deploy **tools do not exist** on the tool surface — orchestration uses `MainAgent`
 * instance methods guarded by `assertOrchestratorPromotionBoundary`. Sub-agents inherit those methods in TS
 * but cannot invoke them at runtime (`constructor !== MainAgent`).
 *
 * Think still merges **built-in shell workspace tools** (`read`, `write`, `edit`, …)
 * separately — those are not returned from `getTools()` and cannot be removed here.
 * TODO(shared-workspace-gateway): introduce a slimmer delegated base class or SDK
 * hooks to restrict Think workspace writes for TesterAgent (read-oriented policy).
 *
 * **Preemptive deny list:** `SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS` / `CODER_SUBAGENT_TOOL_DENY` include workflow/task tools **plus** snake_case names aligned with orchestrator promotion/deploy methods so sub-agents cannot gain those tools if they are ever added to `getTools()`. Regression tests: `src/agents/__tests__/subagentToolBoundary.test.ts`.
 */

import type { ToolSet } from "ai";

/** Remove denied keys from the MainAgent-composed tool surface (custom tools only). */
export function filterMainAgentToolSurface(
  full: ToolSet,
  deny: ReadonlySet<string>
): ToolSet {
  const out: ToolSet = {};
  for (const key of Object.keys(full)) {
    if (!deny.has(key)) {
      (out as Record<string, unknown>)[key] = (full as Record<string, unknown>)[key];
    }
  }
  return out;
}

/**
 * Workflow launchers + scheduled-task tools present on orchestrator `getTools()` today — must never appear on
 * sub-agent filtered surfaces.
 */
const WORKFLOW_AND_TASK_DENY_KEYS = [
  "list_workflows",
  "run_workflow",
  "schedule_task",
  "cancel_task",
] as const;

/**
 * Preemptive deny keys aligned with orchestrator-only **method** names (`MainAgent` promotion / deploy / workflow).
 * Promotion and deploy are **not** exposed as tools today; if they are added to `getTools()` later under these names,
 * sub-agents still must not receive them (see `docs/agent-orchestration-boundaries.md`).
 */
const PREEMPTIVE_ORCHESTRATION_TOOL_DENY_KEYS = [
  "prepare_approved_promotion",
  "build_promotion_artifact",
  "evaluate_release_gate",
  "execute_preview_deployment",
  "execute_production_deployment",
  "launch_preview_promotion_workflow",
  "launch_production_deploy_workflow",
] as const;

/** Explicit contract for regression tests — must stay in sync with {@link CODER_SUBAGENT_TOOL_DENY}. */
export const SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS: readonly string[] = [
  ...WORKFLOW_AND_TASK_DENY_KEYS,
  ...PREEMPTIVE_ORCHESTRATION_TOOL_DENY_KEYS,
];

/** Workflow + scheduled-task + preemptive orchestration keys — denied on CoderAgent filtered surface. */
export const CODER_SUBAGENT_TOOL_DENY = new Set<string>(SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS);

/** Stricter read/verify posture: strip project-note writes and task mutation. */
export const TESTER_SUBAGENT_TOOL_DENY = new Set<string>([
  ...CODER_SUBAGENT_TOOL_DENY,
  "save_project_note",
  "delete_project_note",
]);
