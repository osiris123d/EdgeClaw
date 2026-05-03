import type { ProductionDeployAdapter, ProductionDeployRequest, ProductionDeployResult } from "./productionDeployTypes";

/** Safe default when `ENABLE_PRODUCTION_DEPLOY=false` or promotion persistence is missing — records `noop://production/…` (no manifest verification). */
export function createNoopProductionDeployAdapter(): ProductionDeployAdapter {
  return {
    async deploy(request: ProductionDeployRequest): Promise<ProductionDeployResult> {
      const bid = request.manifest.bundleId;
      return {
        status: "succeeded",
        productionDeploymentUrl: `noop://production/${encodeURIComponent(request.projectId)}/${encodeURIComponent(bid)}`,
        productionIdentifier: bid,
        rollbackHint:
          "Noop adapter — no Workers version change. Rollback is a no-op; real adapters should record previous version ids.",
        audit: {
          projectId: request.projectId,
          bundleId: bid,
          manifestDigest: request.bundleRef.manifestDigest,
          gateOutcome: request.releaseGateDecision.outcome,
          gateTier: request.releaseGateDecision.tier,
          correlationId: request.correlationId,
          distinctApproverCount: new Set(
            request.productionApprovals.map((a) => a.approverId.trim()).filter(Boolean)
          ).size,
          changeTicketId: request.changeTicketId,
          adapterBackend: "noop_production",
        },
      };
    },
  };
}
