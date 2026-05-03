/**
 * Promotion-time Artifacts seam — immutable bundle manifests (R2, Cloudflare Artifacts git, or noop; see `artifactPromotionWriterFactory`).
 * Collaboration stays on SharedWorkspaceGateway + KV adapter until explicitly migrated.
 *
 * **Boundary:** Only orchestrator code (e.g. MainAgent) should construct manifests and call
 * {@link ArtifactPromotionWriter}. CoderAgent / TesterAgent must not import this module for writes.
 *
 * See `integrationDeferred.ts` for preview-deploy wiring (deferred).
 */

export type PromotionManifestSchemaVersion = "edgeclaw-promotion-v1";

/** Identifies where an immutable manifest blob was stored (audit / tooling). */
export type PromotionArtifactStorageBackend =
  | "noop"
  | "r2"
  | "workers-artifacts"
  | "kv"
  | "unknown";

/** Optional audit metadata carried inside the manifest JSON (included in digest when present). */
export interface PromotionBundleMetadata {
  /** Correlation ids (orchestrator request id, CI job id, workflow run id). */
  correlationIds?: readonly string[];
  /** Stable key/value labels for dashboards — prefer deterministic keys for repeatable digests. */
  labels?: Readonly<Record<string, string>>;
}

/**
 * Handle returned after persisting an immutable manifest snapshot.
 * Real backends should populate `manifestDigest`, `storageBackend`, and `writtenAt` when known.
 */
export interface PromotionArtifactRef {
  bundleId: string;
  /** e.g. `r2://bucket/key`, Workers Artifacts URI, or opaque key */
  storageUri?: string;
  /** Hex SHA-256 of canonical manifest JSON — see `promotionManifestCanonical.ts` */
  manifestDigest?: string;
  /** ISO timestamp when the blob became durable (optional until writer supports it). */
  writtenAt?: string;
  storageBackend?: PromotionArtifactStorageBackend;
  /** Object generation / ETag from blob store — optional version witness */
  objectVersion?: string;
}

export interface PromotionArtifactManifest {
  schemaVersion: PromotionManifestSchemaVersion;
  bundleId: string;
  projectId: string;
  createdAt: string;
  /** Patch ids included — each MUST be `approved` at preparation time (see orchestration helper). */
  patchIds: readonly string[];
  /** SHA-256 hex of patch bodies at snapshot time (optional audit trail). */
  patchContentDigests?: Record<string, string>;
  /** Optional links to shared_workspace verification blobs or external CI ids */
  verificationRefs?: readonly string[];
  /** Optional bundle-level audit metadata (digested when present). */
  bundleMetadata?: PromotionBundleMetadata;
}

/**
 * Writes immutable promotion manifests (append-only blob + stable digest).
 * Replace noop with R2 / Workers Artifacts / Workflow sink when wired.
 */
export interface ArtifactPromotionWriter {
  writeManifest(manifest: PromotionArtifactManifest): Promise<PromotionArtifactRef>;
  /**
   * Optional read-back for verification / promotion pipelines.
   * Prefer addressing by full ref (storageUri + digest), not bundleId alone.
   */
  readManifest?(ref: PromotionArtifactRef): Promise<PromotionArtifactManifest | null>;
}
