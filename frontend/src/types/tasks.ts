// ── Core domain types ─────────────────────────────────────────────────────────

export type ScheduleType = "once" | "interval" | "cron";
export type TaskStatus   = "active" | "paused" | "draft" | "error";
export type TaskType     = "reminder" | "workflow" | "follow_up" | "other";

export interface ScheduledTask {
  id: string;
  title: string;
  description?: string;
  taskType: TaskType;
  scheduleType: ScheduleType;
  /**
   * Human-readable expression whose format depends on scheduleType:
   *  - once:     ISO 8601 datetime string, e.g. "2025-06-15T09:00:00Z"
   *  - interval: "every Xm" / "every Xh" / "every Xd"
   *  - cron:     standard 5-field cron expression, e.g. "0 9 * * 1-5"
   */
  scheduleExpression: string;
  /** IANA timezone identifier, e.g. "America/Chicago". Defaults to UTC when absent. */
  timezone?: string;
  enabled: boolean;
  /** Agent instructions — what the agent should do when this task fires. */
  instructions: string;
  /** Arbitrary structured payload forwarded to the agent at run time. */
  payload?: Record<string, unknown>;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  /** Result of the most recent execution. null = never run or status unknown. */
  lastRunStatus?: "success" | "failed" | null;
  /** Error message from the most recent failed run. null when not errored. */
  lastRunError?: string | null;
}

// ── API request shapes ────────────────────────────────────────────────────────

/** Fields required to create a new scheduled task. */
export type CreateScheduledTaskInput = Omit<
  ScheduledTask,
  | "id"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "lastRunAt"
  | "nextRunAt"
  | "lastRunStatus"
  | "lastRunError"
>;

/** Partial update — any subset of the writable task fields. */
export type UpdateScheduledTaskInput = Partial<CreateScheduledTaskInput>;

export interface TasksListResponse {
  tasks: ScheduledTask[];
  total: number;
}

// ── Form state ────────────────────────────────────────────────────────────────

/**
 * Shape of the create/edit task form.
 * Mirrors the writable fields of ScheduledTask plus UI-specific helpers.
 */
export interface TaskFormState {
  title:              string;
  description:        string;
  taskType:           TaskType;
  scheduleType:       ScheduleType;
  scheduleExpression: string;
  timezone:           string;
  enabled:            boolean;
  instructions:       string;
  /** Raw text content of the JSON payload input. */
  payloadText:        string;
  /** Whether the payload JSON editor is expanded. */
  payloadExpanded:    boolean;
}

// ── Display constants ─────────────────────────────────────────────────────────

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  reminder:  "Reminder",
  workflow:  "Workflow",
  follow_up: "Follow-up",
  other:     "Other",
};

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  once:     "One-time",
  interval: "Interval",
  cron:     "Cron",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft:  "Draft",
  error:  "Error",
};

// ── UI select option arrays ───────────────────────────────────────────────────

export const TASK_TYPE_OPTIONS: ReadonlyArray<{ value: TaskType; label: string }> = [
  { value: "reminder",  label: "Reminder" },
  { value: "workflow",  label: "Workflow" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other",     label: "Other" },
];

export interface ScheduleTypeOption {
  value: ScheduleType;
  label: string;
  /** Short hint displayed below the expression input field. */
  hint: string;
  /** Placeholder text for the expression input field. */
  placeholder: string;
}

export const SCHEDULE_TYPE_OPTIONS: ReadonlyArray<ScheduleTypeOption> = [
  {
    value:       "once",
    label:       "One-time",
    hint:        "ISO 8601 datetime — e.g. 2025-06-15T09:00:00Z",
    placeholder: "2025-06-15T09:00:00Z",
  },
  {
    value:       "interval",
    label:       "Interval",
    hint:        "e.g. every 30m · every 2h · every 1d",
    placeholder: "every 1h",
  },
  {
    value:       "cron",
    label:       "Cron",
    hint:        "5-field cron — e.g. 0 9 * * 1-5 (weekdays at 09:00)",
    placeholder: "0 9 * * 1-5",
  },
];
