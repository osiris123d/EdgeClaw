/**
 * End-to-end **preview** promotion pipeline — orchestrator-only (MainAgent or Workflow host).
 *
 * **Canonical vs compatibility:**
 * - **Sync (`runPreviewPromotionPipeline`):** in-process; best for unit/integration tests and single-request flows — **no** Workflow durability.
 * - **Durable:** `runPreviewPromotionWorkflow` + `EdgeclawPreviewPromotionWorkflow` — **canonical** when checkpoints/retries matter; same `PreviewPromotionPipelineHost` surface.
 *
 * **Boundary:** Do not import from CoderAgent, TesterAgent, or coding-loop internals. The coding loop may only
 * supply approved patch ids upstream; it does not call this module.
 *
 * **Workflows:** Use `runPreviewPromotionWorkflow` in `previewPromotionWorkflowLogic.ts` and
 * `EdgeclawPreviewPromotionWorkflow` for durable `step.do` checkpoints; start via MainAgent `launchPreviewPromotionWorkflow`.
 *
 * **Production deploy:** Explicitly out of scope — no production tier or prod deploy adapter here.
 */

import type { PromotionArtifactManifest, PromotionArtifactRef } from "./artifactPromotionTypes";
import type { PrepareApprovedPromotionResult } from "./promotionOrchestration";
import type { ReleaseGateDecision } from "./flagshipTypes";
import type { PreviewDeployRequest, PreviewDeployResult } from "../deploy/previewDeployTypes";

/** Inputs for {@link runPreviewPromotionPipeline}. */
export interface PreviewPromotionPipelineInput {
  projectId: string;
  /** Non-empty list of patch ids that must already be `approved` in the shared workspace. */
  patchIds: readonly string[];
  verificationRefs?: readonly string[];
  correlationId?: string;
  sourceMetadata?: PreviewDeployRequest["sourceMetadata"];
}

/**
 * Narrow host surface so Workflows/tests can implement the pipeline without subclassing MainAgent.
 * Bound methods from MainAgent satisfy this interface.
 */
export interface PreviewPromotionPipelineHost {
  prepareApprovedPromotion(
    projectId: string,
    patchIds: readonly string[],
    options?: { verificationRefs?: readonly string[] }
  ): Promise<PrepareApprovedPromotionResult>;

  buildPromotionArtifact(
    manifest: PromotionArtifactManifest
  ): Promise<{ ok: true; ref: PromotionArtifactRef } | { ok: false; error: string }>;

  evaluateReleaseGate(params: {
    projectId: string;
    tier: "preview";
    bundleRef: PromotionArtifactRef;
    manifest: PromotionArtifactManifest;
    verificationRefs?: readonly string[];
    correlationId?: string;
  }): Promise<ReleaseGateDecision>;

  executePreviewDeployment(request: PreviewDeployRequest): Promise<PreviewDeployResult>;
}

/** Terminal status for logging and UI — orthogonal to `ok`. */
export type PreviewPromotionPipelineTerminalStatus =
  | "succeeded"
  | "prepare_failed"
  | "artifact_write_failed"
  | "release_gate_blocked"
  | "preview_deploy_blocked_or_failed";

/** Fine-grained failure classification for dashboards and alerts. */
export type PreviewPromotionPipelineFailureKind =
  | "no_approved_patches_or_prepare_error"
  | "artifact_write_failed"
  | "release_gate_deny"
  | "release_gate_hold"
  | "preview_deploy_blocked"
  | "preview_deploy_failed";

export type PreviewPromotionPipelineResult =
  | {
      ok: true;
      status: "succeeded";
      manifest: PromotionArtifactManifest;
      bundleRef: PromotionArtifactRef;
      releaseGateDecision: ReleaseGateDecision;
      previewDeploy: PreviewDeployResult;
    }
  | {
      ok: false;
      status: "prepare_failed";
      failureKind: "no_approved_patches_or_prepare_error";
      error: string;
    }
  | {
      ok: false;
      status: "artifact_write_failed";
      failureKind: "artifact_write_failed";
      manifest: PromotionArtifactManifest;
      error: string;
    }
  | {
      ok: false;
      status: "release_gate_blocked";
      failureKind: "release_gate_deny" | "release_gate_hold";
      manifest: PromotionArtifactManifest;
      bundleRef: PromotionArtifactRef;
      releaseGateDecision: ReleaseGateDecision;
    }
  | {
      ok: false;
      status: "preview_deploy_blocked_or_failed";
      failureKind: "preview_deploy_blocked" | "preview_deploy_failed";
      manifest: PromotionArtifactManifest;
      bundleRef: PromotionArtifactRef;
      releaseGateDecision: ReleaseGateDecision;
      previewDeploy: PreviewDeployResult;
    };

/**
 * Runs: prepareApprovedPromotion → buildPromotionArtifact → evaluateReleaseGate (preview) →
 * executePreviewDeployment only when the gate outcome is **allow**.
 */
export async function runPreviewPromotionPipeline(
  host: PreviewPromotionPipelineHost,
  input: PreviewPromotionPipelineInput
): Promise<PreviewPromotionPipelineResult> {
  const prep = await host.prepareApprovedPromotion(input.projectId, input.patchIds, {
    verificationRefs: input.verificationRefs,
  });

  if (!prep.ok) {
    return {
      ok: false,
      status: "prepare_failed",
      failureKind: "no_approved_patches_or_prepare_error",
      error: prep.error,
    };
  }

  const manifest = prep.manifest;

  const built = await host.buildPromotionArtifact(manifest);
  if (!built.ok) {
    return {
      ok: false,
      status: "artifact_write_failed",
      failureKind: "artifact_write_failed",
      manifest,
      error: built.error,
    };
  }

  const bundleRef = built.ref;

  const gate = await host.evaluateReleaseGate({
    projectId: input.projectId,
    tier: "preview",
    bundleRef,
    manifest,
    verificationRefs: input.verificationRefs,
    correlationId: input.correlationId,
  });

  if (gate.outcome !== "allow") {
    const failureKind: "release_gate_deny" | "release_gate_hold" =
      gate.outcome === "hold" ? "release_gate_hold" : "release_gate_deny";
    return {
      ok: false,
      status: "release_gate_blocked",
      failureKind,
      manifest,
      bundleRef,
      releaseGateDecision: gate,
    };
  }

  const preview = await host.executePreviewDeployment({
    projectId: input.projectId,
    bundleRef,
    manifest,
    releaseGateDecision: gate,
    requestedTier: "preview",
    artifactWritten: true,
    correlationId: input.correlationId,
    sourceMetadata: input.sourceMetadata,
  });

  if (preview.status !== "succeeded") {
    const failureKind: "preview_deploy_blocked" | "preview_deploy_failed" =
      preview.status === "blocked" ? "preview_deploy_blocked" : "preview_deploy_failed";
    return {
      ok: false,
      status: "preview_deploy_blocked_or_failed",
      failureKind,
      manifest,
      bundleRef,
      releaseGateDecision: gate,
      previewDeploy: preview,
    };
  }

  return {
    ok: true,
    status: "succeeded",
    manifest,
    bundleRef,
    releaseGateDecision: gate,
    previewDeploy: preview,
  };
}
