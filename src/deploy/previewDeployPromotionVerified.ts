import type { ArtifactPromotionWriter } from "../promotion/artifactPromotionTypes";
import { computePromotionManifestDigest } from "../promotion/promotionManifestCanonical";
import { buildWorkersDevUrl, fetchWorkersAccountSubdomain } from "./cloudflareWorkersSubdomain";
import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "./previewDeployTypes";

function auditFrom(request: PreviewDeployRequest, adapterBackend: string): PreviewDeployResult["audit"] {
  return {
    projectId: request.projectId,
    bundleId: request.manifest.bundleId,
    manifestDigest: request.bundleRef.manifestDigest,
    gateOutcome: request.releaseGateDecision.outcome,
    gateTier: request.releaseGateDecision.tier,
    correlationId: request.correlationId,
    adapterBackend,
    artifactStorageBackend: request.bundleRef.storageBackend,
  };
}

export interface PromotionArtifactVerifiedPreviewDeployAdapterOptions {
  /** If set, used as `previewUrl` (skips Cloudflare API subdomain lookup). */
  canonicalPreviewUrl?: string;
  workerScriptName?: string;
  accountId?: string;
  apiToken?: string;
  fetchFn?: typeof fetch;
}

/**
 * Verifies {@link PromotionArtifactRef} by re-reading the durable manifest via {@link ArtifactPromotionWriter.readManifest}
 * (works for R2, Cloudflare Artifacts git backend, etc. depending on `resolveArtifactPromotionWriter`).
 *
 * Does **not** upload a new Worker bundle — optional {@link createCloudflareScriptSettingsWitnessPreviewDeployAdapter}
 * adds a live Cloudflare API witness instead.
 */
export function createPromotionArtifactVerifiedPreviewDeployAdapter(
  writer: ArtifactPromotionWriter,
  options: PromotionArtifactVerifiedPreviewDeployAdapterOptions = {}
): PreviewDeployAdapter {
  const {
    canonicalPreviewUrl,
    workerScriptName = "edgeclaw-truth-agent",
    accountId,
    apiToken,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = options;

  return {
    async deploy(request: PreviewDeployRequest): Promise<PreviewDeployResult> {
      const ref = request.bundleRef;
      const backend = "promotion_verified";

      if (!ref.manifestDigest?.trim() || !ref.storageUri?.trim()) {
        return {
          status: "failed",
          failureCategory: "policy_blocked",
          audit: auditFrom(request, backend),
          error:
            "PromotionArtifactRef.storageUri and manifestDigest are required for verified preview deploy",
        };
      }

      if (!writer.readManifest) {
        return {
          status: "failed",
          failureCategory: "adapter_error",
          audit: auditFrom(request, backend),
          error: "ArtifactPromotionWriter.readManifest is not implemented for this promotion backend",
        };
      }

      const loaded = await writer.readManifest(ref);
      if (!loaded) {
        return {
          status: "failed",
          failureCategory: "policy_blocked",
          audit: auditFrom(request, backend),
          error:
            "Failed to read promotion manifest using bundleRef (missing object, URI mismatch, or digest mismatch)",
        };
      }

      const dLoaded = await computePromotionManifestDigest(loaded);
      const dReq = await computePromotionManifestDigest(request.manifest);
      if (dLoaded !== dReq) {
        return {
          status: "failed",
          failureCategory: "policy_blocked",
          audit: auditFrom(request, backend),
          error: "Durable manifest bytes do not match the manifest on this preview deploy request",
        };
      }

      let previewUrl: string | undefined;
      const trimmedCanonical = canonicalPreviewUrl?.trim();
      if (trimmedCanonical) {
        previewUrl = trimmedCanonical;
      } else {
        const aid = accountId?.trim();
        const tok = apiToken?.trim();
        if (aid && tok) {
          const sub = await fetchWorkersAccountSubdomain(aid, tok, fetchFn);
          if (sub) {
            previewUrl = buildWorkersDevUrl(workerScriptName, sub);
          }
        }
      }

      const previewIdentifier =
        ref.objectVersion?.trim() ||
        ref.manifestDigest?.trim() ||
        dReq;

      const resolvedBackend = previewUrl ? `${backend}+workers_dev` : backend;

      return {
        status: "succeeded",
        previewUrl,
        previewIdentifier,
        audit: {
          ...auditFrom(request, resolvedBackend),
        },
      };
    },
  };
}
