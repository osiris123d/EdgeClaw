/**
 * Preview-only deployment seam — orchestrator invokes after promotion artifact write + release gate allow.
 *
 * **PromotionArtifactRef:** Real adapters should treat {@link PromotionArtifactRef} (`storageUri`,
 * `manifestDigest`, `storageBackend`) as the trust boundary — not `artifactWritten` alone.
 * The R2-verified adapter (`createR2VerifiedPreviewDeployAdapter` / `resolvePreviewDeployAdapter`) re-reads
 * manifests from the promotion bucket before reporting success.
 *
 * **Boundary:** Only MainAgent (orchestrator) should call {@link PreviewDeployAdapter}.
 * CoderAgent / TesterAgent / coding loop must not import this module.
 *
 * **Production** deploy is a separate seam (`productionDeployTypes.ts`, `orchestratorProductionDeploy.ts`) — do not merge adapters.
 */

import type { PromotionArtifactManifest, PromotionArtifactRef } from "../promotion/artifactPromotionTypes";
import type { ReleaseGateAuditReason, ReleaseGateDecision, ReleaseTier } from "../promotion/flagshipTypes";

/** Only `preview` is accepted by orchestrator prechecks in this phase. */
export type PreviewDeployTier = Extract<ReleaseTier, "preview">;

export type PreviewDeployStatus = "succeeded" | "blocked" | "failed";

/** Why a preview deploy did not complete successfully. */
export type PreviewDeployFailureCategory =
  | "precheck_failed"
  | "adapter_error"
  | "policy_blocked";

/** Immutable audit row suitable for logs / dashboards. */
export interface PreviewDeployAuditRecord {
  projectId: string;
  bundleId: string;
  manifestDigest?: string;
  gateOutcome: ReleaseGateDecision["outcome"];
  gateTier: ReleaseTier;
  correlationId?: string;
  /** e.g. `noop`, `promotion_verified`, `promotion_verified+workers_dev` */
  adapterBackend?: string;
  /** From {@link PromotionArtifactRef.storageBackend} after verified read */
  artifactStorageBackend?: string;
  /** Cloudflare GET script-settings witness (optional) */
  cloudflareWitness?: "ok" | "failed";
  cloudflareScriptTags?: string;
  /** Workers Versions API — script version id when real preview upload path runs */
  workersApiVersionId?: string;
  /** Cloudflare `metadata.hasPreview` from version create response (DO Workers are typically false) */
  workersVersionHasPreview?: boolean;
}

export interface PreviewDeployResult {
  status: PreviewDeployStatus;
  /** Human-consumable preview URL when succeeded (Workers preview, Pages preview, etc.) */
  previewUrl?: string;
  /** Opaque id from the deploy backend (deployment id, version id) */
  previewIdentifier?: string;
  audit: PreviewDeployAuditRecord;
  failureCategory?: PreviewDeployFailureCategory;
  /** Populated when status is `blocked` (prechecks) */
  blockReasons?: readonly ReleaseGateAuditReason[];
  /** Adapter-thrown or unexpected error message */
  error?: string;
}

/**
 * Complete inputs for a preview deploy attempt (after promotion + gate).
 * `artifactWritten` is a **compat attestation**; prefer threading the exact
 * `PromotionArtifactRef` returned from `buildPromotionArtifact` in `bundleRef` (with `storageUri` + `manifestDigest`) so
 * preview deploy can verify against R2/artifacts without relying on a boolean alone.
 */
export interface PreviewDeployRequest {
  projectId: string;
  bundleRef: PromotionArtifactRef;
  manifest: PromotionArtifactManifest;
  /** Last evaluated gate for **preview** tier — must be outcome allow */
  releaseGateDecision: ReleaseGateDecision;
  /** Must be `preview` for this seam */
  requestedTier: ReleaseTier;
  /**
   * Legacy witness flag — set true after `MainAgent.buildPromotionArtifact` succeeds.
   * Prefer supplying consistent `bundleRef`/`manifest` from that call; orchestrator prechecks still require this true unless tightened later.
   */
  artifactWritten: boolean;
  /** Optional lineage for future Wrangler/git-backed adapters */
  sourceMetadata?: {
    branch?: string;
    commitSha?: string;
    repository?: string;
  };
  correlationId?: string;
}

/**
 * Backend that performs preview deployment. Implementations include:
 * - **Promotion-verified** — `previewDeployPromotionVerified.ts` / factory (re-read manifest via `ArtifactPromotionWriter`; R2 or Artifacts).
 * - **noop** — `previewDeployNoop.ts` (safe default when no durable promotion storage).
 * - **Workers version upload** — `previewDeployCloudflareVersionUpload.ts` (multipart upload to a separate preview Worker when enabled).
 */
export interface PreviewDeployAdapter {
  deploy(request: PreviewDeployRequest): Promise<PreviewDeployResult>;
}
