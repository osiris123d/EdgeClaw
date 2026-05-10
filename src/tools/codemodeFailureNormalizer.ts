/**
 * Provider-agnostic failure buckets for Codemode / MCP tool payloads.
 *
 * Vendor error strings live only in metadata — routing uses stable families below.
 */

export type GenericCodemodeFailureFamily =
  | "unknown_helper_argument"
  | "missing_schema_lookup"
  | "missing_required_parameter"
  | "invalid_path_identifier"
  | "api_validation_error"
  /** Catch-all — raw vendor codes preserved in preview/metadata only */
  | "provider_specific_error";

export interface NormalizedCodemodeFailure {
  family: GenericCodemodeFailureFamily;
  /** Short excerpt for previews / telemetry (does not dictate routing). */
  preview: string;
  /** Untrimmed-ish slice for transcripts (opaque provider text allowed). */
  providerMetadataHint?: string;
}

const SYNTAX_FRAGMENT = /\bsyntaxerror\b|\bunexpected token\b|\bunexpected end\b/i;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Extract coarse `error` string from arbitrary JSON-ish object. */
function readErrorLikeField(obj: Record<string, unknown>): string | null {
  const e = obj.error;
  if (typeof e === "string" && e.trim()) return e;
  const m = obj.message;
  if (typeof m === "string" && m.trim()) return m;
  const det = obj.details;
  if (det !== null && typeof det === "object") {
    const rec = det as Record<string, unknown>;
    const derr = rec.error;
    if (typeof derr === "string" && derr.trim()) return derr;
  }
  return null;
}

/**
 * Map one `ok:false` node (serialized to string) onto a stable family plus metadata hint.
 */
export function normalizeCodemodePayloadFailureSnippet(rawText: string): NormalizedCodemodeFailure | null {
  if (!rawText.trim()) return null;
  const low = rawText.toLowerCase();

  if (SYNTAX_FRAGMENT.test(low)) return null;

  if (/\bunknown_helper_argument\b/.test(low))
    return { family: "unknown_helper_argument", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };

  if (/\bmissing_schema_lookup\b/.test(low))
    return { family: "missing_schema_lookup", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };

  if (/\binvalid_path_identifier\b/.test(low))
    return { family: "invalid_path_identifier", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };

  if (/path_uses_non_uuid_device_segment/.test(low))
    return { family: "invalid_path_identifier", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };

  if (
    low.includes("missing_required_parameter") ||
    /\bmissing required\b/i.test(rawText) ||
    low.includes("parameter.missing") ||
    low.includes("invalid_parameter") ||
    low.includes("required parameter") ||
    /\brequired\b.*\bmissing\b/i.test(rawText) ||
    (/\bmissing\b/i.test(rawText) && /param|argument|body|query|filter/i.test(rawText))
  ) {
    return { family: "missing_required_parameter", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };
  }

  /** Generic HTTP-ish validation envelopes */
  const validationHttp =
    /\b(?:400|404|409|422)\b/.test(rawText) &&
    /valid|parameter|missing|bad request|malformed|unexpected|incorrect/i.test(rawText);

  if (validationHttp) {
    return { family: "api_validation_error", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };
  }

  /** Known outer relay shapes */
  if (low.includes("cloudflare_api_error") || /\b\d{5}\b/.test(rawText)) {
    return { family: "provider_specific_error", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };
  }

  /** Generic structured API failure fallback */
  if (/"ok"\s*:\s*false/.test(rawText) || /\bok\s*[:=]\s*false\b/.test(rawText)) {
    return { family: "provider_specific_error", preview: clip(rawText, 420), providerMetadataHint: clip(rawText, 960) };
  }

  return null;
}

/** Parse first-level `error` hints from an object-shaped `ok:false` node without stringifying wholesale. */
export function normalizeStructuredOkFalseNode(obj: Record<string, unknown>): NormalizedCodemodeFailure | null {
  const err = readErrorLikeField(obj);
  const synth = stringifyNodeForNormalizer(obj);
  const baseFromErr = err ? normalizeCodemodePayloadFailureSnippet(err + " " + synth) : normalizeCodemodePayloadFailureSnippet(synth);
  return baseFromErr;
}

function stringifyNodeForNormalizer(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(obj);
  }
}
