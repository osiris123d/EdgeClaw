import type {
  FlagshipEvaluationAdapter,
  FlagshipEvaluationContext,
  ReleaseGateDecision,
} from "./flagshipTypes";

/** Safe default — allows continuation in dev; swap for real Flagship when credentials/bindings exist. */
export function createNoopFlagshipEvaluationAdapter(): FlagshipEvaluationAdapter {
  return {
    async evaluate(context: FlagshipEvaluationContext): Promise<ReleaseGateDecision> {
      return {
        outcome: "allow",
        allowed: true,
        tier: context.tier,
        reasons: [
          {
            code: "FLAGSHIP_NOOP",
            message:
              "FlagshipEvaluationAdapter noop — configure real adapter for preview/canary/production policy.",
          },
        ],
      };
    },
  };
}
