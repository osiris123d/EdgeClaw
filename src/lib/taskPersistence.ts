/**
 * taskPersistence.ts
 *
 * Backend task storage model.
 *
 * "Tasks" are persisted in the MainAgent Durable Object config blob under the
 * key "tasks".  This is the same mechanism used to persist MCP server config
 * (see mcpDiscovery.ts / MainAgent.configure()).
 *
 * Separation of concerns:
 *   PersistedTask   — the shape written to and read from DO storage.
 *                     Includes the Cloudflare Agents schedule ID so the
 *                     runtime schedule can be found and cancelled on update/delete.
 *   TaskApiResponse — the wire shape returned to the frontend.
 *                     Matches the frontend ScheduledTask type in
 *                     frontend/src/types/tasks.ts (keep in sync manually).
 *
 * No frontend imports are allowed from this file (different runtime boundary).
 */

// ── Shared union types (must stay in sync with frontend/src/types/tasks.ts) ──

export type ScheduleType = "once" | "interval" | "cron";
export type TaskStatus = "active" | "paused" | "draft" | "error";
export type TaskType = "reminder" | "workflow" | "follow_up" | "other";

// ── Storage shape ─────────────────────────────────────────────────────────────

/**
 * The persisted representation of a task, stored in the DO config blob.
 *
 * `scheduleId` is the ID returned by the Cloudflare Agents `this.schedule()`
 * call.  It is null/undefined when the task is paused or not yet scheduled.
 *
 * ASSUMPTION: The CF Agents runtime does not persist schedule IDs between
 * DO restarts; they are maintained in the Agent's internal SQLite store.
 * `scheduleId` here is therefore a soft reference — if the DO is cold-started
 * the schedule may already be gone, so task creation should always check
 * whether the existing scheduleId is still live before trusting it.
 */
export interface PersistedTask {
  id: string;
  title: string;
  description?: string;
  taskType: TaskType;
  scheduleType: ScheduleType;
  scheduleExpression: string;
  timezone?: string;
  enabled: boolean;
  status: TaskStatus;
  instructions: string;
  payload?: Record<string, unknown>;
  /** CF Agents schedule handle ID (from this.schedule()). null when paused. */
  scheduleId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  /** Best-effort next run time, updated on schedule creation/update. */
  nextRunAt?: string | null;
  /** Result of the most recent execution. null = never run. */
  lastRunStatus?: "success" | "failed" | null;
  /** Error message captured from the most recent failed run. */
  lastRunError?: string | null;
}

// ── Wire shape returned to the frontend ───────────────────────────────────────

/**
 * The HTTP response shape served by /api/tasks endpoints.
 * Must match frontend/src/types/tasks.ts > ScheduledTask.
 *
 * scheduleId is intentionally omitted — it is an internal implementation
 * detail that the frontend does not need to know about.
 */
export interface TaskApiResponse {
  id: string;
  title: string;
  description?: string;
  taskType: TaskType;
  scheduleType: ScheduleType;
  scheduleExpression: string;
  timezone?: string;
  enabled: boolean;
  status: TaskStatus;
  instructions: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastRunStatus?: "success" | "failed" | null;
  lastRunError?: string | null;
}

// ── Input shapes (from the frontend) ─────────────────────────────────────────

/** POST /api/tasks — create a new task. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  taskType?: TaskType;
  scheduleType: ScheduleType;
  scheduleExpression: string;
  timezone?: string;
  enabled?: boolean;
  instructions: string;
  payload?: Record<string, unknown>;
}

/** PATCH /api/tasks/:id — partial update. */
export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "title">> & {
  title?: string;
  enabled?: boolean;
};

/** POST /api/tasks/:id/toggle */
export interface ToggleTaskInput {
  enabled: boolean;
}

// ── List response ─────────────────────────────────────────────────────────────

export interface TasksListResponse {
  tasks: TaskApiResponse[];
  total: number;
}

// ── Serialization helpers ─────────────────────────────────────────────────────

/**
 * Strip internal fields and convert PersistedTask to the frontend wire shape.
 * Does NOT recompute nextRunAt — callers must set it before calling serialize.
 */
export function serializeTask(t: PersistedTask): TaskApiResponse {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    taskType: t.taskType,
    scheduleType: t.scheduleType,
    scheduleExpression: t.scheduleExpression,
    timezone: t.timezone,
    enabled: t.enabled,
    status: t.status,
    instructions: t.instructions,
    payload: t.payload,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastRunAt: t.lastRunAt ?? null,
    nextRunAt: t.nextRunAt ?? null,
    lastRunStatus: t.lastRunStatus ?? null,
    lastRunError: t.lastRunError ?? null,
  };
}

/**
 * Validate and coerce an unknown value from DO config storage into a
 * PersistedTask.  Unknown/missing fields get safe defaults.
 */
export function normalizeStoredTask(raw: unknown): PersistedTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;

  const id = typeof t.id === "string" && t.id ? t.id : null;
  const title = typeof t.title === "string" && t.title ? t.title : null;
  if (!id || !title) return null;

  return {
    id,
    title,
    description: typeof t.description === "string" ? t.description : undefined,
    taskType: isTaskType(t.taskType) ? t.taskType : "other",
    scheduleType: isScheduleType(t.scheduleType) ? t.scheduleType : "once",
    scheduleExpression: typeof t.scheduleExpression === "string" ? t.scheduleExpression : "",
    timezone: typeof t.timezone === "string" ? t.timezone : undefined,
    enabled: typeof t.enabled === "boolean" ? t.enabled : false,
    status: isTaskStatus(t.status) ? t.status : "draft",
    instructions: typeof t.instructions === "string" ? t.instructions : "",
    payload: isPlainObject(t.payload) ? (t.payload as Record<string, unknown>) : undefined,
    scheduleId: typeof t.scheduleId === "string" ? t.scheduleId : null,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString(),
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : new Date().toISOString(),
    lastRunAt: typeof t.lastRunAt === "string" ? t.lastRunAt : null,
    nextRunAt: typeof t.nextRunAt === "string" ? t.nextRunAt : null,
    lastRunStatus:
      t.lastRunStatus === "success" || t.lastRunStatus === "failed"
        ? t.lastRunStatus
        : null,
    lastRunError: typeof t.lastRunError === "string" ? t.lastRunError : null,
  };
}

/** Read and validate the tasks array from a raw DO config blob. */
export function readTasksFromConfig(config: unknown): PersistedTask[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const cfg = config as Record<string, unknown>;
  if (!Array.isArray(cfg.tasks)) return [];
  return cfg.tasks.map(normalizeStoredTask).filter((t): t is PersistedTask => t !== null);
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isTaskType(v: unknown): v is TaskType {
  return v === "reminder" || v === "workflow" || v === "follow_up" || v === "other";
}

function isScheduleType(v: unknown): v is ScheduleType {
  return v === "once" || v === "interval" || v === "cron";
}

function isTaskStatus(v: unknown): v is TaskStatus {
  return v === "active" || v === "paused" || v === "draft" || v === "error";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
