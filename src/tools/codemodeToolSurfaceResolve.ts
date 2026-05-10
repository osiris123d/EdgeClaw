/**
 * Resolves whether Codemode Gateway tool-surface compression is active for a turn.
 *
 * Precedence (first match wins):
 * 1. Worker `ENABLE_CODEMODE_TOOL_SURFACE` — global kill switch (`false` blocks settings).
 * 2. LOADER binding — required for sandbox relay.
 * 3. `enableCodeExecution` — relay is built on the same runner as legacy `execute`.
 * 4. Persisted UI preference `codemodeToolSurfaceEnabled` — explicit `false` forces legacy wide schemas.
 */

export type CodemodeToolSurfaceDecisionReason =
  | "disabled_by_env"
  | "disabled_by_setting"
  | "disabled_no_loader"
  | "disabled_code_execution"
  /** Router sanity probe failed against the live Loader / Rpc surface — fall back to legacy wide tools for this Worker session once latched. */
  | "disabled_sanity_failed"
  | "enabled_by_setting";

export interface ResolveCodemodeToolSurfaceCompressionInput {
  /** From Worker env / feature flag (false = emergency global deny). */
  envGloballyAllows: boolean;
  /**
   * Chat `settings.codemodeToolSurfaceEnabled`. When `false`, user chose legacy wide Gateway tools.
   * When `true` or omitted (missing key / undefined), preference is ON — subject to upstream gates.
   */
  userCodemodeToolSurfaceEnabled: boolean;
  hasLoaderBinding: boolean;
  codeExecutionEnabled: boolean;
}

export interface CodemodeToolSurfaceCompressionDecision {
  effective: boolean;
  reason: CodemodeToolSurfaceDecisionReason;
}

export function resolveCodemodeToolSurfaceCompression(
  input: ResolveCodemodeToolSurfaceCompressionInput
): CodemodeToolSurfaceCompressionDecision {
  if (!input.envGloballyAllows) {
    return { effective: false, reason: "disabled_by_env" };
  }
  if (!input.hasLoaderBinding) {
    return { effective: false, reason: "disabled_no_loader" };
  }
  if (!input.codeExecutionEnabled) {
    return { effective: false, reason: "disabled_code_execution" };
  }
  if (!input.userCodemodeToolSurfaceEnabled) {
    return { effective: false, reason: "disabled_by_setting" };
  }
  return { effective: true, reason: "enabled_by_setting" };
}

/** Normalize JSON `settings.codemodeToolSurfaceEnabled` → boolean preference (default ON). */
export function parseCodemodeToolSurfaceUserPreference(raw: unknown): boolean {
  if (raw === false) return false;
  return true;
}

/** When `false`, Codemode router sanity failures stay visible-only (still falls back for safety). Default ON. */
export function parseCodemodeAutoFallbackToLegacyTools(raw: unknown): boolean {
  if (raw === false) return false;
  return true;
}
