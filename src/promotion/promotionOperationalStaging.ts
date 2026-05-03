/**
 * Operational staging helpers — **orchestrator / Worker env only** (no sub-agent paths).
 * Uses {@link buildPromotionPlatformDiagnostics} plus optional prepare probe with safe inputs.
 */

import type { Env } from "../lib/env";
import {
  buildPromotionPlatformDiagnostics,
  formatPromotionPlatformDiagnosticsReport,
  type PromotionPlatformDiagnostics,
} from "./promotionPlatformDiagnostics";
import { buildPromotionManifestFromApprovedPatches } from "./promotionOrchestration";
import { getSharedWorkspaceGateway } from "../workspace/sharedWorkspaceFactory";

/** Extends platform diagnostics with explicit noop/fallback aggregation for staging dashboards. */
export interface StagingOperationalSummary extends PromotionPlatformDiagnostics {
  noopFallbackFlags: {
    promotionWriterNoop: boolean;
    flagshipNoop: boolean;
    previewDeployNoop: boolean;
    productionDeployNoop: boolean;
    /** True when any factory resolves to noop / kill-switch path. */
    anySubsystemNoop: boolean;
  };
}

export function buildStagingOperationalSummary(env: Env): StagingOperationalSummary {
  const base = buildPromotionPlatformDiagnostics(env);
  const promotionWriterNoop = base.artifactPromotionWriter === "noop";
  const flagshipNoop = base.flagshipEvaluation === "noop";
  const previewDeployNoop = base.previewDeploy.branch === "noop";
  const productionDeployNoop = base.productionDeploy.branch === "noop";
  return {
    ...base,
    noopFallbackFlags: {
      promotionWriterNoop,
      flagshipNoop,
      previewDeployNoop,
      productionDeployNoop,
      anySubsystemNoop:
        promotionWriterNoop || flagshipNoop || previewDeployNoop || productionDeployNoop,
    },
  };
}

/**
 * Human-readable report: branches, workflow bindings, env hints, noop aggregation.
 * Safe to log — no secrets (same guarantees as {@link formatPromotionPlatformDiagnosticsReport}).
 */
export function formatStagingOperationalSummaryReport(env: Env): string {
  const s = buildStagingOperationalSummary(env);
  const lines: string[] = [
    formatPromotionPlatformDiagnosticsReport(env),
    "",
    "=== Staging operational summary (noop / fallback aggregation) ===",
    `promotionWriterNoop: ${s.noopFallbackFlags.promotionWriterNoop}`,
    `flagshipNoop: ${s.noopFallbackFlags.flagshipNoop}`,
    `previewDeployNoop: ${s.noopFallbackFlags.previewDeployNoop}`,
    `productionDeployNoop: ${s.noopFallbackFlags.productionDeployNoop}`,
    `anySubsystemNoop: ${s.noopFallbackFlags.anySubsystemNoop}`,
  ];
  return lines.join("\n");
}

export type StagingPrepareProbeOutcome =
  | "skipped_no_shared_workspace_kv"
  | "expected_empty_patch_failure"
  | "unexpected_prepare_failure";

export interface StagingPromotionSmokeResult {
  operational: StagingOperationalSummary;
  prepareProbe: {
    outcome: StagingPrepareProbeOutcome;
    detail?: string;
  };
  /** Artifact write → gate → preview deploy are not executed here — needs real approved patches. */
  fullPipelineNote: string;
}

const STAGING_PROJECT_ID = "__edgeclaw_staging_smoke__";

/**
 * Safe staging smoke: resolves operational branches + runs prepare with **empty** patch ids
 * (expect `patchIds must be non-empty`) when `SHARED_WORKSPACE_KV` exists — validates gateway wiring
 * without writing artifacts or calling deploy adapters.
 *
 * For end-to-end preview promotion (artifact + gate + preview deploy), use
 * {@link runApprovedPatchesPreviewPipeline} or `launchPreviewPromotionWorkflow` with real approved patch ids.
 */
export async function runStagingPromotionSmoke(env: Env): Promise<StagingPromotionSmokeResult> {
  const operational = buildStagingOperationalSummary(env);
  const gateway = getSharedWorkspaceGateway(env);
  if (!gateway) {
    return {
      operational,
      prepareProbe: {
        outcome: "skipped_no_shared_workspace_kv",
        detail: "SHARED_WORKSPACE_KV not bound — prepare probe skipped.",
      },
      fullPipelineNote:
        "Bind SHARED_WORKSPACE_KV to exercise prepareApprovedPromotion; full pipeline still requires approved patches.",
    };
  }

  const prep = await buildPromotionManifestFromApprovedPatches(gateway, STAGING_PROJECT_ID, []);
  if (prep.ok) {
    return {
      operational,
      prepareProbe: {
        outcome: "unexpected_prepare_failure",
        detail: "Empty patchIds unexpectedly succeeded — check workspace gateway behavior.",
      },
      fullPipelineNote:
        "Artifact write, release gate, and preview deploy were not run.",
    };
  }

  const err = prep.error ?? "";
  if (err.includes("non-empty")) {
    return {
      operational,
      prepareProbe: {
        outcome: "expected_empty_patch_failure",
        detail: err,
      },
      fullPipelineNote:
        "Prepare path reachable. Run preview promotion with real approved patch ids for artifact → gate → preview deploy.",
    };
  }

  return {
    operational,
    prepareProbe: {
      outcome: "unexpected_prepare_failure",
      detail: err,
    },
    fullPipelineNote:
      "Prepare failed for an unexpected reason — investigate shared workspace / gateway before full pipeline.",
  };
}
