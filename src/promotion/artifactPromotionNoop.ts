import type {
  ArtifactPromotionWriter,
  PromotionArtifactManifest,
  PromotionArtifactRef,
} from "./artifactPromotionTypes";
import { computePromotionManifestDigest } from "./promotionManifestCanonical";

/** Placeholder until Cloudflare Artifacts (or R2) bindings exist — computes canonical digest + noop URI. */
export function createNoopArtifactPromotionWriter(): ArtifactPromotionWriter {
  return {
    async writeManifest(manifest: PromotionArtifactManifest): Promise<PromotionArtifactRef> {
      const manifestDigest = await computePromotionManifestDigest(manifest);
      return {
        bundleId: manifest.bundleId,
        storageUri: `noop://promotion/${encodeURIComponent(manifest.bundleId)}`,
        manifestDigest,
        storageBackend: "noop",
        writtenAt: new Date().toISOString(),
      };
    },
    async readManifest(_ref: PromotionArtifactRef): Promise<PromotionArtifactManifest | null> {
      void _ref;
      return null;
    },
  };
}
