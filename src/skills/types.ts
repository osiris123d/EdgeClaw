/**
 * src/skills/types.ts
 *
 * Backend-facing skill types used by SkillStore and the HTTP route handler.
 * These mirror frontend/src/types/skills.ts in shape so the wire format is
 * identical — do NOT import from frontend source files here.
 */

// ── Core document ──────────────────────────────────────────────────────────────

/**
 * A fully-hydrated skill document, including its full instruction content.
 * Stored as JSON in R2 under `${prefix}${key}.json`.
 */
export interface SkillDocument {
  /** URL-safe storage key, unique within the agent instance. */
  key: string;
  /** Human-readable display name. */
  name: string;
  /** One-sentence summary injected into the system prompt for model discovery. */
  description: string;
  /** Full instruction text, loaded on demand via the load_context tool. */
  content: string;
  /** Optional tags for filtering in the Skills UI. */
  tags: string[];
  /** ISO 8601 timestamp of the most recent write. */
  updatedAt: string;
  /** Monotonically incrementing write counter for optimistic concurrency. */
  version: number;
}

// ── Summary (list view) ────────────────────────────────────────────────────────

/**
 * Lightweight descriptor returned by list endpoints.
 * Omits `content` so list responses stay small.
 */
export type SkillSummary = Omit<SkillDocument, "content">;

// ── API request shapes ─────────────────────────────────────────────────────────

/** Fields required to create a new skill document. */
export interface CreateSkillInput {
  key: string;
  name: string;
  description: string;
  content: string;
  tags?: string[];
}

/** Partial update — only provided fields are changed. */
export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  tags?: string[];
}

/** Returned after a successful delete operation. */
export interface DeleteSkillResult {
  deleted: true;
  key: string;
}
