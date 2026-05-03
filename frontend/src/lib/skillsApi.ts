/**
 * Skills API client — frontend/src/lib/skillsApi.ts
 *
 * Thin fetch wrapper over the /api/skills endpoints served by the MainAgent
 * Durable Object.  All Cloudflare-specific logic lives on the backend; this
 * file only handles HTTP serialization and error normalization.
 *
 * Endpoint contract (implemented in src/api/skillsRoutes.ts):
 *
 *   GET    /api/skills          → SkillsListResponse
 *   GET    /api/skills/:key     → SkillDocument
 *   POST   /api/skills          → SkillDocument  (201 Created)
 *   PATCH  /api/skills/:key     → SkillDocument
 *   DELETE /api/skills/:key     → DeleteSkillResult
 *
 * ── Transport note ────────────────────────────────────────────────────────────
 *
 * Skill management calls are plain REST over HTTP — they are NOT part of the
 * WebSocket chat transport handled by AgentClient.  The AgentClient (and the
 * useAgent hook pattern) is responsible for streaming chat messages only.
 * These helpers are designed for use in the Skills sidebar UI that sits
 * alongside the chat pane, independently of any active chat session.
 *
 * The ?session= query param can be appended to target a specific agent DO
 * instance.  It is omitted here (defaults to "default"), matching the pattern
 * used by tasksApi.ts and memoryApi.ts.
 */

import type {
  SkillDocument,
  SkillSummary,
  SkillsListResponse,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
} from "../types/skills";

// Re-export input / result types so callers can import everything from one place.
export type {
  SkillDocument,
  SkillSummary,
  SkillsListResponse,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
} from "../types/skills";

const BASE = "/api/skills";

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
      `[skillsApi] Network error reaching ${url}: ${
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
      try {
        detail = await res.text();
      } catch {
        /* fall through */
      }
    }
    throw new Error(`[skillsApi] ${res.status} — ${detail}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`[skillsApi] Response from ${url} was not valid JSON`);
  }
}

// ── Internal: response normalizer ─────────────────────────────────────────────
//
// Validates that every skill object returned by the API has the expected shape
// so downstream UI code can trust the required fields are present.

function normalizeSkillSummary(raw: unknown): SkillSummary {
  if (!raw || typeof raw !== "object") {
    throw new Error("[skillsApi] Unexpected skill shape in API response");
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.key !== "string" || typeof s.name !== "string") {
    throw new Error(
      "[skillsApi] Skill response is missing required fields (key, name)"
    );
  }
  return s as unknown as SkillSummary;
}

function normalizeSkillDocument(raw: unknown): SkillDocument {
  if (!raw || typeof raw !== "object") {
    throw new Error("[skillsApi] Unexpected skill document shape in API response");
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.key !== "string" ||
    typeof d.name !== "string" ||
    typeof d.content !== "string"
  ) {
    throw new Error(
      "[skillsApi] Skill document is missing required fields (key, name, content)"
    );
  }
  return d as unknown as SkillDocument;
}

// ── Public API ────────────────────────────────────────────────────────────────
//
// Each function corresponds 1-to-1 with a @callable() method on MainAgent.
// The HTTP transport is an implementation detail — callers see only typed
// Promise-based functions with AbortSignal support for cancellation.

/** Fetch all skill summaries for the current session, sorted by most recently updated. */
export async function listSkills(signal?: AbortSignal): Promise<SkillsListResponse> {
  const data = await requestJson<SkillsListResponse>(BASE, { signal });
  return {
    skills: data.skills.map(normalizeSkillSummary),
    total: data.total,
  };
}

/**
 * Fetch a single skill with full content by key.
 * Returns null when the skill does not exist (404 is treated as a non-error).
 */
export async function getSkill(
  key: string,
  signal?: AbortSignal
): Promise<SkillDocument | null> {
  try {
    const raw = await requestJson<SkillDocument>(`${BASE}/${encodeURIComponent(key)}`, {
      signal,
    });
    return normalizeSkillDocument(raw);
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return null;
    throw err;
  }
}

/** Create a new skill.  Returns the persisted document with server-assigned fields. */
export async function createSkill(
  input: CreateSkillInput,
  signal?: AbortSignal
): Promise<SkillDocument> {
  const raw = await requestJson<SkillDocument>(BASE, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  return normalizeSkillDocument(raw);
}

/** Partially update an existing skill.  Returns the updated document. */
export async function updateSkill(
  key: string,
  patch: UpdateSkillInput,
  signal?: AbortSignal
): Promise<SkillDocument> {
  const raw = await requestJson<SkillDocument>(
    `${BASE}/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
      signal,
    }
  );
  return normalizeSkillDocument(raw);
}

/** Permanently delete a skill by key.  Returns a typed confirmation object. */
export async function deleteSkill(
  key: string,
  signal?: AbortSignal
): Promise<DeleteSkillResult> {
  return requestJson<DeleteSkillResult>(
    `${BASE}/${encodeURIComponent(key)}`,
    { method: "DELETE", signal }
  );
}
