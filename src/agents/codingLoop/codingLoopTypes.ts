import type { ProjectBlueprintContextPackage } from "../../coordinatorControlPlane/projectBlueprintOrchestrationContext";

/**
 * Manager ↔ coder ↔ tester loop — interactive orchestration (later: same logic from Workflows).
 *
 * Boundaries (see `sharedWorkspaceTypes.ts`):
 * - Think workspace = per-agent scratch only.
 * - Shared workspace gateway = collaboration surface for patches/staging (not skills/workflows DB).
 *
 * Extension points (future; not implemented here):
 * - Cloudflare Workflows for durable/resumable autonomous runs (persist loopRunId + iteration).
 * - Real ArtifactPromotionWriter + R2/Artifacts bindings (`src/promotion/`).
 * - HTTP `FlagshipEvaluationAdapter` when `FLAGSHIP_EVALUATION_URL` is set (`src/promotion/flagshipHttp.ts`).
 * - Preview/prod deploy adapters — explicit steps after evaluateReleaseGate only.
 */

export type CodingLoopTerminalStatus =
  | "completed_success"
  | "completed_failure"
  | "stopped_max_iterations"
  | "stopped_aborted"
  | "stopped_repeated_failure"
  | "stopped_no_new_patches"
  | "needs_user_approval"
  | "blocked_no_shared_workspace";

export type TesterVerdict = "pass" | "fail" | "unknown";

/** Structured classification for revision prompts (typed contract, not prompt-only). */
export type RevisionReasonCategory =
  | "tester_pass"
  | "tester_fail"
  | "tester_unknown"
  | "coverage_gap"
  | "requirements_mismatch"
  | "other";

/** Orchestrator decision recorded after each iteration (audit trail). */
export type ManagerIterationDecision =
  | "continue_revision"
  | "waiting_for_user_approval"
  | "approve_and_apply_scoped"
  | "approve_scoped_only"
  | "pass_no_scoped_pending"
  | "stop_success_applied"
  | "stop_success_approved_pending_apply"
  | "stop_failure_subagent"
  | "stop_guardrail_max_iterations"
  | "stop_guardrail_repeated_failure"
  | "stop_guardrail_no_new_patches"
  | "stop_guardrail_abort_signal";

/** Normalized outcome for one child turn (serializable). */
export interface SubAgentTurnSummary {
  ok: boolean;
  error?: string;
  textLen: number;
  eventCount: number;
}

/** Serializable structured revision context for the coder (iteration ≥ 2). */
export interface StructuredRevisionContext {
  iteration: number;
  revisionReasonCategory: RevisionReasonCategory;
  testerFeedbackExcerpt: string;
  /** Patch ids the tester was asked to focus on (verification scope). */
  verificationPatchIds: string[];
  testerVerdict: TesterVerdict;
}

export interface CodingIterationRecord {
  iteration: number;
  /** Stable ids for this iteration’s child DO instances (suffix pattern). */
  subAgentSuffix: string;
  coderSummary: SubAgentTurnSummary;
  testerSummary: SubAgentTurnSummary;
  /** Pending patch ids observed immediately after the coder turn (gateway snapshot). */
  pendingPatchIdsAfterCoder: string[];
  /** Patch ids that became pending during this coder turn (diff vs snapshot before). */
  newPendingPatchIds: string[];
  /**
   * Patch ids the tester was instructed to verify this iteration (subset of pending unless empty edge case).
   */
  activePatchIdsForIteration: string[];
  /** Ids considered stale by policy (pending too long vs threshold), if detection enabled. */
  stalePendingPatchIds?: string[];
  testerVerdict: TesterVerdict;
  /** Verdict interpreted as applying to the active patch set / verification scope. */
  testerVerdictScope: "patch_set" | "project_wide_note";
  revisionReasonCategory: RevisionReasonCategory;
  managerDecision: ManagerIterationDecision;
  /** High-level action (legacy shape); kept for UI — prefer `managerDecision`. */
  loopDecision:
    | "sent_revision_to_coder"
    | "applied_patches"
    | "waiting_for_user_approval"
    | "failed_or_aborted";
}

/** How blueprint markdown was produced for this coding-loop run (debug / audit). */
export type BlueprintContextAssemblyMode = "task_scoped" | "full_fallback" | "preformatted";

export interface CodingCollaborationLoopInput {
  sharedProjectId: string;
  /** Primary implementation ask for the coder. */
  task: string;
  /** Hard cap (clamped 1–20). Default 5. */
  maxIterations?: number;
  signal?: AbortSignal;
  /**
   * When true (default), tester prompt scopes to `newPendingPatchIds` when non-empty.
   * Set false to always ask tester to consider full pending list (re-review unrelated pendings).
   */
  scopeTesterToNewPatchesOnly?: boolean;
  /** Optional: force tester verification scope to this subset (must still be pending). */
  focusPatchIds?: string[];
  /**
   * When tester verdict is PASS: automatically approve scoped pending patches (gateway `approved`).
   * Default: true when `autoApplyVerifiedPatches` is true (apply requires approved); otherwise false.
   */
  autoApproveOnPass?: boolean;
  /**
   * When PASS: approve + apply scoped patches (still orchestrator-driven via gateway).
   * Default false — safer for interactive use.
   */
  autoApplyVerifiedPatches?: boolean;
  /**
   * When PASS and neither auto-approve nor auto-apply: exit with `needs_user_approval`.
   * Default true.
   */
  exitOnPassWithoutAutoApply?: boolean;
  /**
   * When true and PASS: approve/apply every **scoped** pending patch; when false, prefer new patches then scoped.
   * Riskier if stale pendings exist — default false.
   */
  applyAllPendingOnPass?: boolean;
  /** How to treat tester verdict `unknown`. Default "fail" (ask coder for revision). */
  unknownVerdictPolicy?: "fail" | "pass";
  /**
   * Stop when consecutive FAIL/UNKNOWN cycles yield identical normalized tester feedback. Default true.
   */
  stopOnRepeatedIdenticalFailures?: boolean;
  /**
   * Stop when the coder produces no new pending patches in an iteration (iteration ≥ 2). Default false.
   */
  stopOnNoNewPatches?: boolean;
  /**
   * Mark pending patches as stale after this many iterations since first seen (guardrail). Omit to disable.
   */
  stalePatchIterationThreshold?: number;
  /**
   * When true, coder/tester child RPC uses `rpcCollectStatelessModelTurn` (direct `generateText`, no
   * Think `saveMessages` / `getMessages`). Intended for debug orchestration isolation — default false.
   */
  statelessSubAgentModelTurn?: boolean;
  /**
   * DEBUG: when true with debug orchestration, Coder/Tester omit `shared_workspace_*` tools (message prefix protocol).
   */
  debugDisableSharedWorkspaceTools?: boolean;
  /**
   * When set (or filled by blueprint assembly), prepended to the coder’s first-turn task bundle and included in
   * every tester verification turn (stateless sub-agents need the bundle each iteration). Not executable code.
   */
  blueprintContextMarkdown?: string;
  /**
   * Control-plane operator feedback (e.g. Sub-Agents review “return for revision”). Prepended to the coder’s
   * first-turn task bundle and repeated in every tester turn so reruns honor human steering.
   */
  operatorRevisionNote?: string;
  /**
   * Structured control-plane blueprint. When {@link blueprintContextMarkdown} is unset, the coding loop
   * assembles task-scoped markdown from this package (same behavior on MainAgent and coordinator DO).
   */
  projectBlueprintPackage?: ProjectBlueprintContextPackage;
  /** Audit: control-plane registry project id when blueprint-backed. */
  controlPlaneProjectId?: string;
  /** Control-plane task id when orchestration is task-backed (AI Gateway `task` metadata). */
  controlPlaneTaskId?: string;
  /**
   * Control-plane persisted run id when known before the loop starts (AI Gateway `run` metadata).
   * If omitted, {@link CodingCollaborationLoopHost.loopRunId} is used for delegation metadata.
   */
  controlPlaneRunId?: string;
  /** Optional hook for UI streaming / Workflow checkpoints. */
  onIterationComplete?(record: CodingIterationRecord): void | Promise<void>;
}

/** Bounded audit of prompts/responses sent to coder/tester (control-plane run persistence). */
export interface CodingSubagentTurnAuditEntry {
  iteration: number;
  role: "coder" | "tester";
  promptCharCount: number;
  promptPreview: string;
  responseCharCount: number;
  responsePreview?: string;
  /** Last line containing VERDICT: when role is tester. */
  testerVerdictLine?: string;
}

export interface CodingCollaborationLoopResult {
  status: CodingLoopTerminalStatus;
  loopRunId: string;
  parentRequestId: string;
  sharedProjectId: string;
  iterations: CodingIterationRecord[];
  /** Short markdown/plain summary for chat UI. */
  summaryForUser: string;
  /** Highest iteration index reached (1-based). */
  terminalIterationIndex: number;
  /** Denormalized convenience: last iteration’s active patch ids, if any. */
  lastActivePatchIds: string[];
  /** Present when blueprint context was injected from a control-plane package or preformatted markdown. */
  blueprintContextAssembly?: BlueprintContextAssemblyMode;
  /** Truncated coder/tester prompts and responses for operator audit (optional). */
  subagentTurnAudit?: CodingSubagentTurnAuditEntry[];
}

/** Injection seam for tests + future Workflow adapter (same signature as MainAgent helpers). */
export interface CodingCollaborationLoopHost {
  readonly loopRunId: string;
  readonly parentRequestId: string;
  delegateToCoder(
    message: string,
    options: import("../delegation").DelegationOptions
  ): Promise<import("../delegation").SubAgentResult>;
  delegateToTester(
    message: string,
    options: import("../delegation").DelegationOptions
  ): Promise<import("../delegation").SubAgentResult>;
  /** Orchestrator gateway (null if SHARED_WORKSPACE_KV unbound). */
  getOrchestratorGateway(): import("../../workspace/sharedWorkspaceTypes").SharedWorkspaceGateway | null;
  log(event: string, data: Record<string, unknown>): void;
}
