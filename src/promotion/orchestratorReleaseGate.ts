import type { PromotionArtifactManifest, PromotionArtifactRef } from "./artifactPromotionTypes";
import type {
  FlagshipEvaluationAdapter,
  ReleaseGateDecision,
  ReleaseTier,
} from "./flagshipTypes";
import { promotionBundleIdsMatch, promotionManifestMatchesDigest } from "./promotionArtifactVerification";

/**
 * Orchestrator-only release gate: verifies refs against manifest, then delegates policy to Flagship adapter.
 * MainAgent calls this so verification logic stays testable without importing MainAgent.
 *
 * Optional `correlationId` is forwarded to {@link FlagshipEvaluationAdapter.evaluate}.
 */
export async function evaluatePromotionReleaseGate(
  flagship: FlagshipEvaluationAdapter,
  params: {
    projectId: string;
    tier: ReleaseTier;
    bundleRef: PromotionArtifactRef;
    manifest: PromotionArtifactManifest;
    verificationRefs?: readonly string[];
    correlationId?: string;
  }
): Promise<ReleaseGateDecision> {
  if (!promotionBundleIdsMatch(params.bundleRef, params.manifest)) {
    return {
      outcome: "deny",
      allowed: false,
      tier: params.tier,
      reasons: [
        {
          code: "BUNDLE_ID_MISMATCH",
          message: "bundleRef.bundleId does not match manifest.bundleId",
        },
      ],
    };
  }
  const digest = params.bundleRef.manifestDigest?.trim();
  if (digest) {
    const digestOk = await promotionManifestMatchesDigest(params.manifest, digest);
    if (!digestOk) {
      return {
        outcome: "deny",
        allowed: false,
        tier: params.tier,
        reasons: [
          {
            code: "MANIFEST_DIGEST_MISMATCH",
            message:
              "PromotionArtifactRef.manifestDigest does not match canonical digest of the provided manifest",
          },
        ],
      };
    }
  }
  return flagship.evaluate({
    projectId: params.projectId,
    bundleId: params.manifest.bundleId,
    tier: params.tier,
    manifestDigest: params.bundleRef.manifestDigest,
    verificationRefs: params.verificationRefs ?? params.manifest.verificationRefs,
    correlationId: params.correlationId,
  });
}
