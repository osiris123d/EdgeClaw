import type {
  ProductionDeployAdapter,
  ProductionDeployRequest,
  ProductionDeployResult,
} from "./productionDeployTypes";
import type { ReleaseGateAuditReason } from "../promotion/flagshipTypes";
import { PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS } from "./productionDeployPolicy";
import { promotionBundleIdsMatch, promotionManifestMatchesDigest } from "../promotion/promotionArtifactVerification";

function auditBase(request: ProductionDeployRequest): ProductionDeployResult["audit"] {
  const ids = distinctApproverIds(request.productionApprovals);
  return {
    projectId: request.projectId,
    bundleId: request.manifest.bundleId,
    manifestDigest: request.bundleRef.manifestDigest,
    gateOutcome: request.releaseGateDecision.outcome,
    gateTier: request.releaseGateDecision.tier,
    correlationId: request.correlationId,
    distinctApproverCount: ids.length,
    changeTicketId: request.changeTicketId,
  };
}

function distinctApproverIds(
  approvals: ProductionDeployRequest["productionApprovals"]
): readonly string[] {
  const set = new Set<string>();
  for (const a of approvals) {
    const id = typeof a.approverId === "string" ? a.approverId.trim() : "";
    if (id) {
      set.add(id);
    }
  }
  return [...set];
}

function blocked(
  request: ProductionDeployRequest,
  reasons: readonly ReleaseGateAuditReason[]
): ProductionDeployResult {
  return {
    status: "blocked",
    audit: auditBase(request),
    failureCategory: "precheck_failed",
    blockReasons: reasons,
  };
}

function approvalBlocked(
  request: ProductionDeployRequest,
  reasons: readonly ReleaseGateAuditReason[]
): ProductionDeployResult {
  return {
    status: "blocked",
    audit: auditBase(request),
    failureCategory: "approval_policy_failed",
    blockReasons: reasons,
  };
}

/**
 * Orchestrator-only production deploy: stronger prechecks than preview, then {@link ProductionDeployAdapter}.
 */
export async function runProductionDeployment(
  adapter: ProductionDeployAdapter,
  request: ProductionDeployRequest
): Promise<ProductionDeployResult> {
  if (request.requestedTier !== "production") {
    return blocked(request, [
      {
        code: "PRODUCTION_TIER_REQUIRED",
        message: `requestedTier must be "production" for this seam (got ${request.requestedTier})`,
      },
    ]);
  }

  if (request.releaseGateDecision.outcome === "hold") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_HOLD",
        message: "Release gate hold blocks production deploy until resolved",
      },
    ]);
  }

  if (request.releaseGateDecision.outcome !== "allow") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_NOT_ALLOW",
        message: `Release gate outcome must be "allow" for production (got ${request.releaseGateDecision.outcome})`,
      },
    ]);
  }

  if (request.releaseGateDecision.tier !== "production") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_TIER_NOT_PRODUCTION",
        message: `Release gate tier must be "production" for production deploy (got ${request.releaseGateDecision.tier})`,
      },
    ]);
  }

  const distinct = distinctApproverIds(request.productionApprovals);
  if (distinct.length < PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS) {
    return approvalBlocked(request, [
      {
        code: "INSUFFICIENT_PRODUCTION_APPROVALS",
        message: `Production deploy requires at least ${PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS} distinct approverId values (got ${distinct.length})`,
      },
    ]);
  }

  if (!request.artifactWritten) {
    return blocked(request, [
      {
        code: "ARTIFACT_NOT_RECORDED",
        message: "artifactWritten must be true after ArtifactPromotionWriter.writeManifest",
      },
    ]);
  }

  if (!promotionBundleIdsMatch(request.bundleRef, request.manifest)) {
    return blocked(request, [
      {
        code: "BUNDLE_ID_MISMATCH",
        message: "bundleRef.bundleId does not match manifest.bundleId",
      },
    ]);
  }

  const digest = request.bundleRef.manifestDigest?.trim();
  if (digest) {
    const ok = await promotionManifestMatchesDigest(request.manifest, digest);
    if (!ok) {
      return blocked(request, [
        {
          code: "MANIFEST_DIGEST_MISMATCH",
          message:
            "bundleRef.manifestDigest does not match canonical digest of the provided manifest",
        },
      ]);
    }
  }

  try {
    return await adapter.deploy(request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      audit: { ...auditBase(request), adapterBackend: undefined },
      failureCategory: "adapter_error",
      error: msg,
    };
  }
}
