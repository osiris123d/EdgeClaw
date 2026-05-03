/**
 * Wrangler — extension points only (no secrets, no deploy in this module).
 *
 * TODO(wrangler-preview): Model preview deploy as orchestrator-only tool calling a bound service
 *   (e.g. `Fetcher` to an internal deploy worker) with non-production credentials.
 * TODO(wrangler-production): Separate code path + human/orchestrator approval token; never expose to CoderAgent/TesterAgent.
 * TODO(workflow): Move long-running `wrangler deploy` into a Workflow step with approval checkpoint.
 *
 * Do not import wrangler CLI here — Workers cannot shell out. Integrations go through MCP or HTTP adapters.
 */

export type WranglerDeployTier = "preview" | "production";

/** Future: passed to an approved deploy adapter after MainAgent confirmation */
export interface WranglerDeployIntentPlaceholder {
  tier: WranglerDeployTier;
  /** Always true for production tier in production accounts */
  requiresOrchestratorApproval: true;
  /** Human-readable reason for audit logs */
  rationale?: string;
}
