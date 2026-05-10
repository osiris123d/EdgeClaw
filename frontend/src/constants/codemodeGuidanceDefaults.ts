/** Mirror `DEFAULT_CODEMODE_GUIDANCE_NOTES` in repo `src/lib/codemodeGuidanceSettings.ts`. */
export const DEFAULT_CODEMODE_GUIDANCE_NOTES =
  `- For WARP/DEX health, load and use the cloudflare-dex-health skill first.\n` +
  `- For OpenAPI HTTP calls, use openapi_search → openapi_describe_operation → cloudflare_request.\n` +
  `- Prefer knownValues from prior structured results over guessed IDs.`;

export const CODEMODE_GUIDANCE_PLACEHOLDER = [
  "- For WARP/DEX health, load/use the cloudflare-dex-health skill first.",
  "- For OpenAPI HTTP calls, use openapi_search → openapi_describe_operation → cloudflare_request.",
  "- Prefer knownValues from prior structured results over guessed IDs.",
].join("\n");

/** Same cap as server `buildCodemodeGuidanceText` */
export const MAX_CODEMODE_GUIDANCE_CHARS = 2000;
