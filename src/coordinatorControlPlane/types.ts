import type { CodingSubagentTurnAuditEntry } from "../agents/codingLoop/codingLoopTypes";

/**
 * Control-plane models for coordinator / sub-agent operations UI.
 *
 * v1 persistence: optional Worker KV binding `COORDINATOR_CONTROL_PLANE_KV` (single-document
 * pattern under {@link CONTROL_PLANE_STATE_KEY}). Later: D1, R2 manifests, or MainAgent DO
 * tables for multi-writer / audit history — keep field names stable when migrating.
 */

/** Canonical blueprint filenames (aligned with repo layout and future \`/projects/<slug>/\` export). */
export const BLUEPRINT_FILE_KEYS = [
  "PROJECT_SPEC.md",
  "ROADMAP.md",
  "DATA_MODELS.md",
  "API_DESIGN.md",
  "AI_INSTRUCTIONS.md",
  "CONTEXT.md",
  "FILE_STRUCTURE.md",
] as const;

export type BlueprintFileKey = (typeof BLUEPRINT_FILE_KEYS)[number];

/** Per-file provenance for coordinator UX (recomputed on read/write). */
export type BlueprintDocSourceState = "missing" | "template_only" | "edited" | "validated";

/**
 * In-KV blueprint payload. `docs` keys use the same names as on-disk files for stable export/import.
 * `schemaVersion`: v2 requires FILE_STRUCTURE.md for “ready” validation; v1 matches legacy projects without it.
 */
export type ProjectBlueprintSchemaVersion = 1 | 2;

export interface ProjectBlueprint {
  schemaVersion?: ProjectBlueprintSchemaVersion;
  docs: Partial<Record<BlueprintFileKey, string>>;
  /**
   * Exact bodies produced by “Generate templates” (after placeholder substitution).
   * When `docs[k]` still matches, {@link BlueprintDocSourceState} is `template_only`.
   */
  templateFingerprints?: Partial<Record<BlueprintFileKey, string>>;
  /** Derived; do not trust client-sent values on write. */
  docState?: Partial<Record<BlueprintFileKey, BlueprintDocSourceState>>;
}

/** Derived from {@link validateProjectBlueprint} on every project write. */
export type ProjectReadiness = "draft" | "incomplete" | "ready";

/** Registry row for a logical coding workspace the coordinator may target. */
export interface CoordinatorProject {
  projectId: string;
  /** Display name (replaces legacy \`title\`). */
  projectName: string;
  /** URL segment; unique among projects; editable. */
  projectSlug: string;
  /**
   * @deprecated Use \`projectName\`. Still populated on read/write for older clients.
   */
  title?: string;
  description: string;
  /** Primary spec doc path in repo (e.g. docs/PROJECT_SPEC.md) — informational in v1. */
  specPath: string;
  /** Shared-workspace / orchestration project id (must match backend expectations when wired). */
  sharedProjectId: string;
  /** Lifecycle: archived projects are hidden from default flows; v1 does not require repo linkage. */
  status: "active" | "archived";
  /** Blueprint markdown bodies stored in control-plane KV (not the repo in v1). */
  blueprint: ProjectBlueprint;
  /** Last validation outcome; recomputed server-side on create/patch. */
  readiness: ProjectReadiness;
  /** Human-readable validation messages when \`readiness\` is \`incomplete\`. */
  validationErrors?: string[];
  /** Repo-relative or absolute path prefixes the agent may touch; empty = unset / policy TBD. */
  allowedScopeDirs: string[];
  createdAt: string;
  updatedAt: string;
}

export type CoordinatorTaskRole = "coordinator" | "coder" | "tester";

export type CoordinatorTaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "review"
  | "done";

/** How a task row entered the control plane (legacy rows omit → treat as `manual` in UI). */
export type CoordinatorTaskSource =
  | "roadmap"
  | "manual"
  | "coordinator_generated"
  | "tester_generated"
  | "mainagent_generated";

/** Allowed machine reasons for coordinator-generated follow-ups (v1 closed set). */
export type CoordinatorTaskGenerationReason =
  | "missing_dependency"
  | "verification_failure"
  | "schema_mismatch"
  | "api_contract_gap"
  | "implementation_followup"
  | "blocker_investigation";

/** Operator structured review outcome (Sub-Agents review panel). */
export type CoordinatorReviewDecision = "approved" | "needs_revision" | "blocked";

/** Why the operator chose this review outcome (audit / autonomy hints). */
export type CoordinatorReviewReasonCategory =
  | "contract_mismatch"
  | "acceptance_criteria_failure"
  | "dependency_issue"
  | "operator_preference"
  | "other";

/** Kanban-style task row scoped to a {@link CoordinatorProject}. */
export interface CoordinatorTask {
  taskId: string;
  projectId: string;
  title: string;
  description: string;
  assignedRole: CoordinatorTaskRole;
  status: CoordinatorTaskStatus;
  acceptanceCriteria: string;
  /** Provenance (product field name in spec: `source`). */
  taskSource?: CoordinatorTaskSource;
  /** Parent when this task was spawned as a follow-up. */
  parentTaskId?: string;
  /** When `taskSource` is a `*_generated` value, the policy reason (v1 closed set). */
  generationReason?: CoordinatorTaskGenerationReason;
  /** Orchestration run that created this follow-up (audit + per-run dedupe). */
  spawnedByRunId?: string;
  /** Last orchestration / debug loop id when recorded (optional). */
  lastRunId?: string;
  /** Last run lifecycle / outcome marker (e.g. `running`, `completed_success`). */
  lastRunStatus?: string;
  /** One-line verdict summary from the last finished run (optional). */
  lastRunSummary?: string;
  /** When the last run ended with a guardrail or failure policy (optional). */
  lastRunFinishedAt?: string;
  /** Short error / guardrail note from the last run (optional). */
  lastRunErrorNote?: string;
  /**
   * Operator feedback from Sub-Agents review (return-for-revision). Persisted on the task row; injected into
   * the next task-backed coding loop for coder and tester. Cleared when the task is marked done from review.
   */
  operatorRevisionNote?: string;
  /** Last structured operator review decision (optional; legacy tasks omit). */
  reviewDecision?: CoordinatorReviewDecision;
  reviewReasonCategory?: CoordinatorReviewReasonCategory;
  /** Operator audit note for the last review decision (may mirror operatorRevisionNote for needs_revision). */
  reviewDecisionNote?: string;
  /** ISO timestamp when reviewDecision was last written from the review panel. */
  reviewedAt?: string;
  /**
   * Other tasks that must reach a satisfied state before this task is runnable (v1: control-plane ids only).
   * Malformed or unknown ids are ignored at import time with warnings; selection treats missing deps as unmet.
   */
  dependsOnTaskIds?: string[];
  /** True when created or last fully merged from ROADMAP.md import (optional for legacy rows). */
  importedFromRoadmap?: boolean;
  /** Stable dedupe key for roadmap import (hash of project + anchor + normalized title). */
  sourceFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export type CoordinatorRunSource =
  | "debug_http_orchestrate"
  | "debug_rpc_orchestrate"
  | "debug_http_coordinator_chain"
  | "debug_http_delegated_ping"
  | "manual";

/** One iteration line for run history tables (subset of coding loop records). */
export interface CoordinatorRunIterationSummary {
  iteration: number;
  testerVerdict?: string;
  managerDecision?: string;
}

/** Per-iteration evidence persisted for operator review (subset of {@link CodingIterationRecord}). */
export interface CoordinatorRunTurnMetrics {
  ok: boolean;
  textLen: number;
  eventCount: number;
  error?: string;
}

export interface CoordinatorRunIterationEvidence {
  iteration: number;
  coder: CoordinatorRunTurnMetrics;
  tester: CoordinatorRunTurnMetrics;
  testerVerdict?: string;
  managerDecision?: string;
  newPendingPatchIds: string[];
  activePatchIdsForIteration: string[];
}

/** Explicit lifecycle for persisted orchestration rows (v1 task-backed runs). */
export type CoordinatorRunLifecycleStatus = "running" | "completed";

/** Recorded orchestration / debug run for the Runs panel. */
export interface CoordinatorRun {
  runId: string;
  projectId: string;
  /** When orchestration targeted a control-plane task (optional). */
  taskId?: string;
  sessionId: string;
  source: CoordinatorRunSource;
  startedAt: string;
  finishedAt?: string;
  finalStatus?: string;
  /** Loop terminal status from {@link CodingCollaborationLoopResult.status} when finished. */
  loopTerminalStatus?: string;
  /** v1 explicit row lifecycle for task-backed automation. */
  runLifecycleStatus?: CoordinatorRunLifecycleStatus;
  iterationCount?: number;
  patchIds?: string[];
  /** Short human line, e.g. "unknown→fail→pass" from verdicts when present. */
  verdictSummary?: string;
  /** True when Worker used coordinator DO path (inferred client-side from HTTP body when missing). */
  coordinatorPathUsed?: boolean;
  /** Blueprint audit fields when a control-plane project was attached. */
  blueprintContextLoaded?: boolean;
  blueprintContextAssembly?: "task_scoped" | "full_fallback" | "preformatted" | null;
  iterationSummaries?: CoordinatorRunIterationSummary[];
  /** Human-facing loop recap (from {@link CodingCollaborationLoopResult.summaryForUser}). */
  summaryForUser?: string;
  /** Rich per-iteration metrics for Sub-Agents review UI. */
  iterationEvidence?: CoordinatorRunIterationEvidence[];
  /** Bounded coder/tester turn audit from the coding loop (optional). */
  subagentTurnAudit?: CodingSubagentTurnAuditEntry[];
  /** Follow-up task ids created after this run (best-effort; appended after finalize). */
  followUpTaskIds?: string[];
  /** Snapshot when an operator applies structured review to this run (optional). */
  reviewDecision?: CoordinatorReviewDecision;
  reviewReasonCategory?: CoordinatorReviewReasonCategory;
  reviewDecisionNote?: string;
  reviewedAt?: string;
}

export interface CoordinatorControlPlaneState {
  schemaVersion: 1;
  projects: CoordinatorProject[];
  tasks: CoordinatorTask[];
  runs: CoordinatorRun[];
}

export const CONTROL_PLANE_STATE_KEY = "coord_cp_v1_state";
export const CONTROL_PLANE_LAST_CHAIN_KEY = "coord_cp_v1_last_chain";

export interface LastCoordinatorChainRecord {
  completedAtIso: string;
  session: string;
  httpStatus: number;
}
