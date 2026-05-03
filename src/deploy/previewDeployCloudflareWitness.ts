import {
  fetchWorkerScriptSettingsWitness,
  type CloudflareScriptSettingsWitnessOptions,
} from "./cloudflareScriptSettingsWitness";
import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "./previewDeployTypes";

export type { CloudflareScriptSettingsWitnessOptions };
export { fetchWorkerScriptSettingsWitness };

/**
 * Wraps a preview adapter (typically promotion-verified). After inner **success**, calls Cloudflare script-settings;
 * failure downgrades to `failed` / `adapter_error` so operators can distinguish API/token issues from policy blocks.
 */
export function createCloudflareScriptSettingsWitnessPreviewDeployAdapter(
  inner: PreviewDeployAdapter,
  witness: CloudflareScriptSettingsWitnessOptions
): PreviewDeployAdapter {
  return {
    async deploy(request: PreviewDeployRequest): Promise<PreviewDeployResult> {
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
          previewUrl: innerResult.previewUrl,
          previewIdentifier: innerResult.previewIdentifier,
        };
      }

      const tagSuffix = w.tagsJoined ? `:tags=${w.tagsJoined}` : "";
      const previewIdentifier = `${innerResult.previewIdentifier ?? request.bundleRef.manifestDigest ?? ""}|cf_script_settings${tagSuffix}`;

      return {
        ...innerResult,
        previewIdentifier,
        audit: {
          ...innerResult.audit,
          adapterBackend: `${innerResult.audit.adapterBackend ?? "promotion_verified"}+cf_script_settings`,
          cloudflareWitness: "ok",
          cloudflareScriptTags: w.tagsJoined || undefined,
        },
      };
    },
  };
}
