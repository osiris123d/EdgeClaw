import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "./previewDeployTypes";
import type { ReleaseGateAuditReason } from "../promotion/flagshipTypes";
import { promotionBundleIdsMatch, promotionManifestMatchesDigest } from "../promotion/promotionArtifactVerification";

function auditBase(request: PreviewDeployRequest): PreviewDeployResult["audit"] {
  return {
    projectId: request.projectId,
    bundleId: request.manifest.bundleId,
    manifestDigest: request.bundleRef.manifestDigest,
    gateOutcome: request.releaseGateDecision.outcome,
    gateTier: request.releaseGateDecision.tier,
    correlationId: request.correlationId,
  };
}

function blocked(
  request: PreviewDeployRequest,
  reasons: readonly ReleaseGateAuditReason[]
): PreviewDeployResult {
  return {
    status: "blocked",
    audit: auditBase(request),
    failureCategory: "precheck_failed",
    blockReasons: reasons,
  };
}

/**
 * Orchestrator-only preview deploy: validates post-gate preconditions, then invokes {@link PreviewDeployAdapter}.
 * MainAgent should call this — keeps logic testable without importing MainAgent.
 */
export async function runPreviewDeployment(
  adapter: PreviewDeployAdapter,
  request: PreviewDeployRequest
): Promise<PreviewDeployResult> {
  if (request.requestedTier !== "preview") {
    return blocked(request, [
      {
        code: "PREVIEW_TIER_REQUIRED",
        message: `requestedTier must be "preview" for this seam (got ${request.requestedTier})`,
      },
    ]);
  }

  if (request.releaseGateDecision.outcome === "hold") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_HOLD",
        message: "Release gate outcome hold blocks preview deploy until resolved",
      },
    ]);
  }

  if (request.releaseGateDecision.outcome !== "allow") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_NOT_ALLOW",
        message: `Release gate outcome must be "allow" (got ${request.releaseGateDecision.outcome})`,
      },
    ]);
  }

  if (request.releaseGateDecision.tier !== "preview") {
    return blocked(request, [
      {
        code: "RELEASE_GATE_TIER_NOT_PREVIEW",
        message: `Release gate tier must be "preview" for preview deploy (got ${request.releaseGateDecision.tier})`,
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
