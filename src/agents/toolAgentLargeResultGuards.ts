/**
 * Large-result guards for delegated ToolAgent tasks.
 *
 * These guards prevent raw large payloads from flowing back to MainAgent in chat,
 * enforce pagination-first extraction, and produce normalized ToolAgentResultEnvelope
 * responses with metadata when results exceed inline thresholds.
 */

import type { ToolAgentResultEnvelope } from "./delegation";

// ── Guard constants ───────────────────────────────────────────────────────────

/** Maximum raw tool-evidence chars stored in the envelope for error diagnosis. */
export const MAX_TOOL_EVIDENCE_CHARS = 8_000;

/**
 * Maximum chars for any final response returned inline to MainAgent.
 * Responses above this threshold trigger large-result classification.
 */
export const MAX_FINAL_RESPONSE_CHARS = 40_000;

/**
 * Maximum number of items (objects / rows / entries) returned inline.
 * Above this limit, a compact summary or artifact pointer must be used instead.
 */
export const MAX_INLINE_ITEMS = 50;

/**
 * Maximum raw chars accepted from a single tool call result before it is
 * considered a raw JSON dump and subject to extraction/compaction.
 */
export const MAX_RAW_TOOL_CALL_CHARS = 60_000;

// ── Detection ─────────────────────────────────────────────────────────────────

/** Patterns that indicate a result is likely large or was truncated. */
const LARGE_RESULT_PATTERNS: RegExp[] = [
  /\bTRUNCATED\b/i,
  /Response was ~\d+ tokens/i,
  /\btoken limit\b/i,
  /\bcontext limit\b/i,
  /\bpayload too large\b/i,
  /\btoo much data\b/i,
  /\bresult too large\b/i,
  /\bmax tokens reached\b/i,
];

/**
 * Returns true when the text has characteristics of a large/truncated result:
 * explicit truncation markers, text exceeding response limits, or large JSON array dumps.
 */
export function isLikelyLargeResult(text: string): boolean {
  if (!text) return false;
  if (LARGE_RESULT_PATTERNS.some((re) => re.test(text))) return true;
  if (text.length > MAX_FINAL_RESPONSE_CHARS) return true;
  // Detect large JSON array dumps (>MAX_INLINE_ITEMS object entries in a JSON array)
  if (text.trimStart().startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length > MAX_INLINE_ITEMS) return true;
    } catch {
      // non-parseable — use char limit check only
    }
  }
  return false;
}

/**
 * Returns true when a raw tool call result should be treated as a JSON dump
 * (i.e., a bare list-API response with no user-requested extraction applied).
 */
export function isRawJsonDump(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("[") && !t.startsWith("{")) return false;
  if (text.length < MAX_RAW_TOOL_CALL_CHARS / 4) return false; // small payloads are fine
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > MAX_INLINE_ITEMS) return true;
    if (typeof parsed === "object" && parsed !== null) {
      // An object with many top-level keys is also a raw dump
      if (Object.keys(parsed).length > MAX_INLINE_ITEMS) return true;
      // A result object wrapping a large array
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length > MAX_INLINE_ITEMS) return true;
      }
    }
  } catch {
    // non-parseable — not a raw JSON dump
  }
  return false;
}

// ── Clamping ──────────────────────────────────────────────────────────────────

/** Clamp raw tool evidence to the max diagnostic chars for envelope storage. */
export function clampToolEvidenceForEnvelope(text: string): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_TOOL_EVIDENCE_CHARS
    ? `${trimmed.slice(0, MAX_TOOL_EVIDENCE_CHARS)}…`
    : trimmed;
}

/** Clamp a final response to the max inline chars. */
export function clampFinalResponse(text: string): string {
  if (!text) return "";
  return text.length > MAX_FINAL_RESPONSE_CHARS
    ? `${text.slice(0, MAX_FINAL_RESPONSE_CHARS)}\n\n[… result truncated at ${MAX_FINAL_RESPONSE_CHARS} chars; store in artifact for full access]`
    : text;
}

// ── Compact extraction ────────────────────────────────────────────────────────

export interface CompactExtractionResult {
  /** Compact extracted text — only requested fields, one item per line or compact JSON. */
  extractedText: string;
  scannedCount: number;
  matchedCount: number;
}

/**
 * Attempts to extract compact results from a raw JSON array/object payload.
 *
 * @param rawText       Raw text from a tool call (may be JSON array or object).
 * @param requestedFields  Field names the user asked for (e.g. ["id", "name", "status"]).
 *                        If empty, returns a minimal id+name summary.
 * @returns Compact extraction result, or null if raw text is not parseable JSON.
 */
export function extractCompactFromRawResult(
  rawText: string,
  requestedFields: string[]
): CompactExtractionResult | null {
  const fields =
    requestedFields.length > 0 ? requestedFields : ["id", "name", "title", "status", "type"];

  let items: unknown[];
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      // Try common list-wrapper keys
      const wrapper = ["result", "results", "items", "data", "records", "list"];
      let found: unknown[] | undefined;
      for (const k of wrapper) {
        const v = (parsed as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          found = v;
          break;
        }
      }
      if (!found) return null;
      items = found;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const scannedCount = items.length;
  const kept: string[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const extracted: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in rec) extracted[f] = rec[f];
    }
    if (Object.keys(extracted).length > 0) {
      kept.push(JSON.stringify(extracted));
    }
    if (kept.length >= MAX_INLINE_ITEMS) break;
  }

  return {
    extractedText: kept.join("\n"),
    scannedCount,
    matchedCount: kept.length,
  };
}

// ── Envelope builder ──────────────────────────────────────────────────────────

export interface LargeResultEnvelopeArgs {
  /** Whether extraction completed successfully (at least some items extracted). */
  extractionSucceeded: boolean;
  /** Compact extracted text or summary of findings. */
  partialResultText?: string;
  scannedCount?: number;
  matchedCount?: number;
  /** Key / path in shared workspace or artifact store where full findings are saved. */
  artifactPointer?: string;
  /** Source text that triggered the large-result guard (used for evidence). */
  evidenceText?: string;
  /** Where in the tool call chain the large result was detected. */
  where?: string;
}

/**
 * Builds a normalized ToolAgentResultEnvelope for a large-result situation.
 *
 * If extraction succeeded (`extractionSucceeded=true`), returns `ok=true` with
 * metadata fields so MainAgent can surface a concise summary.
 *
 * If extraction failed, returns `ok=false` with `type=large_result` failure
 * and a retry prompt requesting pagination.
 */
export function buildLargeResultEnvelope(args: LargeResultEnvelopeArgs): ToolAgentResultEnvelope {
  const evidence = args.evidenceText
    ? clampToolEvidenceForEnvelope(args.evidenceText)
    : undefined;

  if (args.extractionSucceeded) {
    return {
      ok: true,
      ...(args.partialResultText ? { resultText: args.partialResultText } : {}),
      ...(args.scannedCount !== undefined ? { scannedCount: args.scannedCount } : {}),
      ...(args.matchedCount !== undefined ? { matchedCount: args.matchedCount } : {}),
      ...(args.artifactPointer ? { artifactPointer: args.artifactPointer } : {}),
      suggestedRetryPrompt: args.matchedCount !== undefined && args.scannedCount !== undefined
        ? `Compact extraction complete: ${args.matchedCount} of ${args.scannedCount} items matched.` +
          (args.artifactPointer
            ? ` Full findings stored at: ${args.artifactPointer}.`
            : " Request specific fields to narrow further.")
        : undefined,
    };
  }

  return {
    ok: false,
    failure: {
      type: "large_result",
      where: args.where,
      summary:
        "ToolAgent encountered a result too large to return inline. Compact extraction did not complete.",
      evidence,
      suggestedFix:
        "Switch to paginated extraction: fetch one page at a time, extract only the fields the user requested, " +
        "accumulate compact findings, and store the full result in shared workspace or an artifact before returning.",
      suggestedRetryPrompt:
        "Retry delegated tool task in paginated extraction mode. " +
        "Do NOT return raw JSON arrays or large payloads inline. " +
        "For each page: extract only requested fields, accumulate a compact summary (max 50 items inline), " +
        "store full findings in shared_workspace_write or an artifact, and report scannedCount + matchedCount.",
    },
    ...(args.partialResultText ? { partialResultText: args.partialResultText } : {}),
    ...(args.scannedCount !== undefined ? { scannedCount: args.scannedCount } : {}),
    ...(args.matchedCount !== undefined ? { matchedCount: args.matchedCount } : {}),
    ...(args.artifactPointer ? { artifactPointer: args.artifactPointer } : {}),
    suggestedRetryPrompt:
      "Retry delegated tool task in paginated extraction mode. " +
      "Do NOT return raw JSON arrays or large payloads inline. " +
      "Extract only requested fields, accumulate compact findings, store results in shared workspace, " +
      "and return scannedCount + matchedCount + artifactPointer.",
  };
}
