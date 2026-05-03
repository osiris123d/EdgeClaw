import { createR2ArtifactPromotionWriter } from "../promotion/artifactPromotionR2";
import {
  createPromotionArtifactVerifiedPreviewDeployAdapter,
  type PromotionArtifactVerifiedPreviewDeployAdapterOptions,
} from "./previewDeployPromotionVerified";
import type { PreviewDeployAdapter } from "./previewDeployTypes";

export interface R2VerifiedPreviewDeployAdapterOptions extends PromotionArtifactVerifiedPreviewDeployAdapterOptions {
  bucket: R2Bucket;
  /** Must match {@link resolveArtifactPromotionWriter} / wrangler `bucket_name`. */
  bucketDisplayName: string;
}

/**
 * COMPATIBILITY: thin wrapper for tests — builds an R2-only writer then {@link createPromotionArtifactVerifiedPreviewDeployAdapter}.
 * Production uses {@link resolvePreviewDeployAdapter} + {@link resolveArtifactPromotionWriter}.
 */
export function createR2VerifiedPreviewDeployAdapter(options: R2VerifiedPreviewDeployAdapterOptions): PreviewDeployAdapter {
  const { bucket, bucketDisplayName, ...rest } = options;
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName });
  return createPromotionArtifactVerifiedPreviewDeployAdapter(writer, rest);
}
