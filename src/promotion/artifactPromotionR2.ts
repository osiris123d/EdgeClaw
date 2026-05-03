import type {
  ArtifactPromotionWriter,
  PromotionArtifactManifest,
  PromotionArtifactRef,
} from "./artifactPromotionTypes";
import {
  canonicalPromotionManifestPayload,
  computePromotionManifestDigest,
} from "./promotionManifestCanonical";

/** Stable object key — immutable per bundle (bundleId is unique per manifest preparation). */
export function buildPromotionManifestR2ObjectKey(projectId: string, bundleId: string): string {
  const safeProject = encodeURIComponent(projectId.trim());
  const safeBundle = encodeURIComponent(bundleId.trim());
  return `promotion/manifests/v1/projects/${safeProject}/bundles/${safeBundle}.json`;
}

/**
 * `storageUri` shape for R2 refs — bucket display name must match wrangler `bucket_name`.
 * Key segment uses encodeURIComponent so slashes in encoded path remain unambiguous.
 */
export function buildPromotionR2StorageUri(bucketDisplayName: string, objectKey: string): string {
  return `r2://${bucketDisplayName}/${encodeURIComponent(objectKey)}`;
}

export function parsePromotionR2StorageUri(
  uri: string,
  expectedBucketDisplayName: string
): { objectKey: string } | null {
  const prefix = `r2://${expectedBucketDisplayName}/`;
  if (!uri.startsWith(prefix)) {
    return null;
  }
  const encoded = uri.slice(prefix.length);
  try {
    return { objectKey: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

function isPromotionArtifactManifest(value: unknown): value is PromotionArtifactManifest {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.schemaVersion === "edgeclaw-promotion-v1" &&
    typeof o.bundleId === "string" &&
    typeof o.projectId === "string" &&
    typeof o.createdAt === "string" &&
    Array.isArray(o.patchIds)
  );
}

/**
 * Immutable promotion manifests stored as canonical JSON bytes (digest-aligned).
 */
export function createR2ArtifactPromotionWriter(
  bucket: R2Bucket,
  options: { bucketDisplayName: string }
): ArtifactPromotionWriter {
  const { bucketDisplayName } = options;

  return {
    async writeManifest(manifest: PromotionArtifactManifest): Promise<PromotionArtifactRef> {
      const payload = canonicalPromotionManifestPayload(manifest);
      const bodyText = JSON.stringify(payload);
      const manifestDigest = await computePromotionManifestDigest(manifest);

      const objectKey = buildPromotionManifestR2ObjectKey(manifest.projectId, manifest.bundleId);
      const put = await bucket.put(objectKey, bodyText, {
        httpMetadata: {
          contentType: "application/json",
          cacheControl: "immutable, max-age=31536000",
        },
      });

      const storageUri = buildPromotionR2StorageUri(bucketDisplayName, objectKey);

      return {
        bundleId: manifest.bundleId,
        storageUri,
        manifestDigest,
        writtenAt: new Date().toISOString(),
        storageBackend: "r2",
        objectVersion: put?.httpEtag ?? put?.etag,
      };
    },

    async readManifest(ref: PromotionArtifactRef): Promise<PromotionArtifactManifest | null> {
      const parsed = parsePromotionR2StorageUri(ref.storageUri ?? "", bucketDisplayName);
      if (!parsed) {
        return null;
      }
      const obj = await bucket.get(parsed.objectKey);
      if (!obj) {
        return null;
      }
      const text = await obj.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isPromotionArtifactManifest(raw)) {
        return null;
      }
      const manifest = raw;
      if (manifest.bundleId !== ref.bundleId) {
        return null;
      }
      const digest = await computePromotionManifestDigest(manifest);
      if (ref.manifestDigest) {
        if (digest.toLowerCase() !== ref.manifestDigest.trim().toLowerCase()) {
          return null;
        }
      }
      return manifest;
    },
  };
}
