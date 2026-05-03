/**
 * Types for the durable **preview promotion** Workflow (`EdgeclawPreviewPromotionWorkflow`).
 *
 * **Interactive vs durable**
 * - **Interactive:** coding collaboration loop (`runCodingCollaborationLoop`) — scratch + patch proposals; unchanged.
 * - **Durable:** this Workflow runs **after** approved patch ids + promotion intent exist; each `step.do` name below is a retry-safe checkpoint.
 *
 * **Orchestrator authority:** Only MainAgent should call `runWorkflow` / `launchPreviewPromotionWorkflow`; sub-agents do not expose this path.
 */

import type { PromotionArtifactManifest, PromotionArtifactRef } from "./artifactPromotionTypes";
import type { ReleaseGateDecision } from "./flagshipTypes";
import type { PreviewDeployResult } from "../deploy/previewDeployTypes";

/**
 * Workflow payload — aligned with `PreviewPromotionPipelineInput` in `orchestratorPreviewPromotionPipeline.ts`.
 */
export type { PreviewPromotionPipelineInput as PreviewPromotionWorkflowParams } from "./orchestratorPreviewPromotionPipeline";

/** Durable step ids — must stay stable for Workflow replay (see `previewPromotionWorkflowLogic.ts`). */
export type PreviewPromotionWorkflowStepName =
  | "prepare-manifest"
  | "write-artifact"
  | "release-gate"
  | "preview-deploy";

/**
 * Optional consolidated checkpoint for UI / external stores. Cloudflare Workflows already persists each
 * `step.do` output; this shape mirrors the latest successful artifacts for dashboards that do not parse Workflow internals.
 */
export interface PreviewPromotionWorkflowCheckpointState {
  projectId: string;
  patchIds: readonly string[];
  verificationRefs?: readonly string[];
  correlationId?: string;
  manifest?: PromotionArtifactManifest;
  bundleRef?: PromotionArtifactRef;
  releaseGateDecision?: ReleaseGateDecision;
  previewDeploy?: PreviewDeployResult;
  /** Last step whose `step.do` finished (success or policy outcome captured inside the step). */
  lastCompletedStep?: PreviewPromotionWorkflowStepName;
  recordedAt: string;
}
