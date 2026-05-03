/**
 * workflowPersistence.ts
 *
 * Backend persistence types and helpers for the Workflows feature.
 *
 * Separation of concerns (mirrors taskPersistence.ts):
 *   PersistedWorkflowDefinition — full in-memory shape including SQL-only fields.
 *   PersistedWorkflowRun        — full in-memory shape for a single execution.
 *   WorkflowDefinitionApiResponse / WorkflowRunApiResponse — wire shapes served
 *     to the frontend.  Must stay in sync with frontend/src/types/workflows.ts.
 *
 * SQL storage uses two tables in the MainAgent Durable Object SQLite store:
 *   wf_definitions — one row per saved workflow configuration.
 *   wf_runs        — one row per execution instance.
 *
 * JSON columns (tags, input, output) are stored as TEXT and round-tripped via
 * JSON.parse / JSON.stringify.  Boolean columns are stored as INTEGER (0/1).
 *
 * No frontend imports are allowed from this file (different runtime boundary).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// UNION TYPES  (keep in sync with frontend/src/types/workflows.ts)
// ═══════════════════════════════════════════════════════════════════════════════

export type WorkflowRunStatus =
  | "running"
  | "complete"
  | "errored"
  | "paused"
  | "terminated"
  | "waiting"
  | "unknown";

export type WorkflowDefinitionStatus = "draft" | "active" | "archived";
export type WorkflowTriggerMode      = "manual" | "scheduled" | "event";
export type WorkflowApprovalMode     = "none" | "required" | "checkpoint";

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE SHAPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory representation of a workflow definition row from wf_definitions.
 * All camelCase; boolean columns are proper booleans (not 0/1 integers).
 */
export interface PersistedWorkflowDefinition {
  id:                 string;
  name:               string;
  description?:       string;
  workflowType?:      string;
  triggerMode:        WorkflowTriggerMode;
  approvalMode:       WorkflowApprovalMode;
  status:             WorkflowDefinitionStatus;
  entrypoint:         string;
  instructions?:      string;
  inputSchemaText?:   string;
  examplePayloadText?: string;
  enabled:            boolean;
  tags:               string[];
  createdAt:          string;
  updatedAt:          string;
  lastRunAt?:         string | null;
  runCount:           number;
}

/**
 * In-memory representation of a workflow run row from wf_runs.
 */
export interface PersistedWorkflowRun {
  id:                   string;
  workflowDefinitionId: string;
  workflowName:         string;
  status:               WorkflowRunStatus;
  progressPercent?:     number | null;
  currentStep?:         string | null;
  startedAt:            string;
  updatedAt:            string;
  completedAt?:         string | null;
  waitingForApproval:   boolean;
  resultSummary?:       string | null;
  errorMessage?:        string | null;
  input?:               Record<string, unknown>;
  output?:              Record<string, unknown>;

  // ── Approval audit ──────────────────────────────────────────────────────────
  approvalAction?:   "approved" | "rejected" | null;
  approvalComment?:  string | null;
  approvedBy?:       string | null;
  approvalActionAt?: string | null;

  // ── Structured error detail ─────────────────────────────────────────────────
  errorCode?:    string | null;
  errorDetails?: Record<string, unknown> | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL ROW SHAPES
// snake_case to match the SQLite column names produced by CREATE TABLE.
// These are the exact shapes returned by this.sql.exec<T>(...).toArray().
// ═══════════════════════════════════════════════════════════════════════════════

export interface WfDefRow {
  id:               string;
  name:             string;
  description:      string | null;
  workflow_type:    string | null;
  trigger_mode:     string;
  approval_mode:    string;
  status:           string;
  entrypoint:       string;
  instructions:     string | null;
  input_schema:     string | null;
  example_payload:  string | null;
  enabled:          number; // 0 | 1
  tags:             string; // JSON array
  created_at:       string;
  updated_at:       string;
  last_run_at:      string | null;
  run_count:        number;
}

export interface WfRunRow {
  id:                     string;
  workflow_definition_id: string;
  workflow_name:          string;
  status:                 string;
  progress_percent:       number | null;
  current_step:           string | null;
  started_at:             string;
  updated_at:             string;
  completed_at:           string | null;
  waiting_for_approval:   number; // 0 | 1
  result_summary:         string | null;
  error_message:          string | null;
  input:                  string | null; // JSON
  output:                 string | null; // JSON
  // Approval audit (nullable — absent in older rows before schema migration)
  approval_action:        string | null;
  approval_comment:       string | null;
  approved_by:            string | null;
  approval_action_at:     string | null;
  // Structured error detail
  error_code:             string | null;
  error_details:          string | null; // JSON
  // Pending chat notification (cleared by beforeTurn once delivered)
  pending_notification:   string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL SCHEMA (reference)
//
// The DDL is inlined as tagged template literals inside MainAgent.wfEnsureTables()
// because this.sql uses the tagged-template API, not a string exec() method.
//
// wf_definitions columns:
//   id, name, description, workflow_type, trigger_mode, approval_mode, status,
//   entrypoint, instructions, input_schema, example_payload, enabled (0|1),
//   tags (JSON), created_at, updated_at, last_run_at, run_count
//
// wf_runs columns:
//   id, workflow_definition_id, workflow_name, status, progress_percent,
//   current_step, started_at, updated_at, completed_at,
//   waiting_for_approval (0|1), result_summary, error_message,
//   input (JSON), output (JSON),
//   approval_action, approval_comment, approved_by, approval_action_at,
//   error_code, error_details (JSON)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// WIRE SHAPES  (returned to the frontend — omit any backend-only fields)
// ═══════════════════════════════════════════════════════════════════════════════

/** Shape of /api/workflows response items.  Must match frontend WorkflowDefinition. */
export type WorkflowDefinitionApiResponse = PersistedWorkflowDefinition;

/** Shape of /api/workflows/runs response items.  Must match frontend WorkflowRun. */
export type WorkflowRunApiResponse = PersistedWorkflowRun;

export interface WorkflowDefinitionsListResponse {
  definitions: WorkflowDefinitionApiResponse[];
  total:       number;
}

export interface WorkflowRunsListResponse {
  runs:  WorkflowRunApiResponse[];
  total: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT TYPES  (from the frontend request bodies)
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /api/workflows body */
export interface CreateWorkflowDefinitionInput {
  name:               string;
  description?:       string;
  workflowType?:      string;
  triggerMode?:       WorkflowTriggerMode;
  approvalMode?:      WorkflowApprovalMode;
  status?:            WorkflowDefinitionStatus;
  entrypoint:         string;
  instructions?:      string;
  inputSchemaText?:   string;
  examplePayloadText?: string;
  enabled?:           boolean;
  tags?:              string[];
}

/** PATCH /api/workflows/:id body — all fields optional */
export type UpdateWorkflowDefinitionInput = Partial<CreateWorkflowDefinitionInput>;

// ═══════════════════════════════════════════════════════════════════════════════
// ROW → PERSISTED OBJECT CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert a raw SQL row into a typed PersistedWorkflowDefinition. */
export function rowToDefinition(row: WfDefRow): PersistedWorkflowDefinition {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags) as string[]; } catch { /* default [] */ }

  return {
    id:                 row.id,
    name:               row.name,
    description:        row.description ?? undefined,
    workflowType:       row.workflow_type ?? undefined,
    triggerMode:        isTriggerMode(row.trigger_mode)  ? row.trigger_mode  : "manual",
    approvalMode:       isApprovalMode(row.approval_mode) ? row.approval_mode : "none",
    status:             isDefStatus(row.status) ? row.status : "active",
    entrypoint:         row.entrypoint,
    instructions:       row.instructions ?? undefined,
    inputSchemaText:    row.input_schema ?? undefined,
    examplePayloadText: row.example_payload ?? undefined,
    enabled:            row.enabled !== 0,
    tags,
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
    lastRunAt:          row.last_run_at,
    runCount:           row.run_count,
  };
}

/** Convert a raw SQL row into a typed PersistedWorkflowRun. */
export function rowToRun(row: WfRunRow): PersistedWorkflowRun {
  let input:        Record<string, unknown> | undefined;
  let output:       Record<string, unknown> | undefined;
  let errorDetails: Record<string, unknown> | null = null;

  try { if (row.input)        input        = JSON.parse(row.input)        as Record<string, unknown>; } catch { /* skip */ }
  try { if (row.output)       output       = JSON.parse(row.output)       as Record<string, unknown>; } catch { /* skip */ }
  try { if (row.error_details) errorDetails = JSON.parse(row.error_details) as Record<string, unknown>; } catch { /* skip */ }

  const approvalAction = row.approval_action === "approved" || row.approval_action === "rejected"
    ? row.approval_action
    : null;

  return {
    id:                   row.id,
    workflowDefinitionId: row.workflow_definition_id,
    workflowName:         row.workflow_name,
    status:               isRunStatus(row.status) ? row.status : "unknown",
    progressPercent:      row.progress_percent,
    currentStep:          row.current_step,
    startedAt:            row.started_at,
    updatedAt:            row.updated_at,
    completedAt:          row.completed_at,
    waitingForApproval:   row.waiting_for_approval !== 0,
    resultSummary:        row.result_summary,
    errorMessage:         row.error_message,
    input,
    output,
    approvalAction,
    approvalComment:      row.approval_comment  ?? null,
    approvedBy:           row.approved_by       ?? null,
    approvalActionAt:     row.approval_action_at ?? null,
    errorCode:            row.error_code        ?? null,
    errorDetails,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

export function isRunStatus(v: unknown): v is WorkflowRunStatus {
  return (
    v === "running"    ||
    v === "complete"   ||
    v === "errored"    ||
    v === "paused"     ||
    v === "terminated" ||
    v === "waiting"    ||
    v === "unknown"
  );
}

export function isTriggerMode(v: unknown): v is WorkflowTriggerMode {
  return v === "manual" || v === "scheduled" || v === "event";
}

export function isApprovalMode(v: unknown): v is WorkflowApprovalMode {
  return v === "none" || v === "required" || v === "checkpoint";
}

export function isDefStatus(v: unknown): v is WorkflowDefinitionStatus {
  return v === "draft" || v === "active" || v === "archived";
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Returns true for statuses that might still have a live CF Workflow instance. */
export function isActiveRunStatus(status: WorkflowRunStatus): boolean {
  return status === "running" || status === "waiting" || status === "paused";
}

/** Returns true for terminal statuses that will never change. */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return status === "complete" || status === "errored" || status === "terminated";
}
