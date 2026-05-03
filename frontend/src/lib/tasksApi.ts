/**
 * Tasks API client — frontend/src/lib/tasksApi.ts
 *
 * Thin fetch wrapper over the /api/tasks endpoints served by the MainAgent
 * Durable Object.  All Cloudflare-specific logic lives on the backend; this
 * file only handles HTTP serialization and error normalization.
 *
 * Endpoint contract (implemented in src/api/tasksRoutes.ts):
 *
 *   GET    /api/tasks           → TasksListResponse
 *   POST   /api/tasks           → ScheduledTask  (201)
 *   PATCH  /api/tasks/:id       → ScheduledTask
 *   DELETE /api/tasks/:id       → 204 No Content
 *   POST   /api/tasks/:id/toggle { enabled: boolean } → ScheduledTask
 *
 * The ?session= query param can be appended to target a specific agent DO
 * instance.  It is omitted here (defaults to "default"), matching the
 * pattern used by mcpApi.ts and memoryApi.ts.
 */

import type {
  ScheduledTask,
  TasksListResponse,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from "../types/tasks";

// Re-export input types so callers can import everything from one place.
export type { CreateScheduledTaskInput, UpdateScheduledTaskInput } from "../types/tasks";

const BASE = "/api/tasks";

// ── Internal: fetch helper ────────────────────────────────────────────────────

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `[tasksApi] Network error reaching ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = typeof body.error === "string" ? body.error : JSON.stringify(body);
    } catch {
      try { detail = await res.text(); } catch { /* fall through */ }
    }
    throw new Error(`[tasksApi] ${res.status} — ${detail}`);
  }

  // 204 No Content — return undefined cast to T (callers of delete expect void).
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`[tasksApi] Response from ${url} was not valid JSON`);
  }
}

// ── Internal: response normalizer ─────────────────────────────────────────────
//
// Validates the shape of every task object returned by the API so downstream
// UI code can trust it has the required fields.

function normalizeTask(raw: unknown): ScheduledTask {
  if (!raw || typeof raw !== "object") {
    throw new Error("[tasksApi] Unexpected task shape in API response");
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || typeof t.title !== "string") {
    throw new Error(
      "[tasksApi] Task response is missing required fields (id, title)"
    );
  }
  return t as unknown as ScheduledTask;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Fetch all scheduled tasks for the current session. */
export async function getTasks(
  signal?: AbortSignal
): Promise<TasksListResponse> {
  const data = await requestJson<TasksListResponse>(BASE, { signal });
  return {
    tasks: data.tasks.map(normalizeTask),
    total: data.total,
  };
}

/** Create a new scheduled task. Returns the task with server-assigned fields. */
export async function createTask(
  input: CreateScheduledTaskInput,
  signal?: AbortSignal
): Promise<ScheduledTask> {
  const raw = await requestJson<ScheduledTask>(BASE, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  return normalizeTask(raw);
}

/** Partially update an existing task. Returns the updated task. */
export async function updateTask(
  id: string,
  input: UpdateScheduledTaskInput,
  signal?: AbortSignal
): Promise<ScheduledTask> {
  const raw = await requestJson<ScheduledTask>(`${BASE}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    signal,
  });
  return normalizeTask(raw);
}

/** Permanently delete a task by ID. */
export async function deleteTask(
  id: string,
  signal?: AbortSignal
): Promise<void> {
  await requestJson<void>(`${BASE}/${id}`, {
    method: "DELETE",
    signal,
  });
}

/** Enable or pause a task. Convenience wrapper around the toggle endpoint. */
export async function toggleTask(
  id: string,
  enabled: boolean,
  signal?: AbortSignal
): Promise<ScheduledTask> {
  const raw = await requestJson<ScheduledTask>(`${BASE}/${id}/toggle`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
    signal,
  });
  return normalizeTask(raw);
}
