/**
 * frontend/src/types/workflows.ts
 *
 * Strict, provider-agnostic TypeScript types for the Workflows feature.
 * Covers both the definition layer (saved configurations) and the run layer
 * (live / completed execution instances).
 *
 * No `any` — all shapes are explicitly typed.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// UNION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle status of a workflow *definition* (the saved configuration).
 * Distinct from the status of an individual run.
 *
 *   draft    — created but not yet ready for launch
 *   active   — available for launch (enabled definitions are a subset)
 *   archived — retained for history but no longer launchable
 */
export type WorkflowDefinitionStatus = "draft" | "active" | "archived";

/**
 * How a workflow run is initiated.
 *
 *   manual    — a user or agent triggers it on demand
 *   scheduled — a cron / timer fires it automatically
 *   event     — an external event or webhook triggers it
 */
export type WorkflowTriggerMode = "manual" | "scheduled" | "event";

/**
 * Human-in-the-loop approval requirements for a workflow.
 *
 *   none        — no approval required; the run starts immediately
 *   required    — a reviewer must approve before execution begins
 *   checkpoint  — approval is required at one or more intermediate steps
 */
export type WorkflowApprovalMode = "none" | "required" | "checkpoint";

/**
 * Runtime status of a single workflow *run* (execution instance).
 * Maps to the statuses exposed by the Cloudflare Workflows API.
 */
export type WorkflowRunStatus =
  | "running"
  | "complete"
  | "errored"
  | "paused"
  | "terminated"
  | "waiting"
  | "unknown";

// ═══════════════════════════════════════════════════════════════════════════════
// CORE DOMAIN INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A saved workflow definition — a reusable configuration template.
 *
 * Definitions are stored in the agent's SQLite storage.  Each launch creates a
 * new `WorkflowRun` backed by a Cloudflare Workflow instance via the binding
 * named in `entrypoint`.
 */
export interface WorkflowDefinition {
  /** Stable UUID generated on creation. */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Optional freeform description shown in the management table. */
  description?: string;

  /**
   * Broad category for grouping / filtering definitions, e.g.
   * "data-pipeline", "report", "approval", "ai-agent".
   */
  workflowType?: string;

  /** How runs of this definition are initiated. */
  triggerMode: WorkflowTriggerMode;

  /** Human-in-the-loop approval policy for this definition. */
  approvalMode: WorkflowApprovalMode;

  /** Lifecycle state of the definition itself. */
  status: WorkflowDefinitionStatus;

  /**
   * Cloudflare Workflow binding name as declared in wrangler.jsonc, e.g.
   * `"MY_WORKFLOW"`.  The agent calls `env[entrypoint].create()` at launch
   * time.  Must match the `binding` field of a `workflows` binding entry.
   */
  entrypoint: string;

  /**
   * Free-text instructions / system prompt forwarded to the workflow at
   * launch, if the workflow implementation supports it.
   */
  instructions?: string;

  /**
   * JSON Schema (as a raw text string) describing the expected input payload.
   * Stored as text so it can be edited in a plain textarea without a schema
   * editor widget.
   */
  inputSchemaText?: string;

  /**
   * Example JSON payload stored for documentation and testing.
   * Must conform to `inputSchemaText` when both are provided.
   */
  examplePayloadText?: string;

  /** When false the definition is hidden from the launcher. */
  enabled: boolean;

  /** Arbitrary classification labels. */
  tags: string[];

  /** ISO-8601 timestamp — set by the server on creation. */
  createdAt: string;

  /** ISO-8601 timestamp — updated on any save. */
  updatedAt: string;

  /** ISO-8601 timestamp of the most recently started run, if any. */
  lastRunAt?: string | null;

  /** Total number of runs ever launched from this definition. */
  runCount: number;

  /**
   * Status of the most recently launched run.
   * Denormalized here so the definitions list can show a quick failure hint
   * without loading all runs.
   */
  latestRunStatus?: WorkflowRunStatus | null;

  /** ISO-8601 timestamp of the most recently failed run, if any. */
  lastFailureAt?: string | null;
}

/**
 * A single execution instance spawned from a `WorkflowDefinition`.
 * Maps 1:1 to a Cloudflare Workflow instance.
 */
export interface WorkflowRun {
  /** Cloudflare Workflow instance ID (UUID). */
  id: string;

  /** ID of the definition that launched this run. */
  workflowDefinitionId: string;

  /** Display name of the definition at launch time (denormalized). */
  workflowName: string;

  /** Current execution status. */
  status: WorkflowRunStatus;

  /**
   * Optional 0–100 completion percentage.
   * Populated only when the workflow implementation emits progress events.
   */
  progressPercent?: number | null;

  /** Human-readable name of the step currently executing, if known. */
  currentStep?: string | null;

  /** ISO-8601 timestamp — set when the run transitions to "running". */
  startedAt: string;

  /**
   * ISO-8601 timestamp — updated whenever run state changes.
   * Useful for polling: skip re-rendering if updatedAt hasn't changed.
   */
  updatedAt: string;

  /** ISO-8601 timestamp — set when the run reaches a terminal state. */
  completedAt?: string | null;

  /**
   * True when the run is paused and waiting for a human to approve or
   * reject before continuing.
   */
  waitingForApproval?: boolean;

  /**
   * Short human-readable summary of the run result, e.g.
   * "Processed 1,240 rows — 3 errors."
   */
  resultSummary?: string | null;

  /** Error message when `status === "errored"`. */
  errorMessage?: string | null;

  /** Structured input payload forwarded to the workflow on launch. */
  input?: Record<string, unknown>;

  /** Structured output returned by the workflow on completion. */
  output?: Record<string, unknown>;

  /**
   * Ordered list of step-level execution states.
   * Populated by the Workflows API when step-level telemetry is available.
   * An empty array or undefined means no step data has been received yet.
   */
  steps?: WorkflowStepState[];

  // ── Approval audit ──────────────────────────────────────────────────────────

  /** "approved" | "rejected" once a reviewer acts; absent before any decision. */
  approvalAction?: "approved" | "rejected" | null;

  /** Optional free-text comment left by the reviewer. */
  approvalComment?: string | null;

  /** Identifier (name or email) of the reviewer who approved or rejected. */
  approvedBy?: string | null;

  /** ISO-8601 timestamp of the approval or rejection decision. */
  approvalActionAt?: string | null;

  // ── Structured error detail ─────────────────────────────────────────────────

  /** Machine-readable error code for programmatic handling. */
  errorCode?: string | null;

  /** Structured error payload (stack trace, context fields) when available. */
  errorDetails?: Record<string, unknown> | null;
}

/**
 * Represents the state of one step in the runtime execution timeline.
 * Returned as part of detailed run inspection (future: step-level polling).
 */
export interface WorkflowStepState {
  /** Identifier matching the step name declared in the workflow code. */
  stepName: string;

  /** Step-level execution status. */
  status: "pending" | "running" | "complete" | "errored" | "skipped";

  /** ISO-8601 timestamp — when this step began executing. */
  startedAt?: string | null;

  /** ISO-8601 timestamp — when this step finished. */
  completedAt?: string | null;

  /** Wall-clock duration in milliseconds, if known. */
  durationMs?: number | null;

  /** Step-level error message, present when status is "errored". */
  errorMessage?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API INPUT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shape of the request body when creating a new workflow definition.
 * Server-generated fields (id, timestamps, runCount) are excluded.
 */
export type CreateWorkflowDefinitionInput = Omit<
  WorkflowDefinition,
  "id" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount"
>;

/**
 * Shape of the request body when partially updating an existing definition.
 * All fields are optional; only provided fields are changed.
 */
export type UpdateWorkflowDefinitionInput = Partial<CreateWorkflowDefinitionInput>;

/**
 * Input passed to the workflow instance at launch time.
 * Forwarded verbatim to the Cloudflare Workflow's `create()` call.
 */
export interface LaunchWorkflowInput {
  /** Optional structured payload; must satisfy the definition's inputSchema if present. */
  input?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI STATE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Form state used by the create / edit drawer in the Definitions tab.
 * Differs from `WorkflowDefinition` where the UI needs plain strings:
 *   - `tagsText`        — comma-separated tag list (split on save)
 *   - `inputSchemaText` — raw JSON Schema text (validated on save)
 */
export interface WorkflowDefinitionFormState {
  name:               string;
  description:        string;
  workflowType:       string;
  triggerMode:        WorkflowTriggerMode;
  approvalMode:       WorkflowApprovalMode;
  status:             WorkflowDefinitionStatus;
  entrypoint:         string;
  instructions:       string;
  inputSchemaText:    string;
  examplePayloadText: string;
  enabled:            boolean;
  tagsText:           string;
}

/**
 * Filter / sort state for the Runs tab list.
 * Intended to be kept as a single `useState` object in the page component.
 */
export interface WorkflowRunFilterState {
  search: string;
  status: "all" | WorkflowRunStatus;
  sort:   "startedAt" | "completedAt" | "status";
}

// ═══════════════════════════════════════════════════════════════════════════════
// API RESPONSE ENVELOPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorkflowDefinitionsListResponse {
  definitions: WorkflowDefinition[];
  total: number;
}

export interface WorkflowRunsListResponse {
  runs: WorkflowRun[];
  total: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPLAY CONSTANTS — labels and option arrays for select controls
// ═══════════════════════════════════════════════════════════════════════════════

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running:    "Running",
  complete:   "Complete",
  errored:    "Errored",
  paused:     "Paused",
  terminated: "Terminated",
  waiting:    "Waiting",
  unknown:    "Unknown",
};

export const RUN_STATUS_OPTIONS: ReadonlyArray<{
  value: "all" | WorkflowRunStatus;
  label: string;
}> = [
  { value: "all",        label: "All statuses" },
  { value: "running",    label: "Running" },
  { value: "complete",   label: "Complete" },
  { value: "errored",    label: "Errored" },
  { value: "paused",     label: "Paused" },
  { value: "terminated", label: "Terminated" },
  { value: "waiting",    label: "Waiting" },
];

export const DEFINITION_STATUS_OPTIONS: ReadonlyArray<{
  value: WorkflowDefinitionStatus;
  label: string;
}> = [
  { value: "draft",    label: "Draft"    },
  { value: "active",   label: "Active"   },
  { value: "archived", label: "Archived" },
];

export const TRIGGER_MODE_OPTIONS: ReadonlyArray<{
  value: WorkflowTriggerMode;
  label: string;
  hint:  string;
}> = [
  { value: "manual",    label: "Manual",    hint: "Launched on demand by a user or agent" },
  { value: "scheduled", label: "Scheduled", hint: "Fired automatically on a timer or cron" },
  { value: "event",     label: "Event",     hint: "Triggered by an external event or webhook" },
];

export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{
  value: WorkflowApprovalMode;
  label: string;
  hint:  string;
}> = [
  { value: "none",       label: "None",        hint: "No approval required — runs immediately" },
  { value: "required",   label: "Required",    hint: "A reviewer must approve before execution begins" },
  { value: "checkpoint", label: "Checkpoint",  hint: "Approval required at one or more steps" },
];

export const WORKFLOW_TYPE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "",              label: "Uncategorized"  },
  { value: "ai-agent",      label: "AI Agent"       },
  { value: "data-pipeline", label: "Data Pipeline"  },
  { value: "report",        label: "Report"         },
  { value: "approval",      label: "Approval"       },
  { value: "notification",  label: "Notification"   },
  { value: "maintenance",   label: "Maintenance"    },
  { value: "custom",        label: "Custom"         },
];
