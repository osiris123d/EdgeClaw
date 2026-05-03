import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "./previewDeployTypes";

/** Safe default when verified preview is off or promotion persistence is missing — records `noop://preview/…` (no manifest verification). */
export function createNoopPreviewDeployAdapter(): PreviewDeployAdapter {
  return {
    async deploy(request: PreviewDeployRequest): Promise<PreviewDeployResult> {
      const bid = request.manifest.bundleId;
      return {
        status: "succeeded",
        previewUrl: `noop://preview/${encodeURIComponent(request.projectId)}/${encodeURIComponent(bid)}`,
        previewIdentifier: bid,
        audit: {
          projectId: request.projectId,
          bundleId: bid,
          manifestDigest: request.bundleRef.manifestDigest,
          gateOutcome: request.releaseGateDecision.outcome,
          gateTier: request.releaseGateDecision.tier,
          correlationId: request.correlationId,
          adapterBackend: "noop",
        },
      };
    },
  };
}
