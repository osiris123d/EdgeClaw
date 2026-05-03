/**
 * Shared workspace — cross-DO collaboration surface for staged code handoff.
 *
 * Storage domains (do not conflate):
 * - **Think workspace** (`@cloudflare/shell`, per-Durable-Object SQLite): ephemeral scratch, shell tools,
 *   optional code-execution `state.*`. Not canonical shared code.
 * - **Project notes** (`/project-notes` via `save_project_note` in `src/tools/index.ts`): structured notes in
 *   the Think workspace tree — same-DO only, different product surface from shared workspace.
 * - **Shared workspace** (this module): logical project tree + patch proposals + verification blobs under a
 *   `projectId`, backed by `SharedWorkspaceStorage` (KV initially). Staging/handoff — not git history.
 * - **Skills** (R2 `SKILLS_BUCKET`) and **workflow persistence** (DO SQLite `wf_*` tables / workflow R2 reports):
 *   unrelated persistence; do not store canonical repo code there by mistake.
 * - **Promotion bundles** (`PROMOTION_ARTIFACTS_BUCKET` / noop artifact writer): immutable manifests — separate KV/R2 from collaboration.
 * - **Git history** (canonical lineage): real git via `src/repo/` (`GitExecutionAdapter`, MCP, or Workflow); not KV.
 *
 * Backend: `SharedWorkspaceStorage` is domain-shaped. `SHARED_WORKSPACE_KV` is one adapter (see
 * `sharedWorkspaceKvStorage.ts`). R2/git implementations can map the same interface without changing tools.
 *
 * Deferred: git apply, Wrangler-specific flows, signed capability tokens for cross-tenant isolation.
 */

/** Who is performing an operation (policy uses this). */
export type SharedWorkspacePrincipalRole = "orchestrator" | "coder" | "tester";

/** Coder may only create/overwrite files under this relative prefix (logical paths). */
export const SHARED_WORKSPACE_STAGING_PREFIX = "staging";

/** Lifecycle for patch proposals (git integration deferred). */
export type PatchProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface PatchProposalRecord {
  status: PatchProposalStatus;
  /** Opaque patch body (e.g. unified diff text); applied by orchestrator policy / future git step. */
  body: string;
  updatedAt: string;
  rejectReason?: string;
}

/**
 * Persistence abstraction for shared workspace data — **not** KV-shaped at the type level.
 * Implementations may use KV, R2, Postgres, etc.; callers use logical project paths and ids only.
 */
export interface SharedWorkspaceStorage {
  readProjectFile(projectId: string, relativePath: string): Promise<string | null>;
  writeProjectFile(projectId: string, relativePath: string, content: string): Promise<void>;

  /** Relative paths under the project file tree (canonical + `staging/…`). */
  listProjectFiles(projectId: string, directoryPrefix: string): Promise<string[]>;

  readPatchProposal(projectId: string, patchId: string): Promise<PatchProposalRecord | null>;
  writePatchProposal(projectId: string, patchId: string, record: PatchProposalRecord): Promise<void>;
  listPatchProposalIds(projectId: string): Promise<string[]>;

  readVerification(projectId: string, verificationId: string): Promise<string | null>;
  writeVerification(projectId: string, verificationId: string, payload: string): Promise<void>;

  readProjectMeta(projectId: string): Promise<string | null>;
  writeProjectMeta(projectId: string, metaJson: string): Promise<void>;
}

/**
 * Policy gate: orchestrator is authoritative; coder uses staging + proposals; tester reads + verification only.
 */
export class SharedWorkspaceGateway {
  constructor(private readonly storage: SharedWorkspaceStorage) {}

  private static normalizeRelativePath(path: string): string {
    const trimmed = path.trim().replace(/^\/+/, "");
    const segments = trimmed.split("/").filter(Boolean);
    for (const s of segments) {
      if (s === ".." || s === "." || s.includes("\0")) {
        throw new Error(`Unsafe shared workspace path: ${path}`);
      }
    }
    return segments.join("/");
  }

  private static isStagingPath(normalizedPath: string): boolean {
    return (
      normalizedPath === SHARED_WORKSPACE_STAGING_PREFIX ||
      normalizedPath.startsWith(`${SHARED_WORKSPACE_STAGING_PREFIX}/`)
    );
  }

  async readFile(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    relativePath: string
  ): Promise<{ content: string } | { error: string }> {
    void role;
    try {
      const p = SharedWorkspaceGateway.normalizeRelativePath(relativePath);
      const raw = await this.storage.readProjectFile(projectId, p);
      if (raw == null) {
        return { error: `Not found: ${relativePath}` };
      }
      return { content: raw };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Orchestrator: any logical path. Coder: only `staging/…` paths (controlled staging handoff).
   * Tester: forbidden at gateway level.
   */
  async writeFile(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    relativePath: string,
    content: string
  ): Promise<{ ok: true } | { error: string }> {
    if (role === "tester") {
      return {
        error:
          "tester cannot write project files; use record_verification for reports or ask the orchestrator.",
      };
    }
    try {
      const p = SharedWorkspaceGateway.normalizeRelativePath(relativePath);
      if (role === "coder") {
        if (!SharedWorkspaceGateway.isStagingPath(p)) {
          return {
            error:
              `coder may only write under '${SHARED_WORKSPACE_STAGING_PREFIX}/' (staging handoff). Use propose_patch for change proposals.`,
          };
        }
      }
      await this.storage.writeProjectFile(projectId, p, content);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async listFiles(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    directoryPrefix: string
  ): Promise<{ paths: string[] } | { error: string }> {
    void role;
    try {
      const dir = SharedWorkspaceGateway.normalizeRelativePath(directoryPrefix || "");
      const paths = await this.storage.listProjectFiles(projectId, dir);
      return { paths };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Create or replace a patch proposal (pending until orchestrator approves/rejects/applies).
   */
  async putPatchProposal(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string,
    body: string
  ): Promise<{ ok: true } | { error: string }> {
    if (role !== "orchestrator" && role !== "coder") {
      return { error: "only orchestrator or coder may propose patches" };
    }
    try {
      const now = new Date().toISOString();
      const existing = await this.storage.readPatchProposal(projectId, patchId);
      const record: PatchProposalRecord = {
        status: "pending",
        body,
        updatedAt: now,
        rejectReason: undefined,
      };
      if (existing && role === "coder") {
        if (existing.status !== "pending") {
          return {
            error:
              `patch ${patchId} is ${existing.status}; only pending proposals can be overwritten by coder`,
          };
        }
      }
      await this.storage.writePatchProposal(projectId, patchId, record);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async listPatchProposals(
    role: SharedWorkspacePrincipalRole,
    projectId: string
  ): Promise<{ patches: Array<{ patchId: string; status: PatchProposalStatus }> } | { error: string }> {
    if (role !== "orchestrator" && role !== "tester" && role !== "coder") {
      return { error: "only orchestrator, tester, or coder may list patch proposals" };
    }
    try {
      const ids = await this.storage.listPatchProposalIds(projectId);
      const patches: Array<{ patchId: string; status: PatchProposalStatus }> = [];
      for (const id of ids) {
        const rec = await this.storage.readPatchProposal(projectId, id);
        if (rec) {
          patches.push({ patchId: id, status: rec.status });
        }
      }
      patches.sort((a, b) => a.patchId.localeCompare(b.patchId));
      return { patches };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getPatchProposal(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string
  ): Promise<{ record: PatchProposalRecord } | { error: string }> {
    if (role !== "orchestrator" && role !== "coder" && role !== "tester") {
      return { error: "only orchestrator, coder, or tester may read patch proposals" };
    }
    try {
      const rec = await this.storage.readPatchProposal(projectId, patchId);
      if (rec == null) {
        return { error: `patch not found: ${patchId}` };
      }
      return { record: rec };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async approvePatch(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string
  ): Promise<{ ok: true } | { error: string }> {
    return this.transitionPatch(role, projectId, patchId, "approved", ["pending"]);
  }

  async rejectPatch(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string,
    reason?: string
  ): Promise<{ ok: true } | { error: string }> {
    if (role !== "orchestrator") {
      return { error: "only orchestrator may reject patches" };
    }
    try {
      const rec = await this.storage.readPatchProposal(projectId, patchId);
      if (rec == null) {
        return { error: `patch not found: ${patchId}` };
      }
      if (rec.status !== "pending") {
        return { error: `patch ${patchId} is ${rec.status}; expected pending` };
      }
      const next: PatchProposalRecord = {
        ...rec,
        status: "rejected",
        rejectReason: reason?.trim() || undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.storage.writePatchProposal(projectId, patchId, next);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Mark an approved patch as applied (content merge / git apply deferred).
   */
  async applyPatch(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string
  ): Promise<{ ok: true } | { error: string }> {
    return this.transitionPatch(role, projectId, patchId, "applied", ["approved"]);
  }

  private async transitionPatch(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    patchId: string,
    nextStatus: PatchProposalStatus,
    allowedFrom: PatchProposalStatus[]
  ): Promise<{ ok: true } | { error: string }> {
    if (role !== "orchestrator") {
      return { error: "only orchestrator may change patch lifecycle" };
    }
    try {
      const rec = await this.storage.readPatchProposal(projectId, patchId);
      if (rec == null) {
        return { error: `patch not found: ${patchId}` };
      }
      if (!allowedFrom.includes(rec.status)) {
        return { error: `patch ${patchId} is ${rec.status}; cannot transition to ${nextStatus}` };
      }
      const next: PatchProposalRecord = {
        ...rec,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      };
      await this.storage.writePatchProposal(projectId, patchId, next);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async recordVerification(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    verificationId: string,
    payload: string
  ): Promise<{ ok: true } | { error: string }> {
    if (role !== "orchestrator" && role !== "tester") {
      return { error: "only orchestrator or tester may record verification output" };
    }
    try {
      await this.storage.writeVerification(projectId, verificationId, payload);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async registerProjectMeta(
    role: SharedWorkspacePrincipalRole,
    projectId: string,
    metaJson: string
  ): Promise<{ ok: true } | { error: string }> {
    if (role !== "orchestrator") {
      return { error: "only orchestrator can register shared project metadata" };
    }
    try {
      await this.storage.writeProjectMeta(projectId, metaJson);
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async readProjectMeta(
    role: SharedWorkspacePrincipalRole,
    projectId: string
  ): Promise<{ json: string | null } | { error: string }> {
    void role;
    try {
      const json = await this.storage.readProjectMeta(projectId);
      return { json };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
