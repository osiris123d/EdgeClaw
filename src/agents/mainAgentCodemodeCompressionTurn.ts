/**
 * Pure Codemode compression + sanity + Gateway tool-surface derivation.
 *
 * Mirrors the sequence in {@link MainAgent.beforeTurn}: merge sanity outcome into compression,
 * then {@link planMinimalToolSurface}. Safe to exercise from Node/tsx without loading Think
 * or running a WorkerLoader.
 */

import type { ToolSet } from "ai";
import type { CodemodeSanityRunnerResult } from "../tools/codemodeRouterSanity";
import {
  mergeCompressionWithCodemodeSanity,
  type CodemodeSanityTelemetryStatus,
} from "../tools/codemodeSanityMerge";
import type { CodemodeToolSurfaceCompressionDecision } from "../tools/codemodeToolSurfaceResolve";
import { planMinimalToolSurface } from "../tools/toolSurfacePolicy";

export interface MainAgentCodemodeCompressionTurnView {
  finalCompression: CodemodeToolSurfaceCompressionDecision;
  sanityTelemetryStatus: CodemodeSanityTelemetryStatus;
  visibleSanityBanner: string | null;
  /** Same formula as MainAgent telemetry when router emergency is not active. */
  fallbackToLegacy: boolean;
  /** `false` when Codemode narrow surface pins `activeTools` (schemas restricted). */
  gatewayUnrestrictedSchemas: boolean;
  /** Sorted Gateway-visible names for this planning outcome (mirrors finalize expectations). */
  gatewayVisibleToolNamesSorted: string[];
}

/**
 * Computes compression decision after optional sanity latch + resultant Gateway visibility.
 *
 * Callers mirror MainAgent:
 * - When `compressionPreSanity.effective` is false, do not await a loader probe (`sanityOutcome` ignored).
 * - When true, provide the latched sanity result (production or mocked probe).
 */
export function deriveMainAgentCodemodeCompressionTurn(params: {
  mergedTools: ToolSet;
  compressionPreSanity: CodemodeToolSurfaceCompressionDecision;
  /** Result from latch when compression was eligible before sanity; omit when pre-sanity eligibility is false. */
  sanityOutcome: CodemodeSanityRunnerResult | undefined;
  codemodeAutoFallbackToLegacyTools: boolean;
  hasLoaderBinding: boolean;
  codeExecutionEnabled: boolean;
}): MainAgentCodemodeCompressionTurnView {
  const sanityRan = params.compressionPreSanity.effective;
  const merged = mergeCompressionWithCodemodeSanity(
    params.compressionPreSanity,
    sanityRan,
    sanityRan ? params.sanityOutcome : undefined,
    params.codemodeAutoFallbackToLegacyTools
  );

  const finalCompression = merged.decision;
  const plan = planMinimalToolSurface({
    mergedTools: params.mergedTools,
    codemodeSurfaceEnabled: finalCompression.effective,
    hasLoaderBinding: params.hasLoaderBinding,
    codeExecutionEnabled: params.codeExecutionEnabled,
  });

  let gatewayVisibleToolNamesSorted: string[];
  let gatewayUnrestrictedSchemas: boolean;
  if (plan.reason === "codemode-surface-applied-default") {
    gatewayVisibleToolNamesSorted = [...new Set(["codemode", ...plan.directNames])].sort();
    gatewayUnrestrictedSchemas = false;
  } else {
    gatewayVisibleToolNamesSorted = [...Object.keys(params.mergedTools)].sort();
    gatewayUnrestrictedSchemas = true;
  }

  const fallbackToLegacy =
    params.compressionPreSanity.effective && !finalCompression.effective;

  return {
    finalCompression,
    sanityTelemetryStatus: merged.sanityTelemetryStatus,
    visibleSanityBanner: merged.visibleSanityBanner,
    fallbackToLegacy,
    gatewayUnrestrictedSchemas,
    gatewayVisibleToolNamesSorted,
  };
}
