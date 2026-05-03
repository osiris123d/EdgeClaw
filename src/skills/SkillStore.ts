/**
 * src/skills/SkillStore.ts
 *
 * Manages skill documents in an R2 bucket.
 *
 * Storage layout
 * ──────────────
 * Each skill is stored as a JSON object at `${prefix}${key}.json`.
 *
 * For efficient listing without fetching every object body, summary fields
 * (name, description, tags, updatedAt, version) are also written into R2
 * custom metadata on every put.  The full content lives only in the body.
 *
 * This mirrors the approach used by the official Cloudflare session-skills
 * example (experimental/session-skills) while adding the richer metadata
 * (name, tags, version) required by the EdgeClaw Skills UI.
 */

import type {
  CreateSkillInput,
  DeleteSkillResult,
  SkillDocument,
  SkillSummary,
  UpdateSkillInput,
} from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PREFIX = "skills/";

/**
 * Maximum number of objects returned per R2 list page.
 * R2 caps this at 1 000; we stay safely below it.
 */
const LIST_PAGE_LIMIT = 500;

/** Valid skill key pattern: letters, digits, hyphens, underscores. */
const KEY_RE = /^[a-z0-9][a-z0-9\-_]*$/i;

// ── Internal metadata shape stored in R2 custom metadata ──────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertKey(key: string): void {
  if (!key || key.trim() === "") {
    throw new Error("Skill key must not be empty.");
  }
  if (!KEY_RE.test(key)) {
    throw new Error(
      `Skill key "${key}" is invalid. ` +
        "Use only letters, digits, hyphens, or underscores, " +
        "and start with a letter or digit."
    );
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value || value.trim() === "") {
    throw new Error(`Skill ${field} must not be empty.`);
  }
}

/** Encode a SkillDocument's summary fields for R2 custom metadata. */
function encodeMetadata(doc: SkillDocument): Record<string, string> {
  return {
    name: doc.name,
    description: doc.description,
    tags: JSON.stringify(doc.tags),
    updatedAt: doc.updatedAt,
    version: String(doc.version),
  };
}

/**
 * Reconstruct a SkillSummary from an R2 object's key and custom metadata.
 * Falls back to safe defaults when metadata is absent (e.g. external writes).
 *
 * Handles both the current key format (`skills/<key>`) and the legacy format
 * (`skills/<key>.json`) written by older versions of SkillStore.
 */
function decodeSummary(r2Key: string, prefix: string, meta: Record<string, string> | undefined): SkillSummary {
  const raw = r2Key.slice(prefix.length);
  const key = raw.endsWith(".json") ? raw.slice(0, -".json".length) : raw;
  let tags: string[] = [];
  try {
    if (meta?.tags) tags = JSON.parse(meta.tags) as string[];
  } catch {
    // malformed tags — default to empty
  }
  return {
    key,
    name: meta?.name ?? key,
    description: meta?.description ?? "",
    tags,
    updatedAt: meta?.updatedAt ?? "",
    version: meta?.version ? parseInt(meta.version, 10) : 1,
  };
}

// ── SkillStore ─────────────────────────────────────────────────────────────────

export class SkillStore {
  private readonly bucket: R2Bucket;
  private readonly prefix: string;

  constructor(bucket: R2Bucket, prefix = DEFAULT_PREFIX) {
    this.bucket = bucket;
    // Ensure the prefix always ends with a slash.
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private r2Key(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Legacy key format written by older SkillStore versions. */
  private r2KeyLegacy(key: string): string {
    return `${this.prefix}${key}.json`;
  }

  private async putDoc(doc: SkillDocument): Promise<void> {
    // Store only the content text as the R2 body so R2SkillProvider can read it
    // via load_context without needing to understand our JSON wrapper.
    // All other fields (name, description, tags, version, updatedAt) live in
    // R2 custom metadata and are reconstructed by getSkill / decodeSummary.
    await this.bucket.put(this.r2Key(doc.key), doc.content, {
      customMetadata: encodeMetadata(doc),
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * List all skills as summaries, sorted by updatedAt descending (newest first).
   * Fetches R2 custom metadata only — does not download skill content bodies.
   * Automatically follows R2 pagination cursors.
   */
  async listSkills(): Promise<SkillSummary[]> {
    const summaries: SkillSummary[] = [];
    let cursor: string | undefined;

    do {
      // `include: ["customMetadata"]` is valid at runtime but absent from the
      // R2ListOptions TS type — cast to unknown to satisfy the compiler.
      const page = await this.bucket.list({
        prefix: this.prefix,
        limit: LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      } as unknown as R2ListOptions);

      for (const obj of page.objects) {
        summaries.push(decodeSummary(obj.key, this.prefix, obj.customMetadata));
      }

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Fetch a single skill including its full content body.
   * Returns null when no object exists at the given key.
   */
  async getSkill(key: string): Promise<SkillDocument | null> {
    assertKey(key);

    // ── Format history ────────────────────────────────────────────────────────
    // v1 (legacy):  key = skills/<key>.json  body = JSON SkillDocument
    // v2 (interim): key = skills/<key>        body = JSON SkillDocument
    // v3 (current): key = skills/<key>        body = plain text content only
    //
    // We detect and migrate older formats on first read so load_context always
    // finds a plain-text body at the canonical (no-.json) key.

    // Try canonical key first, then legacy .json key.
    let obj = await this.bucket.get(this.r2Key(key));
    const wasLegacyKey = !obj;
    if (!obj) obj = await this.bucket.get(this.r2KeyLegacy(key));
    if (!obj) return null;

    try {
      const rawBody = await obj.text();
      const meta = obj.customMetadata as Record<string, string> | undefined;

      // Detect v1/v2 format: body is a JSON-encoded SkillDocument.
      let doc: SkillDocument;
      let isLegacyBody = false;
      try {
        const parsed = JSON.parse(rawBody) as Partial<SkillDocument>;
        if (parsed && typeof parsed.content === "string") {
          // v1 or v2 — full JSON object in body.
          isLegacyBody = true;
          doc = {
            key: parsed.key ?? key,
            name: parsed.name ?? meta?.name ?? key,
            description: parsed.description ?? meta?.description ?? "",
            content: parsed.content,
            tags: parsed.tags ?? [],
            updatedAt: parsed.updatedAt ?? meta?.updatedAt ?? new Date().toISOString(),
            version: parsed.version ?? 1,
          };
        } else {
          // JSON but no content field — treat body as plain text.
          doc = decodeSummary(this.r2Key(key), this.prefix, meta) as SkillDocument;
          doc.content = rawBody;
        }
      } catch {
        // v3 — body is plain text (not JSON).
        doc = {
          key,
          name: meta?.name ?? key,
          description: meta?.description ?? "",
          content: rawBody,
          tags: (() => { try { return JSON.parse(meta?.tags ?? "[]") as string[]; } catch { return []; } })(),
          updatedAt: meta?.updatedAt ?? "",
          version: meta?.version ? parseInt(meta.version, 10) : 1,
        };
      }

      // Migrate to v3 format if needed.
      if (isLegacyBody || wasLegacyKey) {
        await this.putDoc(doc);                                    // write v3 (plain body, canonical key)
        if (wasLegacyKey) await this.bucket.delete(this.r2KeyLegacy(key)); // remove old .json key
      }

      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Create a new skill document.
   * Throws when the key already exists — use updateSkill to modify an existing skill.
   */
  async createSkill(input: CreateSkillInput): Promise<SkillDocument> {
    assertKey(input.key);
    assertNonEmpty(input.name, "name");
    assertNonEmpty(input.description, "description");
    assertNonEmpty(input.content, "content");

    const existing =
      (await this.bucket.head(this.r2Key(input.key))) ??
      (await this.bucket.head(this.r2KeyLegacy(input.key)));
    if (existing) {
      throw new Error(
        `Skill "${input.key}" already exists. Use updateSkill to modify it.`
      );
    }

    const doc: SkillDocument = {
      key: input.key,
      name: input.name.trim(),
      description: input.description.trim(),
      content: input.content,
      tags: input.tags ?? [],
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    await this.putDoc(doc);
    return doc;
  }

  /**
   * Apply a partial update to an existing skill.
   * Bumps version and refreshes updatedAt on every successful write.
   * Throws when the skill does not exist.
   */
  async updateSkill(key: string, patch: UpdateSkillInput): Promise<SkillDocument> {
    assertKey(key);

    const existing = await this.getSkill(key);
    if (!existing) {
      throw new Error(`Skill "${key}" not found.`);
    }

    // Validate patched fields that have non-empty constraints.
    if (patch.name !== undefined) assertNonEmpty(patch.name, "name");
    if (patch.description !== undefined) assertNonEmpty(patch.description, "description");
    if (patch.content !== undefined) assertNonEmpty(patch.content, "content");

    const updated: SkillDocument = {
      ...existing,
      ...(patch.name !== undefined      ? { name: patch.name.trim() }               : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.content !== undefined   ? { content: patch.content }                : {}),
      ...(patch.tags !== undefined      ? { tags: patch.tags }                      : {}),
      key, // key is immutable
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };

    await this.putDoc(updated);
    return updated;
  }

  /**
   * Permanently delete a skill.
   * Throws when the skill does not exist (prevents silent no-ops).
   */
  async deleteSkill(key: string): Promise<DeleteSkillResult> {
    assertKey(key);

    const existsCurrent = await this.bucket.head(this.r2Key(key));
    const existsLegacy  = !existsCurrent && await this.bucket.head(this.r2KeyLegacy(key));

    if (!existsCurrent && !existsLegacy) {
      throw new Error(`Skill "${key}" not found.`);
    }

    if (existsCurrent) await this.bucket.delete(this.r2Key(key));
    if (existsLegacy)  await this.bucket.delete(this.r2KeyLegacy(key));
    return { deleted: true, key };
  }
}
