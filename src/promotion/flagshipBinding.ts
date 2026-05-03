/**
 * Cloudflare Flagship **Workers binding** adapter — evaluates a string flag as release outcome (`allow` | `deny` | `hold`).
 *
 * Maps {@link FlagshipEvaluationContext} (promotion manifest context) into Flagship targeting attributes
 * (`Record<string, string | number | boolean>` — see Workers `FlagshipEvaluationContext`).
 *
 * **Contract:** Configure a **string** flag (see `outcomeFlagKey`) whose value is exactly `allow`, `deny`, or `hold`
 * (case-insensitive). Evaluation errors (`errorCode` on details) fail **closed** with `outcome: deny`.
 *
 * **Deferred:** Optional JSON object flag for structured audit reasons; tier-specific flag keys; multi-flag voting.
 */

import type {
  FlagshipEvaluationAdapter,
  FlagshipEvaluationContext as PromotionEvaluationContext,
  ReleaseGateAuditReason,
  ReleaseGateDecision,
  ReleaseGateOutcome,
  ReleaseTier,
} from "./flagshipTypes";

/** Maps promotion evaluation context → Workers Flagship targeting attributes (primitive values only). */
export function toFlagshipTargetingAttributes(
  ctx: PromotionEvaluationContext
): Record<string, string | number | boolean> {
  const o: Record<string, string | number | boolean> = {
    projectId: ctx.projectId,
    bundleId: ctx.bundleId,
    tier: ctx.tier,
  };
  if (ctx.manifestDigest?.trim()) {
    o.manifestDigest = ctx.manifestDigest.trim();
  }
  if (ctx.correlationId?.trim()) {
    o.correlationId = ctx.correlationId.trim();
  }
  const refs = ctx.verificationRefs?.filter((x) => typeof x === "string" && x.trim());
  if (refs && refs.length > 0) {
    o.verificationRefs = refs.join(",");
  }
  return o;
}

export function normalizeBindingOutcomeString(raw: string): ReleaseGateOutcome | null {
  const s = raw.trim().toLowerCase();
  if (s === "allow" || s === "deny" || s === "hold") {
    return s;
  }
  return null;
}

export interface BindingFlagshipEvaluationAdapterOptions {
  /** Flag key in Flagship whose **string** value is allow | deny | hold. */
  outcomeFlagKey: string;
  /**
   * Default returned by `getStringDetails` when the flag is missing / evaluation falls back (default `hold`).
   */
  defaultOutcomeString?: string;
}

function auditReasonsFromDetails(params: {
  outcomeFlagKey: string;
  tier: ReleaseTier;
  details: FlagshipEvaluationDetails<string>;
  outcome: ReleaseGateOutcome;
  unrecognizedValue?: boolean;
}): ReleaseGateAuditReason[] {
  const { outcomeFlagKey, tier, details, outcome, unrecognizedValue } = params;
  const detail: Record<string, string> = {
    flagKey: details.flagKey,
    evaluatedTier: tier,
    flagshipReason: details.reason ?? "",
    variant: details.variant ?? "",
    outcome,
  };
  let message =
    details.reason ??
    details.variant ??
    `Flagship string flag "${outcomeFlagKey}" evaluated to "${details.value}"`;
  if (unrecognizedValue) {
    message = `Unrecognized outcome "${details.value}" — normalized to ${outcome}`;
  }
  return [
    {
      code: unrecognizedValue ? "FLAGSHIP_BINDING_UNKNOWN_VALUE" : "FLAGSHIP_BINDING",
      message,
      detail,
    },
  ];
}

export function createBindingFlagshipEvaluationAdapter(
  binding: Flagship,
  options: BindingFlagshipEvaluationAdapterOptions
): FlagshipEvaluationAdapter {
  const outcomeFlagKey = options.outcomeFlagKey.trim();
  const defaultStr = options.defaultOutcomeString ?? "hold";

  return {
    async evaluate(context: PromotionEvaluationContext): Promise<ReleaseGateDecision> {
      const tier = context.tier;
      const targeting = toFlagshipTargetingAttributes(context);
      const details = await binding.getStringDetails(outcomeFlagKey, defaultStr, targeting);

      if (details.errorCode) {
        return {
          outcome: "deny",
          allowed: false,
          tier,
          reasons: [
            {
              code: "FLAGSHIP_BINDING_ERROR",
              message: details.errorMessage ?? String(details.errorCode),
              detail: {
                errorCode: String(details.errorCode),
                flagKey: details.flagKey,
              },
            },
          ],
        };
      }

      const mapped = normalizeBindingOutcomeString(details.value);
      const unrecognized = mapped === null && details.value.trim() !== "";
      const outcome: ReleaseGateOutcome = mapped ?? "hold";
      const allowed = outcome === "allow";

      return {
        outcome,
        allowed,
        tier,
        reasons: auditReasonsFromDetails({
          outcomeFlagKey,
          tier,
          details,
          outcome,
          unrecognizedValue: unrecognized || undefined,
        }),
      };
    },
  };
}
