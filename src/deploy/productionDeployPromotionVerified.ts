import type { ArtifactPromotionWriter } from "../promotion/artifactPromotionTypes";
import { computePromotionManifestDigest } from "../promotion/promotionManifestCanonical";
import { buildWorkersDevUrl, fetchWorkersAccountSubdomain } from "./cloudflareWorkersSubdomain";
import type {
  ProductionDeployAdapter,
  ProductionDeployRequest,
  ProductionDeployResult,
} from "./productionDeployTypes";

function distinctApproverCountForAudit(request: ProductionDeployRequest): number {
  const set = new Set<string>();
  for (const a of request.productionApprovals) {
    const id = typeof a.approverId === "string" ? a.approverId.trim() : "";
    if (id) {
      set.add(id);
    }
  }
  return set.size;
}

function auditFrom(request: ProductionDeployRequest, adapterBackend: string): ProductionDeployResult["audit"] {
  return {
    projectId: request.projectId,
    bundleId: request.manifest.bundleId,
    manifestDigest: request.bundleRef.manifestDigest,
    gateOutcome: request.releaseGateDecision.outcome,
    gateTier: request.releaseGateDecision.tier,
    correlationId: request.correlationId,
    distinctApproverCount: distinctApproverCountForAudit(request),
    changeTicketId: request.changeTicketId,
    adapterBackend,
    artifactStorageBackend: request.bundleRef.storageBackend,
  };
}

export interface PromotionArtifactVerifiedProductionDeployAdapterOptions {
  /** If set, used as `productionDeploymentUrl` (skips workers.dev subdomain lookup). */
  canonicalProductionUrl?: string;
  workerScriptName?: string;
  accountId?: string;
  apiToken?: string;
  fetchFn?: typeof fetch;
}

const verifiedRollbackHint =
  "Durable promotion manifest verified; this adapter does not upload a Worker bundle or shift production traffic. " +
  "Rollback: redeploy a prior PromotionArtifactRef or revert routes/DNS; previous Workers version id is not captured by this seam.";

/**
 * Verifies {@link PromotionArtifactRef} by re-reading the durable manifest via {@link ArtifactPromotionWriter.readManifest}.
 * Separate module from preview — never import `previewDeploy*` from here.
 *
 * Does **not** perform an enterprise rollout (no Workers Versions upload / traffic switch) — see deferred docs.
 */
export function createPromotionArtifactVerifiedProductionDeployAdapter(
  writer: ArtifactPromotionWriter,
  options: PromotionArtifactVerifiedProductionDeployAdapterOptions = {}
): ProductionDeployAdapter {
  const {
    canonicalProductionUrl,
    workerScriptName = "edgeclaw-truth-agent",
    accountId,
    apiToken,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = options;

  return {
    async deploy(request: ProductionDeployRequest): Promise<ProductionDeployResult> {
      const ref = request.bundleRef;
      const backend = "promotion_verified_production";

      if (!ref.manifestDigest?.trim() || !ref.storageUri?.trim()) {
        return {
          status: "failed",
          failureCategory: "policy_blocked",
          audit: auditFrom(request, backend),
          error:
            "PromotionArtifactRef.storageUri and manifestDigest are required for verified production deploy",
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
          error: "Durable manifest bytes do not match the manifest on this production deploy request",
        };
      }

      let productionDeploymentUrl: string | undefined;
      const trimmedCanonical = canonicalProductionUrl?.trim();
      if (trimmedCanonical) {
        productionDeploymentUrl = trimmedCanonical;
      } else {
        const aid = accountId?.trim();
        const tok = apiToken?.trim();
        if (aid && tok) {
          const sub = await fetchWorkersAccountSubdomain(aid, tok, fetchFn);
          if (sub) {
            productionDeploymentUrl = buildWorkersDevUrl(workerScriptName, sub);
          }
        }
      }

      const productionIdentifier =
        ref.objectVersion?.trim() ||
        ref.manifestDigest?.trim() ||
        dReq;

      const resolvedBackend = productionDeploymentUrl ? `${backend}+workers_dev` : backend;

      return {
        status: "succeeded",
        productionDeploymentUrl,
        productionIdentifier,
        rollbackHint: verifiedRollbackHint,
        audit: {
          ...auditFrom(request, resolvedBackend),
        },
      };
    },
  };
}
