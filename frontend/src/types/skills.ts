/**
 * frontend/src/types/skills.ts
 *
 * Provider-agnostic frontend types for the Skills feature.
 *
 * Skills are agent-instruction documents surfaced in the system prompt so
 * the model always knows what capabilities are available.  The Cloudflare
 * Agents SDK stores them via R2SkillProvider (agents/experimental/memory/session):
 *
 *   • Metadata (key, description) is injected into the system prompt on every turn.
 *   • Full content is fetched on demand when the model calls `load_context`.
 *   • The model calls `unload_context` to free context space when done.
 *
 * These types describe the wire format returned by the EdgeClaw skills API;
 * they do NOT import or reference SDK internals.
 */

// ── Core document type ─────────────────────────────────────────────────────────

/**
 * A fully-hydrated skill document including its full instruction content.
 *
 * Returned by GET /api/skills/:key and POST/PATCH operations.
 * The `content` field maps to the R2 object body loaded via SkillProvider.load().
 */
export interface SkillDocument {
  /**
   * URL-safe identifier used as the R2 storage key (without bucket prefix).
   * Unique within the agent instance.  Example: "pirate-mode", "code-reviewer".
   */
  key: string;

  /** Human-readable display name shown in the Skills UI. */
  name: string;

  /** One-sentence summary injected into the system prompt for model discovery. */
  description: string;

  /**
   * Full instruction text loaded on demand via the `load_context` tool.
   * May be lengthy — not included in list responses.
   */
  content: string;

  /** Optional tags for filtering and organisation in the UI. */
  tags: string[];

  /** ISO 8601 timestamp of the most recent write. */
  updatedAt: string;

  /**
   * Monotonically incrementing counter bumped on every save.
   * Used for optimistic concurrency checks on updates.
   */
  version: number;
}

// ── Summary type (list view) ───────────────────────────────────────────────────

/**
 * Lightweight skill descriptor returned by GET /api/skills (list endpoint).
 *
 * Omits `content` to keep list responses small — content is loaded separately
 * via the detail endpoint or the agent's `load_context` tool at runtime.
 */
export type SkillSummary = Omit<SkillDocument, "content">;

// ── API request shapes ─────────────────────────────────────────────────────────

/**
 * Fields required to create a new skill.
 * `key` is provided by the caller (slugified from name on the frontend).
 * `version` and `updatedAt` are assigned server-side.
 */
export interface CreateSkillInput {
  key: string;
  name: string;
  description: string;
  content: string;
  tags?: string[];
}

/**
 * Partial update — all fields optional, at least one must be provided.
 * `key`, `version`, and `updatedAt` are immutable via this shape.
 */
export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  tags?: string[];
}

/** Response shape returned after a successful DELETE /api/skills/:key. */
export interface DeleteSkillResult {
  deleted: true;
  key: string;
}

// ── List response ─────────────────────────────────────────────────────────────

/** Envelope returned by GET /api/skills. */
export interface SkillsListResponse {
  skills: SkillSummary[];
  total: number;
}
