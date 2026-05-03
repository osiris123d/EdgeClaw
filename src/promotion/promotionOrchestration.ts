import type { SharedWorkspaceGateway } from "../workspace/sharedWorkspaceTypes";
import type { PromotionArtifactManifest } from "./artifactPromotionTypes";

export type PrepareApprovedPromotionResult =
  | { ok: true; manifest: PromotionArtifactManifest }
  | { ok: false; error: string };

/**
 * Build a promotion manifest only from patches whose lifecycle status is `approved`.
 * Does not write Artifacts — call ArtifactPromotionWriter.writeManifest after this succeeds.
 */
export async function buildPromotionManifestFromApprovedPatches(
  gateway: SharedWorkspaceGateway,
  projectId: string,
  patchIds: readonly string[],
  options?: { verificationRefs?: readonly string[] }
): Promise<PrepareApprovedPromotionResult> {
  if (patchIds.length === 0) {
    return { ok: false, error: "patchIds must be non-empty" };
  }

  const patchContentDigests: Record<string, string> = {};
  for (const patchId of patchIds) {
    const result = await gateway.getPatchProposal("orchestrator", projectId, patchId);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    if (result.record.status !== "approved") {
      return {
        ok: false,
        error: `patch ${patchId} has status ${result.record.status}; require approved before promotion`,
      };
    }
    patchContentDigests[patchId] = await sha256Hex(result.record.body);
  }

  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: crypto.randomUUID(),
    projectId,
    createdAt: new Date().toISOString(),
    patchIds: [...patchIds],
    patchContentDigests,
    verificationRefs: options?.verificationRefs?.length ? [...options.verificationRefs] : undefined,
  };

  return { ok: true, manifest };
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
