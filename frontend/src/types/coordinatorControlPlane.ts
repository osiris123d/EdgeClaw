/** Frontend mirror of `src/coordinatorControlPlane/types.ts` — keep fields aligned when evolving persistence. */

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

export type BlueprintDocSourceState = "missing" | "template_only" | "edited" | "validated";

export type ProjectBlueprintSchemaVersion = 1 | 2;

export interface ProjectBlueprint {
  schemaVersion?: ProjectBlueprintSchemaVersion;
  docs: Partial<Record<BlueprintFileKey, string>>;
  templateFingerprints?: Partial<Record<BlueprintFileKey, string>>;
  docState?: Partial<Record<BlueprintFileKey, BlueprintDocSourceState>>;
}

export type ProjectReadiness = "draft" | "incomplete" | "ready";

export interface CoordinatorProject {
  projectId: string;
  projectName: string;
  projectSlug: string;
  /** @deprecated Prefer projectName */
  title?: string;
  description: string;
  specPath: string;
  sharedProjectId: string;
  status: "active" | "archived";
  blueprint: ProjectBlueprint;
  readiness: ProjectReadiness;
  validationErrors?: string[];
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

export type CoordinatorTaskSource =
  | "roadmap"
  | "manual"
  | "coordinator_generated"
  | "tester_generated"
  | "mainagent_generated";

export type CoordinatorTaskGenerationReason =
  | "missing_dependency"
  | "verification_failure"
  | "schema_mismatch"
  | "api_contract_gap"
  | "implementation_followup"
  | "blocker_investigation";

export type CoordinatorReviewDecision = "approved" | "needs_revision" | "blocked";

export type CoordinatorReviewReasonCategory =
  | "contract_mismatch"
  | "acceptance_criteria_failure"
  | "dependency_issue"
  | "operator_preference"
  | "other";

export interface CoordinatorTask {
  taskId: string;
  projectId: string;
  title: string;
  description: string;
  assignedRole: CoordinatorTaskRole;
  status: CoordinatorTaskStatus;
  acceptanceCriteria: string;
  taskSource?: CoordinatorTaskSource;
  parentTaskId?: string;
  generationReason?: CoordinatorTaskGenerationReason;
  spawnedByRunId?: string;
  lastRunId?: string;
  lastRunStatus?: string;
  lastRunSummary?: string;
  lastRunFinishedAt?: string;
  lastRunErrorNote?: string;
  operatorRevisionNote?: string;
  reviewDecision?: CoordinatorReviewDecision;
  reviewReasonCategory?: CoordinatorReviewReasonCategory;
  reviewDecisionNote?: string;
  reviewedAt?: string;
  dependsOnTaskIds?: string[];
  importedFromRoadmap?: boolean;
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

export type CoordinatorRunLifecycleStatus = "running" | "completed";

export interface CoordinatorRunIterationSummary {
  iteration: number;
  testerVerdict?: string;
  managerDecision?: string;
}

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

/** Mirror of `CodingSubagentTurnAuditEntry` — keep aligned with backend coding loop. */
export interface CoordinatorSubagentTurnAuditEntry {
  iteration: number;
  role: "coder" | "tester";
  promptCharCount: number;
  promptPreview: string;
  responseCharCount: number;
  responsePreview?: string;
  testerVerdictLine?: string;
}

export interface CoordinatorRun {
  runId: string;
  projectId: string;
  taskId?: string;
  sessionId: string;
  source: CoordinatorRunSource;
  startedAt: string;
  finishedAt?: string;
  finalStatus?: string;
  loopTerminalStatus?: string;
  runLifecycleStatus?: CoordinatorRunLifecycleStatus;
  iterationCount?: number;
  patchIds?: string[];
  verdictSummary?: string;
  coordinatorPathUsed?: boolean;
  blueprintContextLoaded?: boolean;
  blueprintContextAssembly?: "task_scoped" | "full_fallback" | "preformatted" | null;
  iterationSummaries?: CoordinatorRunIterationSummary[];
  summaryForUser?: string;
  iterationEvidence?: CoordinatorRunIterationEvidence[];
  subagentTurnAudit?: CoordinatorSubagentTurnAuditEntry[];
  followUpTaskIds?: string[];
  reviewDecision?: CoordinatorReviewDecision;
  reviewReasonCategory?: CoordinatorReviewReasonCategory;
  reviewDecisionNote?: string;
  reviewedAt?: string;
}
