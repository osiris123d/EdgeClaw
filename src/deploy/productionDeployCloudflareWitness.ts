import {
  fetchWorkerScriptSettingsWitness,
  type CloudflareScriptSettingsWitnessOptions,
} from "./cloudflareScriptSettingsWitness";
import type {
  ProductionDeployAdapter,
  ProductionDeployRequest,
  ProductionDeployResult,
} from "./productionDeployTypes";

export type { CloudflareScriptSettingsWitnessOptions };

/**
 * Wraps a **production** adapter. After inner **success**, GET script-settings as an audit witness.
 * Failures become `failed` / `adapter_error` with `audit.cloudflareWitness: "failed"`.
 */
export function createCloudflareScriptSettingsWitnessProductionDeployAdapter(
  inner: ProductionDeployAdapter,
  witness: CloudflareScriptSettingsWitnessOptions
): ProductionDeployAdapter {
  return {
    async deploy(request: ProductionDeployRequest): Promise<ProductionDeployResult> {
      const innerResult = await inner.deploy(request);
      if (innerResult.status !== "succeeded") {
        return innerResult;
      }

      const w = await fetchWorkerScriptSettingsWitness(witness);
      if (!w.ok) {
        return {
          status: "failed",
          failureCategory: "adapter_error",
          audit: {
            ...innerResult.audit,
            cloudflareWitness: "failed",
          },
          error: w.error,
          productionDeploymentUrl: innerResult.productionDeploymentUrl,
          productionIdentifier: innerResult.productionIdentifier,
          rollbackHint: innerResult.rollbackHint,
          previousStableIdentifier: innerResult.previousStableIdentifier,
        };
      }

      const tagSuffix = w.tagsJoined ? `:tags=${w.tagsJoined}` : "";
      const productionIdentifier = `${innerResult.productionIdentifier ?? request.bundleRef.manifestDigest ?? ""}|cf_script_settings${tagSuffix}`;

      return {
        ...innerResult,
        productionIdentifier,
        audit: {
          ...innerResult.audit,
          adapterBackend: `${innerResult.audit.adapterBackend ?? "promotion_verified_production"}+cf_script_settings`,
          cloudflareWitness: "ok",
          cloudflareScriptTags: w.tagsJoined || undefined,
        },
      };
    },
  };
}
