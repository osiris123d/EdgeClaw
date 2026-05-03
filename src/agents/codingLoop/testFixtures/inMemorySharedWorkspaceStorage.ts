import type { PatchProposalRecord, SharedWorkspaceStorage } from "../../../workspace/sharedWorkspaceTypes";

/**
 * Test-only in-memory {@link SharedWorkspaceStorage}. Feed through {@link SharedWorkspaceGateway}
 * so patch lifecycle matches production behavior (approve/apply transitions).
 *
 * **Seam:** Only used by coding-loop tests and fixtures — not bundled into Worker entrypoints.
 */
export class InMemorySharedWorkspaceStorage implements SharedWorkspaceStorage {
  private readonly files = new Map<string, string>();
  private readonly patches = new Map<string, PatchProposalRecord>();
  private readonly patchIdsByProject = new Map<string, Set<string>>();
  private readonly verifications = new Map<string, string>();
  private readonly metaByProject = new Map<string, string>();

  private patchKey(projectId: string, patchId: string): string {
    return `${projectId}\u0000${patchId}`;
  }

  private fileKey(projectId: string, relativePath: string): string {
    return `${projectId}\u0000${relativePath}`;
  }

  /** Seed a pending proposal without going through gateway policy (tests only). */
  seedPendingPatch(projectId: string, patchId: string, body = "(seed diff)\n"): void {
    const now = new Date().toISOString();
    const record: PatchProposalRecord = { status: "pending", body, updatedAt: now };
    const pk = this.patchKey(projectId, patchId);
    this.patches.set(pk, record);
    let set = this.patchIdsByProject.get(projectId);
    if (!set) {
      set = new Set();
      this.patchIdsByProject.set(projectId, set);
    }
    set.add(patchId);
  }

  async readProjectFile(projectId: string, relativePath: string): Promise<string | null> {
    return this.files.get(this.fileKey(projectId, relativePath)) ?? null;
  }

  async writeProjectFile(projectId: string, relativePath: string, content: string): Promise<void> {
    this.files.set(this.fileKey(projectId, relativePath), content);
  }

  async listProjectFiles(projectId: string, directoryPrefix: string): Promise<string[]> {
    void projectId;
    void directoryPrefix;
    return [];
  }

  async readPatchProposal(projectId: string, patchId: string): Promise<PatchProposalRecord | null> {
    return this.patches.get(this.patchKey(projectId, patchId)) ?? null;
  }

  async writePatchProposal(projectId: string, patchId: string, record: PatchProposalRecord): Promise<void> {
    this.patches.set(this.patchKey(projectId, patchId), record);
    let set = this.patchIdsByProject.get(projectId);
    if (!set) {
      set = new Set();
      this.patchIdsByProject.set(projectId, set);
    }
    set.add(patchId);
  }

  async listPatchProposalIds(projectId: string): Promise<string[]> {
    const set = this.patchIdsByProject.get(projectId);
    if (!set) {
      return [];
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async readVerification(projectId: string, verificationId: string): Promise<string | null> {
    return this.verifications.get(`${projectId}\u0000${verificationId}`) ?? null;
  }

  async writeVerification(projectId: string, verificationId: string, payload: string): Promise<void> {
    this.verifications.set(`${projectId}\u0000${verificationId}`, payload);
  }

  async readProjectMeta(projectId: string): Promise<string | null> {
    return this.metaByProject.get(projectId) ?? null;
  }

  async writeProjectMeta(projectId: string, metaJson: string): Promise<void> {
    this.metaByProject.set(projectId, metaJson);
  }
}
