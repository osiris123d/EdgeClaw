import type { PromotionArtifactManifest } from "./artifactPromotionTypes";

/**
 * Canonical JSON-shaped payload used for SHA-256 manifest digests (noop + real backends).
 * Field order and sorting are stable — **must stay aligned** with writers that verify integrity.
 */
export function canonicalPromotionManifestPayload(manifest: PromotionArtifactManifest): Record<string, unknown> {
  const refs = manifest.verificationRefs ?? [];
  const digestEntries = Object.entries(manifest.patchContentDigests ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const sortedDigests = Object.fromEntries(digestEntries);

  return {
    schemaVersion: manifest.schemaVersion,
    bundleId: manifest.bundleId,
    projectId: manifest.projectId,
    createdAt: manifest.createdAt,
    patchIds: [...manifest.patchIds].sort((x, y) => x.localeCompare(y)),
    patchContentDigests: sortedDigests,
    verificationRefs: [...refs].sort(),
    ...(manifest.bundleMetadata !== undefined
      ? {
          bundleMetadata: manifest.bundleMetadata,
        }
      : {}),
  };
}

/** SHA-256 hex digest of canonical manifest JSON (immutable-storage fingerprint). */
export async function computePromotionManifestDigest(manifest: PromotionArtifactManifest): Promise<string> {
  const canonical = JSON.stringify(canonicalPromotionManifestPayload(manifest));
  const data = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
