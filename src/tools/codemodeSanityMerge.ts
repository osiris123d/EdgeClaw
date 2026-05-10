/**
 * Applies a live Codemode router sanity probe outcome to Gateway compression gates.
 */

import type { CodemodeToolSurfaceCompressionDecision } from "./codemodeToolSurfaceResolve";
import type { CodemodeSanityRunnerResult } from "./codemodeRouterSanity";

export type CodemodeSanityTelemetryStatus = "skipped" | "ok" | "failed";

export function mergeCompressionWithCodemodeSanity(
  baseCompression: CodemodeToolSurfaceCompressionDecision,
  sanityRan: boolean,
  sanityResult: CodemodeSanityRunnerResult | undefined,
  autoFallbackToLegacyTools: boolean
): {
  decision: CodemodeToolSurfaceCompressionDecision;
  /** When non-null and `codemodeAutoFallbackToLegacyTools` is false, surface prominently in chat. */
  visibleSanityBanner: string | null;
  fallbackToLegacyCompressionOff: boolean;
  sanityTelemetryStatus: CodemodeSanityTelemetryStatus;
} {
  if (!baseCompression.effective) {
    return {
      decision: baseCompression,
      visibleSanityBanner: null,
      fallbackToLegacyCompressionOff: false,
      sanityTelemetryStatus: "skipped",
    };
  }
  if (!sanityRan || !sanityResult) {
    return {
      decision: baseCompression,
      visibleSanityBanner: null,
      fallbackToLegacyCompressionOff: false,
      sanityTelemetryStatus: "skipped",
    };
  }
  if (sanityResult.ok) {
    return {
      decision: baseCompression,
      visibleSanityBanner: null,
      fallbackToLegacyCompressionOff: false,
      sanityTelemetryStatus: "ok",
    };
  }

  const visibleSanityBanner = autoFallbackToLegacyTools
    ? null
    : formatCodemodeSanityFailureBanner(sanityResult.reason);

  return {
    decision: { effective: false, reason: "disabled_sanity_failed" },
    visibleSanityBanner,
    fallbackToLegacyCompressionOff: true,
    sanityTelemetryStatus: "failed",
  };
}

export function formatCodemodeSanityFailureBanner(reason: string): string {
  return [
    "## Codemode compression disabled",
    "",
    `The Codemode router **sanity check failed** (${reason}). This Worker is using **legacy wide Gateway tools** for this chat so MCP, Skills, browser, and OpenAPI tools remain available.`,
    "",
    "You can turn off Codemode compression permanently in Settings, or retry after deploying a fix.",
  ].join("\n");
}

export function formatCodemodeEmergencyRouterMarkdown(): string {
  return [
    "## Codemode router failure (this turn)",
    "",
    "Repeated Codemode **router/plumbing** errors were detected. Further `codemode` calls are blocked for **this assistant turn**. Full Gateway tools were widened again so legacy tool calls still work.",
    "",
    "**Options:** Disable Codemode compression in Settings, fix the Codemode router deployment, or continue using individual tools exposed to the Gateway.",
  ].join("\n");
}
