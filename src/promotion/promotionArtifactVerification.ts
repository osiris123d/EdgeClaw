import type { PromotionArtifactManifest, PromotionArtifactRef } from "./artifactPromotionTypes";
import { computePromotionManifestDigest } from "./promotionManifestCanonical";

/** Bundle id alignment — catches swapped refs before hitting storage policy. */
export function promotionBundleIdsMatch(ref: PromotionArtifactRef, manifest: PromotionArtifactManifest): boolean {
  return ref.bundleId === manifest.bundleId;
}

/**
 * True when re-computed digest matches `expectedDigestHex` (case-insensitive hex compare).
 */
export async function promotionManifestMatchesDigest(
  manifest: PromotionArtifactManifest,
  expectedDigestHex: string
): Promise<boolean> {
  const d = await computePromotionManifestDigest(manifest);
  return d.toLowerCase() === expectedDigestHex.trim().toLowerCase();
}
