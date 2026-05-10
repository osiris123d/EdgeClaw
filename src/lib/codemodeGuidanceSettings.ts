/**
 * User-facing MCP / Codemode guidance from Feature Settings — bounded server-side excerpt.
 */

export const MAX_CODEMODE_GUIDANCE_CHARS = 2000;

/** Default notes shown in Settings and sent when unchanged; synced with frontend defaults. */
export const DEFAULT_CODEMODE_GUIDANCE_NOTES =
  `- For WARP/DEX health, load and use the cloudflare-dex-health skill first.\n` +
  `- For OpenAPI HTTP calls, use openapi_search → openapi_describe_operation → cloudflare_request.\n` +
  `- Prefer knownValues from prior structured results over guessed IDs.`;

export type CodemodeGuidanceSettingsSlice = {
  codemodeGuidanceEnabled?: unknown;
  codemodeGuidanceNotes?: unknown;
};

/**
 * Returns trimmed bounded guidance text, or `undefined` when disabled or empty after trim.
 * Unknown/missing keys: enabled defaults true (backward compatible).
 */
export function buildCodemodeGuidanceText(
  settings: CodemodeGuidanceSettingsSlice | undefined | null
): string | undefined {
  if (settings === undefined || settings === null || typeof settings !== "object") {
    return undefined;
  }
  if (settings.codemodeGuidanceEnabled === false) {
    return undefined;
  }

  let notes =
    typeof settings.codemodeGuidanceNotes === "string" ? settings.codemodeGuidanceNotes : "";
  notes = notes.replace(/\r\n/g, "\n").trim();
  if (notes === "") {
    return undefined;
  }

  if (notes.length > MAX_CODEMODE_GUIDANCE_CHARS) {
    notes = notes.slice(0, MAX_CODEMODE_GUIDANCE_CHARS).replace(/\s+$/u, "");
  }
  return notes;
}
