/**
 * Orchestrator bridge helpers — **only** wired through `MainAgent.derivePromotionCandidateFromCodingLoop`.
 * Do not import from sub-agents; does not perform artifact write, release gate, or deploy (those stay explicit orchestrator steps).
 */
import type { SharedWorkspaceGateway } from "../../workspace/sharedWorkspaceTypes";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import { buildPromotionManifestFromApprovedPatches } from "../../promotion/promotionOrchestration";
import type { CodingCollaborationLoopResult } from "./codingLoopTypes";

function isFailedVerificationResult(loopResult: CodingCollaborationLoopResult): boolean {
  const s = loopResult.status;
  if (
    s === "completed_failure" ||
    s === "stopped_aborted" ||
    s === "blocked_no_shared_workspace" ||
    s === "stopped_repeated_failure" ||
    s === "stopped_no_new_patches"
  ) {
    return true;
  }
  if (s === "stopped_max_iterations") {
    const last = loopResult.iterations[loopResult.iterations.length - 1];
    return !last || last.testerVerdict !== "pass";
  }
  return false;
}

/**
 * Post-loop promotion bridge — does **not** call buildPromotionArtifact / evaluateReleaseGate.
 * Workflow/deploy adapters remain separate explicit steps.
 */

export type PromotionCandidateFromLoopKind =
  | "ready_for_promotion"
  | "needs_user_approval"
  | "failed_verification"
  | "no_approved_patches";

export interface PromotionCandidateFromLoopResult {
  kind: PromotionCandidateFromLoopKind;
  approvedPatchIds: string[];
  manifest?: PromotionArtifactManifest;
  prepareError?: string;
  notes?: string;
}

function extractPatchIdHint(loopResult: CodingCollaborationLoopResult): string[] {
  const last = loopResult.iterations[loopResult.iterations.length - 1];
  if (!last) {
    return [];
  }
  if (last.activePatchIdsForIteration.length > 0) {
    return [...last.activePatchIdsForIteration];
  }
  return [...last.newPendingPatchIds];
}

/**
 * Lists orchestrator-visible patch ids in `approved` state for the project.
 */
export async function listApprovedPatchIdsForProject(
  gateway: SharedWorkspaceGateway,
  projectId: string,
  restrictTo?: ReadonlySet<string>
): Promise<string[]> {
  const r = await gateway.listPatchProposals("orchestrator", projectId);
  if ("error" in r) {
    return [];
  }
  const approved = r.patches.filter((p) => p.status === "approved").map((p) => p.patchId);
  if (!restrictTo || restrictTo.size === 0) {
    return approved;
  }
  return approved.filter((id) => restrictTo.has(id));
}

/**
 * Manager-only: derive whether promotion inputs exist after a loop run.
 * Optional `prepareApprovedPromotion` builds an in-memory manifest (still no artifact write).
 */
export async function derivePromotionCandidateFromCodingLoop(
  gateway: SharedWorkspaceGateway,
  projectId: string,
  loopResult: CodingCollaborationLoopResult,
  options?: {
    patchIdsHint?: readonly string[];
    prepareApprovedPromotion?: boolean;
    verificationRefs?: readonly string[];
  }
): Promise<PromotionCandidateFromLoopResult> {
  if (isFailedVerificationResult(loopResult)) {
    return {
      kind: "failed_verification",
      approvedPatchIds: [],
      notes: `Loop ended with status ${loopResult.status}.`,
    };
  }

  const hint =
    options?.patchIdsHint != null && options.patchIdsHint.length > 0
      ? options.patchIdsHint
      : extractPatchIdHint(loopResult);
  const restrict = hint.length > 0 ? new Set(hint) : undefined;
  const approved = await listApprovedPatchIdsForProject(gateway, projectId, restrict);

  if (loopResult.status === "needs_user_approval") {
    return {
      kind: "needs_user_approval",
      approvedPatchIds: approved,
      notes:
        approved.length > 0
          ? "Some patches are already approved in the gateway; confirm remaining work before promotion."
          : "Pending patches require orchestrator approval before promotion inputs exist.",
    };
  }

  if (approved.length === 0) {
    return {
      kind: "no_approved_patches",
      approvedPatchIds: [],
      notes:
        "No approved patches in shared workspace (pending or applied-only). Approve in gateway or re-run loop.",
    };
  }

  if (options?.prepareApprovedPromotion !== true) {
    return {
      kind: "ready_for_promotion",
      approvedPatchIds: approved,
      notes: "Approved patches present — call prepareApprovedPromotion / buildPromotionArtifact explicitly.",
    };
  }

  const prep = await buildPromotionManifestFromApprovedPatches(gateway, projectId, approved, {
    verificationRefs: options.verificationRefs,
  });
  if (!prep.ok) {
    return {
      kind: "no_approved_patches",
      approvedPatchIds: approved,
      prepareError: prep.error,
      notes: "prepareApprovedPromotion failed — manifest not built.",
    };
  }

  return {
    kind: "ready_for_promotion",
    approvedPatchIds: approved,
    manifest: prep.manifest,
    notes: "Manifest ready — orchestrator may call buildPromotionArtifact then evaluateReleaseGate.",
  };
}
