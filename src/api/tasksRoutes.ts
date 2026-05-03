/**
 * tasksRoutes.ts
 *
 * DO-level HTTP handler for all /tasks/* routes.
 *
 * Called from MainAgent.onRequest() after the Think framework strips the
 * WebSocket / get-messages path first.  The worker-level proxy in server.ts
 * strips /api and forwards requests here with a path like:
 *
 *   GET    /tasks                      → TasksListResponse
 *   POST   /tasks                      → TaskApiResponse  (create)
 *   PATCH  /tasks/:id                  → TaskApiResponse  (partial update)
 *   DELETE /tasks/:id                  → 204 No Content
 *   POST   /tasks/:id/toggle           → TaskApiResponse  (enable / pause)
 *
 * The ?session= query param on the worker-level URL is resolved before this
 * handler runs; by the time onRequest() is called the agent instance IS the
 * correct session.
 *
 * ── Adapter pattern ───────────────────────────────────────────────────────────
 *
 * This module depends only on the TaskRouteAdapter interface so there is no
 * circular import with MainAgent.  MainAgent implements the interface and
 * passes `this as unknown as TaskRouteAdapter` to handleTaskRoute().
 */

import type {
  PersistedTask,
  TaskApiResponse,
  TasksListResponse,
  CreateTaskInput,
  UpdateTaskInput,
  ToggleTaskInput,
} from "../lib/taskPersistence";

// Re-export input + response types so callers can import from one place.
export type {
  CreateTaskInput,
  UpdateTaskInput,
  ToggleTaskInput,
  TaskApiResponse,
  TasksListResponse,
};

// ── Adapter interface ─────────────────────────────────────────────────────────
// MainAgent implements every method below.  The handler depends only on this
// interface so there is no circular import.

export interface TaskRouteAdapter {
  /**
   * Return all persisted tasks.
   * This is a synchronous read from the DO config blob — no network call.
   */
  tasksGetAll(): PersistedTask[];

  /**
   * Create a new task and optionally schedule it via the CF Agents runtime.
   * Returns the persisted task record.
   */
  tasksCreate(input: CreateTaskInput): Promise<PersistedTask>;

  /**
   * Partially update an existing task.  If schedule-related fields change,
   * the old CF Agents schedule is cancelled and a new one is created.
   * Throws if the task is not found.
   */
  tasksUpdate(id: string, input: UpdateTaskInput): Promise<PersistedTask>;

  /**
   * Delete a task by ID and cancel its associated CF Agents schedule.
   * Throws if the task is not found.
   */
  tasksDelete(id: string): Promise<void>;

  /**
   * Enable or pause a task.  Enabling (re)creates the CF Agents schedule;
   * pausing cancels it.
   * Throws if the task is not found.
   */
  tasksToggle(id: string, enabled: boolean): Promise<PersistedTask>;
}

// ── Shared response helpers ───────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Body parsing ──────────────────────────────────────────────────────────────

async function parseJsonBody(request: Request): Promise<unknown | Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("text/plain")) {
    return errJson("Content-Type must be application/json.", 415);
  }
  try {
    return await request.json();
  } catch {
    return errJson("Invalid JSON body.", 400);
  }
}

// ── Sub-path parsing ──────────────────────────────────────────────────────────

/**
 * Extract the canonical /tasks[/...] sub-path from a request URL.
 * Handles both direct calls and DO-proxied paths (which may have a prefix).
 */
function parseSubpath(pathname: string): string {
  const match = /\/tasks(\/[^?]*)?(?:[?]|$)/.exec(pathname);
  return "/tasks" + (match?.[1] ?? "");
}

// ── Input validators ──────────────────────────────────────────────────────────

/** Validate POST /tasks body.  Returns an error string or null. */
function validateCreate(body: Record<string, unknown>): string | null {
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return '"title" must be a non-empty string.';
  }
  if (!body.scheduleType || !["once", "interval", "cron"].includes(body.scheduleType as string)) {
    return '"scheduleType" must be "once", "interval", or "cron".';
  }
  if (!body.scheduleExpression || typeof body.scheduleExpression !== "string" || !body.scheduleExpression.trim()) {
    return '"scheduleExpression" must be a non-empty string.';
  }
  if (!body.instructions || typeof body.instructions !== "string" || !body.instructions.trim()) {
    return '"instructions" must be a non-empty string.';
  }
  return null;
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

/**
 * Entry point — call from MainAgent.onRequest() for any request whose
 * pathname includes "/tasks".
 */
export async function handleTaskRoute(
  request: Request,
  agent: TaskRouteAdapter
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = parseSubpath(url.pathname);
  const { method } = request;

  try {
    // ── GET /tasks ────────────────────────────────────────────────────────────
    if (subpath === "/tasks" && method === "GET") {
      const tasks = agent.tasksGetAll();
      const response: TasksListResponse = {
        tasks: tasks.map((t) => serializeForWire(t)),
        total: tasks.length,
      };
      return json(response);
    }

    // ── POST /tasks ───────────────────────────────────────────────────────────
    if (subpath === "/tasks" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      const validationError = validateCreate(b);
      if (validationError) return errJson(validationError);

      const input: CreateTaskInput = {
        title: (b.title as string).trim(),
        description: typeof b.description === "string" ? b.description.trim() || undefined : undefined,
        taskType: isTaskType(b.taskType) ? b.taskType : "other",
        scheduleType: b.scheduleType as CreateTaskInput["scheduleType"],
        scheduleExpression: (b.scheduleExpression as string).trim(),
        timezone: typeof b.timezone === "string" ? b.timezone.trim() || undefined : undefined,
        enabled: typeof b.enabled === "boolean" ? b.enabled : true,
        instructions: (b.instructions as string).trim(),
        payload: isPlainObject(b.payload) ? (b.payload as Record<string, unknown>) : undefined,
      };

      const task = await agent.tasksCreate(input);
      return json(serializeForWire(task), 201);
    }

    // ── Routes with :id ───────────────────────────────────────────────────────
    const idMatch = /^\/tasks\/([^/]+)(\/[^/]+)?$/.exec(subpath);
    if (!idMatch) {
      return errJson(`Unknown tasks route: ${subpath}`, 404);
    }

    const id = decodeURIComponent(idMatch[1]);
    const action = idMatch[2] ?? "";

    if (!id) return errJson("Task ID is required.", 400);

    // ── POST /tasks/:id/toggle ────────────────────────────────────────────────
    if (action === "/toggle" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      if (typeof b.enabled !== "boolean") {
        return errJson('"enabled" must be a boolean.');
      }

      const input: ToggleTaskInput = { enabled: b.enabled };
      try {
        const task = await agent.tasksToggle(id, input.enabled);
        return json(serializeForWire(task));
      } catch (err) {
        return notFoundOrRethrow(err, id);
      }
    }

    // ── PATCH /tasks/:id ──────────────────────────────────────────────────────
    if (!action && method === "PATCH") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      const input: UpdateTaskInput = {};

      if (typeof b.title === "string") input.title = b.title.trim();
      if (typeof b.description === "string") input.description = b.description.trim() || undefined;
      if (isTaskType(b.taskType)) input.taskType = b.taskType;
      if (isScheduleType(b.scheduleType)) input.scheduleType = b.scheduleType;
      if (typeof b.scheduleExpression === "string") input.scheduleExpression = b.scheduleExpression.trim();
      if (typeof b.timezone === "string") input.timezone = b.timezone.trim() || undefined;
      if (typeof b.enabled === "boolean") input.enabled = b.enabled;
      if (typeof b.instructions === "string") input.instructions = b.instructions.trim();
      if (isPlainObject(b.payload)) input.payload = b.payload as Record<string, unknown>;

      try {
        const task = await agent.tasksUpdate(id, input);
        return json(serializeForWire(task));
      } catch (err) {
        return notFoundOrRethrow(err, id);
      }
    }

    // ── DELETE /tasks/:id ─────────────────────────────────────────────────────
    if (!action && method === "DELETE") {
      try {
        await agent.tasksDelete(id);
        return new Response(null, { status: 204 });
      } catch (err) {
        return notFoundOrRethrow(err, id);
      }
    }

    return errJson(`Method ${method} not allowed for ${subpath}`, 405);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error.";
    console.error("[tasksRoutes]", err);
    return errJson(message, 500);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeForWire(t: PersistedTask): TaskApiResponse {
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
  };
}

function notFoundOrRethrow(err: unknown, id: string): Response {
  const msg = err instanceof Error ? err.message : "";
  if (msg.toLowerCase().includes("not found")) {
    return errJson(`Task "${id}" not found.`, 404);
  }
  throw err;
}

function isTaskType(v: unknown): v is CreateTaskInput["taskType"] {
  return v === "reminder" || v === "workflow" || v === "follow_up" || v === "other";
}

function isScheduleType(v: unknown): v is CreateTaskInput["scheduleType"] {
  return v === "once" || v === "interval" || v === "cron";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
