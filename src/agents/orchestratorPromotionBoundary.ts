/**
 * Runtime guard for orchestrator-only APIs (promotion manifests/artifacts, Flagship release gate,
 * preview/production deploy adapters, durable promotion/deploy workflows).
 *
 * Subclasses of the orchestrator `MainAgent` class (CoderAgent, TesterAgent, …) must not invoke those paths —
 * they inherit TypeScript-visible methods but are blocked at runtime unless `constructor === MainAgent`.
 */

export function assertOrchestratorPromotionBoundary(
  agent: unknown,
  orchestratorCtor: new (...args: never[]) => unknown
): void {
  const ctor = (agent as { constructor?: unknown }).constructor;
  if (ctor !== orchestratorCtor) {
    throw new Error(
      "Orchestrator-only APIs (promotion, release gate, preview deploy, production deploy) are restricted to MainAgent (orchestrator)."
    );
  }
}
