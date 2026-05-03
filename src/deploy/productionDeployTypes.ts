/**
 * **Production-only** deployment seam — strictly separate from {@link PreviewDeployAdapter} / `previewDeployTypes.ts`.
 *
 * **Boundary:** Only MainAgent (orchestrator) should call {@link ProductionDeployAdapter} or {@link runProductionDeployment}.
 * CoderAgent / TesterAgent / coding loop must not import this module.
 *
 * **Execution:** Prefer **`EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW`** + {@link launchProductionDeployWorkflow} for durable retries;
 * synchronous {@link executeProductionDeployment} exists for tests and narrow call sites.
 */

import type { PromotionArtifactManifest, PromotionArtifactRef } from "../promotion/artifactPromotionTypes";
import type { ReleaseGateAuditReason, ReleaseGateDecision, ReleaseTier } from "../promotion/flagshipTypes";

/** Production path accepts **production** tier only (not preview / canary). */
export type ProductionDeployTier = Extract<ReleaseTier, "production">;

export type ProductionDeployStatus = "succeeded" | "blocked" | "failed";

export type ProductionDeployFailureCategory =
  | "precheck_failed"
  | "approval_policy_failed"
  | "adapter_error"
  | "policy_blocked";

/** Human or automated approver attestation — distinct `approverId` values count toward policy minimums. */
export interface ProductionApprovalAttestation {
  approverId: string;
  /** ISO-8601 */
  approvedAt: string;
  /** e.g. `release_manager`, `security`, `on_call` */
  role?: string;
}

export interface ProductionDeployAuditRecord {
  projectId: string;
  bundleId: string;
  manifestDigest?: string;
  gateOutcome: ReleaseGateDecision["outcome"];
  gateTier: ReleaseTier;
  correlationId?: string;
  /** Count of distinct approver ids supplied on the request */
  distinctApproverCount?: number;
  changeTicketId?: string;
  adapterBackend?: string;
  /** From {@link PromotionArtifactRef.storageBackend} after verified read */
  artifactStorageBackend?: string;
  /** Cloudflare GET script-settings witness (optional) */
  cloudflareWitness?: "ok" | "failed";
  cloudflareScriptTags?: string;
}

export interface ProductionDeployResult {
  status: ProductionDeployStatus;
  /** Live production URL / hostname after deploy (Workers custom host, Pages production branch, etc.) */
  productionDeploymentUrl?: string;
  /** Opaque deployment / version id from the backend */
  productionIdentifier?: string;
  /** Prior stable version or route target — for rollback automation */
  previousStableIdentifier?: string;
  /** Operator-facing rollback guidance when adapter cannot automate */
  rollbackHint?: string;
  audit: ProductionDeployAuditRecord;
  failureCategory?: ProductionDeployFailureCategory;
  blockReasons?: readonly ReleaseGateAuditReason[];
  error?: string;
}

/**
 * Inputs after promotion artifact write + **production** release gate allow + explicit approvals.
 */
export interface ProductionDeployRequest {
  projectId: string;
  bundleRef: PromotionArtifactRef;
  manifest: PromotionArtifactManifest;
  /** Must reflect a production-tier evaluation with outcome allow — enforced in orchestrator */
  releaseGateDecision: ReleaseGateDecision;
  /** Must be `"production"` — enforced in orchestrator */
  requestedTier: ProductionDeployTier;
  artifactWritten: boolean;
  /**
   * Multi-party approvals — orchestrator requires at least `PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS`
   * distinct non-empty `approverId` values (see `productionDeployPolicy.ts`).
   */
  productionApprovals: readonly ProductionApprovalAttestation[];
  correlationId?: string;
  /** CAB / ticket id — recommended for audit; optional for noop adapter */
  changeTicketId?: string;
  sourceMetadata?: {
    branch?: string;
    commitSha?: string;
    repository?: string;
  };
}

/**
 * Backend for **production** rollout — never mixed with {@link PreviewDeployAdapter}.
 * Implementations: noop (`productionDeployNoop.ts`), promotion-verified (`productionDeployPromotionVerified.ts`),
 * optional Cloudflare witness (`productionDeployCloudflareWitness.ts`).
 */
export interface ProductionDeployAdapter {
  deploy(request: ProductionDeployRequest): Promise<ProductionDeployResult>;
}
