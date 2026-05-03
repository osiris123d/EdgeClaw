/**
 * skillsRoutes.ts
 *
 * DO-level HTTP handler for all /skills/* routes.
 *
 * Called from MainAgent.onRequest() after the Think framework strips the
 * WebSocket / get-messages path first.  The worker-level proxy in server.ts
 * strips /api and forwards requests here with a path like:
 *
 *   GET    /skills              → SkillsListResponse
 *   GET    /skills/:key         → SkillDocument | 404
 *   POST   /skills              → SkillDocument  (201 Created)
 *   PATCH  /skills/:key         → SkillDocument
 *   DELETE /skills/:key         → DeleteSkillResult
 *
 * ── Adapter pattern ────────────────────────────────────────────────────────────
 *
 * This module depends only on SkillRouteAdapter so there is no circular import
 * with MainAgent.  MainAgent implements the interface and passes
 * `this as unknown as SkillRouteAdapter` to handleSkillRoute().
 *
 * The adapter method signatures intentionally match the @callable() methods
 * already declared on MainAgent, so the cast is zero-cost at runtime.
 */

import type {
  SkillDocument,
  SkillSummary,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
} from "../skills/types";

// Re-export types so callers can import everything from one place.
export type {
  SkillDocument,
  SkillSummary,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
};

// ── List response envelope ─────────────────────────────────────────────────────

export interface SkillsListResponse {
  skills: SkillSummary[];
  total: number;
}

// ── Adapter interface ──────────────────────────────────────────────────────────
// MainAgent implements every method below.  The handler depends only on this
// interface so there is no circular import.

export interface SkillRouteAdapter {
  /** Return all skill summaries, sorted by updatedAt descending. */
  listSkills(): Promise<SkillSummary[]>;

  /** Return a fully-hydrated skill document, or null when not found. */
  getSkill(key: string): Promise<SkillDocument | null>;

  /** Create a new skill document and persist it to R2. */
  createSkill(input: CreateSkillInput): Promise<SkillDocument>;

  /** Partially update an existing skill.  Throws if not found. */
  updateSkill(key: string, patch: UpdateSkillInput): Promise<SkillDocument>;

  /** Delete a skill by key.  Throws if not found. */
  deleteSkill(key: string): Promise<DeleteSkillResult>;
}

// ── Shared response helpers ────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Body parsing ───────────────────────────────────────────────────────────────

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

// ── Sub-path parsing ───────────────────────────────────────────────────────────

/**
 * Extract the canonical /skills[/...] sub-path from a request URL.
 * Handles both direct calls and DO-proxied paths (which may have a prefix).
 */
function parseSubpath(pathname: string): string {
  const match = /\/skills(\/[^?]*)?(?:[?]|$)/.exec(pathname);
  return "/skills" + (match?.[1] ?? "");
}

// ── Input validators ───────────────────────────────────────────────────────────

/** Validate POST /skills body.  Returns an error string or null. */
function validateCreate(body: Record<string, unknown>): string | null {
  if (!body.key || typeof body.key !== "string" || !body.key.trim()) {
    return '"key" must be a non-empty string.';
  }
  if (!/^[a-z0-9][a-z0-9\-_]*$/.test((body.key as string).trim())) {
    return '"key" must start with a letter or digit and contain only lowercase letters, digits, hyphens, or underscores.';
  }
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return '"name" must be a non-empty string.';
  }
  if (!body.description || typeof body.description !== "string" || !body.description.trim()) {
    return '"description" must be a non-empty string.';
  }
  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    return '"content" must be a non-empty string.';
  }
  return null;
}

// ── Route dispatcher ───────────────────────────────────────────────────────────

/**
 * Entry point — call from MainAgent.onRequest() for any request whose
 * pathname includes "/skills".
 */
export async function handleSkillRoute(
  request: Request,
  agent: SkillRouteAdapter
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = parseSubpath(url.pathname);
  const { method } = request;

  try {
    // ── GET /skills ────────────────────────────────────────────────────────────
    if (subpath === "/skills" && method === "GET") {
      const skills = await agent.listSkills();
      const response: SkillsListResponse = { skills, total: skills.length };
      return json(response);
    }

    // ── POST /skills ───────────────────────────────────────────────────────────
    if (subpath === "/skills" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      const validationError = validateCreate(b);
      if (validationError) return errJson(validationError);

      const input: CreateSkillInput = {
        key: (b.key as string).trim(),
        name: (b.name as string).trim(),
        description: (b.description as string).trim(),
        content: (b.content as string).trim(),
        tags: Array.isArray(b.tags)
          ? (b.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
      };

      const skill = await agent.createSkill(input);
      return json(skill, 201);
    }

    // ── Routes with :key ───────────────────────────────────────────────────────
    const keyMatch = /^\/skills\/([^/]+)$/.exec(subpath);
    if (!keyMatch) {
      return errJson(`Unknown skills route: ${subpath}`, 404);
    }

    const key = decodeURIComponent(keyMatch[1]);
    if (!key) return errJson("Skill key is required.", 400);

    // ── GET /skills/:key ───────────────────────────────────────────────────────
    if (method === "GET") {
      const skill = await agent.getSkill(key);
      if (!skill) return errJson(`Skill "${key}" not found.`, 404);
      return json(skill);
    }

    // ── PATCH /skills/:key ─────────────────────────────────────────────────────
    if (method === "PATCH") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      const patch: UpdateSkillInput = {};

      if (typeof b.name === "string") patch.name = b.name.trim();
      if (typeof b.description === "string") patch.description = b.description.trim();
      if (typeof b.content === "string") patch.content = b.content.trim();
      if (Array.isArray(b.tags)) {
        patch.tags = (b.tags as unknown[]).filter((t): t is string => typeof t === "string");
      }

      try {
        const skill = await agent.updateSkill(key, patch);
        return json(skill);
      } catch (err) {
        return notFoundOrRethrow(err, key);
      }
    }

    // ── DELETE /skills/:key ────────────────────────────────────────────────────
    if (method === "DELETE") {
      try {
        const result = await agent.deleteSkill(key);
        return json(result);
      } catch (err) {
        return notFoundOrRethrow(err, key);
      }
    }

    return errJson(`Method ${method} not allowed for ${subpath}`, 405);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error.";
    console.error("[skillsRoutes]", err);
    return errJson(message, 500);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function notFoundOrRethrow(err: unknown, key: string): Response {
  const msg = err instanceof Error ? err.message : "";
  if (msg.toLowerCase().includes("not found")) {
    return errJson(`Skill "${key}" not found.`, 404);
  }
  throw err;
}
