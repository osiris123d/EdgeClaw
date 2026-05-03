/**
 * Flagship / release-gating seam — orchestrator evaluates **after** promotion bundle + digest verification,
 * **before** preview or production deploy. Not used by the coding loop.
 *
 * **Boundary:** Only MainAgent (orchestrator) should call {@link FlagshipEvaluationAdapter}.
 * CoderAgent / TesterAgent must not import this module.
 *
 * **Implementations:** `flagshipNoop.ts`, `flagshipHttp.ts`, `flagshipBinding.ts`, `flagshipEvaluationAdapterFactory.ts`.
 * OpenFeature or service bindings can wrap the same interface later.
 */

export type ReleaseTier = "preview" | "canary" | "production";

/** Policy outcome — use `hold` when automation should pause for human review without denying outright. */
export type ReleaseGateOutcome = "allow" | "deny" | "hold";

/** Structured audit reason suitable for logs / ticketing (avoid free-form only). */
export interface ReleaseGateAuditReason {
  code: string;
  message: string;
  detail?: Readonly<Record<string, string>>;
}

export interface ReleaseGateDecision {
  outcome: ReleaseGateOutcome;
  /** Convenience flag — must equal `outcome === "allow"` */
  allowed: boolean;
  tier: ReleaseTier;
  reasons: readonly ReleaseGateAuditReason[];
}

export interface FlagshipEvaluationContext {
  projectId: string;
  bundleId: string;
  tier: ReleaseTier;
  /** Digest from PromotionArtifactRef when available */
  manifestDigest?: string;
  verificationRefs?: readonly string[];
  /** Optional orchestrator correlation id for downstream audit */
  correlationId?: string;
}

/** Replace noop with HTTP (`flagshipHttp.ts`) or another policy backend when configured. */
export interface FlagshipEvaluationAdapter {
  evaluate(context: FlagshipEvaluationContext): Promise<ReleaseGateDecision>;
}
