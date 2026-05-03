/**
 * Durable orchestration for the preview promotion pipeline — **unit-testable** without `cloudflare:` Workflow runtime.
 *
 * **Canonical** for production-style promotion when using `EdgeclawPreviewPromotionWorkflow`: retries and persisted `step.do` boundaries.
 * For synchronous execution without Workflow storage, call {@link runPreviewPromotionPipeline} instead (same host RPC surface).
 *
 * Each `step.do("<name>", …)` boundary is retry-safe: successful completions replay from Workflow storage on resume.
 * Business logic reuses {@link PreviewPromotionPipelineHost} (same RPC surface MainAgent implements).
 *
 * Deferred / optional next steps:
 * - Human approval between stages (`waitForApproval`) — product policy, not required for checkpoint durability.
 * - Emitting checkpoints to KV/R2 — Workflow step outputs already persist; external mirrors are optional.
 */

import type { PreviewDeployRequest } from "../deploy/previewDeployTypes";
import type {
  PreviewPromotionPipelineHost,
  PreviewPromotionPipelineResult,
  PreviewPromotionPipelineInput,
} from "./orchestratorPreviewPromotionPipeline";
import type { PreviewPromotionWorkflowStepName } from "./previewPromotionWorkflowTypes";

/** Minimal `step.do` surface — matches existing workflow logic modules. */
export interface PreviewPromotionWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface PreviewPromotionWorkflowHooks {
  /** Forward to `AgentWorkflow.reportProgress` in production. */
  reportProgress?(data: Record<string, unknown>): Promise<void>;
}

export interface PreviewPromotionWorkflowRunResult {
  pipeline: PreviewPromotionPipelineResult;
  completedSteps: readonly PreviewPromotionWorkflowStepName[];
}

async function safeReport(
  hooks: PreviewPromotionWorkflowHooks | undefined,
  data: Record<string, unknown>
): Promise<void> {
  await hooks?.reportProgress?.(data);
}

/**
 * Runs prepare → artifact → release gate → preview deploy with **one durable step per stage**.
 */
export async function runPreviewPromotionWorkflow(
  payload: PreviewPromotionPipelineInput,
  step: PreviewPromotionWorkflowStep,
  host: PreviewPromotionPipelineHost,
  hooks?: PreviewPromotionWorkflowHooks
): Promise<PreviewPromotionWorkflowRunResult> {
  const completed: PreviewPromotionWorkflowStepName[] = [];

  const prep = await step.do("prepare-manifest", async () => {
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "prepare-manifest",
      status: "running",
      percent: 0.12,
      projectId: payload.projectId,
    });
    const p = await host.prepareApprovedPromotion(payload.projectId, payload.patchIds, {
      verificationRefs: payload.verificationRefs,
    });
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "prepare-manifest",
      status: "complete",
      percent: 0.28,
      projectId: payload.projectId,
    });
    return p;
  });

  completed.push("prepare-manifest");

  if (!prep.ok) {
    return {
      pipeline: {
        ok: false,
        status: "prepare_failed",
        failureKind: "no_approved_patches_or_prepare_error",
        error: prep.error,
      },
      completedSteps: [...completed],
    };
  }

  const manifest = prep.manifest;

  const built = await step.do("write-artifact", async () => {
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "write-artifact",
      status: "running",
      percent: 0.38,
      bundleId: manifest.bundleId,
    });
    const b = await host.buildPromotionArtifact(manifest);
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "write-artifact",
      status: "complete",
      percent: 0.52,
      bundleId: manifest.bundleId,
    });
    return b;
  });

  completed.push("write-artifact");

  if (!built.ok) {
    return {
      pipeline: {
        ok: false,
        status: "artifact_write_failed",
        failureKind: "artifact_write_failed",
        manifest,
        error: built.error,
      },
      completedSteps: [...completed],
    };
  }

  const bundleRef = built.ref;

  const gate = await step.do("release-gate", async () => {
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "release-gate",
      status: "running",
      percent: 0.62,
      tier: "preview",
    });
    const g = await host.evaluateReleaseGate({
      projectId: payload.projectId,
      tier: "preview",
      bundleRef,
      manifest,
      verificationRefs: payload.verificationRefs,
      correlationId: payload.correlationId,
    });
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "release-gate",
      status: "complete",
      percent: 0.78,
      outcome: g.outcome,
      tier: g.tier,
    });
    return g;
  });

  completed.push("release-gate");

  if (gate.outcome !== "allow") {
    const failureKind: "release_gate_deny" | "release_gate_hold" =
      gate.outcome === "hold" ? "release_gate_hold" : "release_gate_deny";
    return {
      pipeline: {
        ok: false,
        status: "release_gate_blocked",
        failureKind,
        manifest,
        bundleRef,
        releaseGateDecision: gate,
      },
      completedSteps: [...completed],
    };
  }

  const preview = await step.do("preview-deploy", async () => {
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "preview-deploy",
      status: "running",
      percent: 0.85,
    });
    const req: PreviewDeployRequest = {
      projectId: payload.projectId,
      bundleRef,
      manifest,
      releaseGateDecision: gate,
      requestedTier: "preview",
      artifactWritten: true,
      correlationId: payload.correlationId,
      sourceMetadata: payload.sourceMetadata,
    };
    const pv = await host.executePreviewDeployment(req);
    await safeReport(hooks, {
      pipeline: "preview-promotion",
      step: "preview-deploy",
      status: "complete",
      percent: 1.0,
      previewStatus: pv.status,
    });
    return pv;
  });

  completed.push("preview-deploy");

  if (preview.status !== "succeeded") {
    const failureKind: "preview_deploy_blocked" | "preview_deploy_failed" =
      preview.status === "blocked" ? "preview_deploy_blocked" : "preview_deploy_failed";
    return {
      pipeline: {
        ok: false,
        status: "preview_deploy_blocked_or_failed",
        failureKind,
        manifest,
        bundleRef,
        releaseGateDecision: gate,
        previewDeploy: preview,
      },
      completedSteps: [...completed],
    };
  }

  return {
    pipeline: {
      ok: true,
      status: "succeeded",
      manifest,
      bundleRef,
      releaseGateDecision: gate,
      previewDeploy: preview,
    },
    completedSteps: [...completed],
  };
}
