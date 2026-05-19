/**
 * Data transformation pipeline for ToolAgent using Dynamic Workers / codemode.
 *
 * Implements map/filter/reduce execution model:
 * 1. Detection: identify if result is large/structured data or a list API
 * 2. Extraction: use codemode to filter to requested fields
 * 3. Reduction: limit to MAX_INLINE_ITEMS and track scannedCount/matchedCount
 * 4. Return: compact JSON with metadata, never raw dumps
 *
 * Treated as the primary compute layer for data processing.
 */

import type { ToolSet } from "ai";
import { isLikelyLargeResult, isRawJsonDump, MAX_INLINE_ITEMS, MAX_FINAL_RESPONSE_CHARS } from "../toolAgentLargeResultGuards";

export interface ReductionPipelineArgs {
  toolResult: string;
  userRequest: string;
  hadToolActivity: boolean;
  availableTools: ToolSet;
  codemodeToolName?: string; // e.g. "codemode" or wrapped name like "tool_worker_execute"
}

export interface ReductionPipelineResult {
  /** Whether transformation was applied successfully */
  transformed: boolean;
  /** Compact result text (extracted fields, limited items) */
  compactText: string;
  /** Count of total items scanned in original payload */
  scannedCount: number;
  /** Count of items matching filter criteria */
  matchedCount: number;
  /** Artifact pointer if full results stored elsewhere */
  artifactPointer?: string;
  /** Evidence/summary of transformation */
  evidenceText: string;
  /** If transformation failed, include failure reason */
  failureReason?: string;
}

/**
 * Detects if result requires reduction.
 * Triggers on:
 * - Large payload (>40k chars)
 * - Raw JSON dumps (large arrays)
 * - TRUNCATED markers
 */
export function shouldApplyReduction(args: {
  resultText: string;
  hadToolActivity: boolean;
  hasExplicitTruncation: boolean;
}): boolean {
  if (!args.hadToolActivity) return false;
  if (args.hasExplicitTruncation) return false; // Already marked truncated
  if (isLikelyLargeResult(args.resultText)) return true;
  if (isRawJsonDump(args.resultText)) return true;
  if (args.resultText.length > MAX_FINAL_RESPONSE_CHARS) return true;
  return false;
}

/**
 * Detects if result is from a list API that should be paginated.
 * Patterns:
 * - Array response with >50 items
 * - API keys: "items", "results", "records", "data", "records"
 * - Pagination markers: "next_marker", "cursor", "continuation_token"
 */
export function detectListApiPattern(resultText: string): boolean {
  try {
    const obj = JSON.parse(resultText);
    if (Array.isArray(obj) && obj.length > MAX_INLINE_ITEMS) return true;
    if (typeof obj === "object" && obj !== null) {
      const listKeys = ["items", "results", "records", "data", "entries", "objects"];
      for (const key of listKeys) {
        if (key in obj && Array.isArray(obj[key]) && obj[key].length > MAX_INLINE_ITEMS) return true;
      }
      // Check for pagination markers
      const paginationKeys = ["next_marker", "cursor", "continuation_token", "next_page", "nextPageToken"];
      const hasPaginationMarker = paginationKeys.some((k) => k in obj);
      if (hasPaginationMarker && typeof obj === "object") return true;
    }
  } catch {
    // Not JSON, ignore
  }
  return false;
}

/**
 * Detects root-cause semantic failures that should stop execution immediately.
 * Does NOT classify as large_result if:
 * - missing_tool_input (auth, account_id, etc.)
 * - wrong_tool_api (API shape mismatch)
 * - non_retryable (permanent error)
 * - timeout (should not retry immediately)
 */
export function detectRootCauseSemanticFailure(
  errorText: string,
  resultText: string
): { detected: boolean; failureType?: string; reason?: string } {
  const corpus = [errorText, resultText].filter(Boolean).join("\n");

  // Missing required input (auth, account_id, etc.)
  if (/missing.*account|account_id|multiple accounts|auth.*required|credentials/i.test(corpus)) {
    return { detected: true, failureType: "missing_tool_input", reason: "Missing required auth/identifier input" };
  }

  // Wrong API shape or spec error
  if (/spec is not defined|unknown_helper_argument|tools_call.*invalid|wrong tool api/i.test(corpus)) {
    return { detected: true, failureType: "wrong_tool_api", reason: "API shape or spec error" };
  }

  // Non-retryable error
  if (/nonRetryable|non_retryable|permission denied|forbidden|invalid.*parameter/i.test(corpus)) {
    return { detected: true, failureType: "non_retryable", reason: "Non-retryable error" };
  }

  // Timeout
  if (/timeout|timed out|abort|aborted/i.test(corpus)) {
    return { detected: true, failureType: "timeout", reason: "Tool execution timeout" };
  }

  return { detected: false };
}

/**
 * Builds a codemode transformation script for data extraction.
 * Extracts requested fields or defaults (id, name, status, type).
 * Limits output to MAX_INLINE_ITEMS.
 */
export function buildCodemodeExtractionScript(args: {
  userRequest: string;
  resultJson: string;
  requestedFields?: string[];
}): string {
  const fields = args.requestedFields ?? ["id", "name", "status", "type"];
  const fieldList = fields.map((f) => `"${f}"`).join(", ");

  return `
const result = (() => {
  try {
    const raw = JSON.parse(\`${args.resultJson.replace(/\\/g, "\\\\").replace(/\`/g, "\\`")}\`);
    const extract = (item) => {
      const obj = {};
      [${fieldList}].forEach(f => {
        if (f in item) obj[f] = item[f];
      });
      return obj;
    };
    const items = Array.isArray(raw) ? raw : (raw.items || raw.results || [raw]);
    const scanned = Array.isArray(raw) ? items.length : 1;
    const limited = items.slice(0, ${MAX_INLINE_ITEMS});
    const matched = limited.length;
    return {
      extracted: limited.map(extract),
      scannedCount: scanned,
      matchedCount: matched,
      fields: [${fieldList}]
    };
  } catch (e) {
    return { error: e.message, extracted: [], scannedCount: 0, matchedCount: 0 };
  }
})();
JSON.stringify(result);
`;
}

/**
 * Parses codemode extraction output.
 * Expected format: { extracted: [...], scannedCount: N, matchedCount: M, fields: [...] }
 */
export function parseCodemodeExtractionOutput(
  output: string | unknown
): { extracted: unknown[]; scannedCount: number; matchedCount: number; fields: string[] } {
  try {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const result = JSON.parse(text);
    return {
      extracted: Array.isArray(result.extracted) ? result.extracted : [],
      scannedCount: Number.isFinite(result.scannedCount) ? result.scannedCount : 0,
      matchedCount: Number.isFinite(result.matchedCount) ? result.matchedCount : 0,
      fields: Array.isArray(result.fields) ? result.fields : [],
    };
  } catch {
    return { extracted: [], scannedCount: 0, matchedCount: 0, fields: [] };
  }
}

/**
 * Formats reduction result as compact JSON for final response.
 * Never includes raw dumps or tool transcripts.
 */
export function formatReductionResult(args: {
  extracted: unknown[];
  scannedCount: number;
  matchedCount: number;
  fields: string[];
  userRequest: string;
}): string {
  const summary = args.extracted.length === 0
    ? "No matching results found."
    : `Found ${args.matchedCount} matching item(s) (scanned ${args.scannedCount} total).`;

  const lines: string[] = [];
  lines.push(`**Summary:** ${summary}`);
  lines.push("");
  lines.push(`**Extracted Fields:** ${args.fields.join(", ")}`);
  lines.push("");

  if (args.extracted.length > 0) {
    lines.push("**Results:**");
    for (const item of args.extracted) {
      lines.push(`- ${JSON.stringify(item)}`);
    }
  }

  if (args.matchedCount < args.scannedCount) {
    lines.push("");
    lines.push(
      `**Note:** Showing top ${args.matchedCount} of ${args.scannedCount} results. ` +
        `Use pagination to fetch additional results.`
    );
  }

  return lines.join("\n");
}

/**
 * Determines requested fields from user request text.
 * Looks for patterns like "find id, name, status" or "extract account_id"
 */
export function extractRequestedFieldsFromRequest(userRequest: string): string[] | undefined {
  // Pattern 1: "find id, name, status"
  const findMatch = userRequest.match(/find\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/i);
  if (findMatch) {
    return findMatch[1].split(",").map((f) => f.trim().toLowerCase());
  }

  // Pattern 2: "extract account_id, api_token"
  const extractMatch = userRequest.match(/extract\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/i);
  if (extractMatch) {
    return extractMatch[1].split(",").map((f) => f.trim().toLowerCase());
  }

  // Pattern 3: "list by id and name" — use common fields
  if (/by\s+([a-z_][a-z0-9_]*(?:\s*(?:and|,)\s*[a-z_][a-z0-9_]*)*)/i.test(userRequest)) {
    const byMatch = userRequest.match(/by\s+([a-z_][a-z0-9_]*(?:\s*(?:and|,)\s*[a-z_][a-z0-9_]*)*)/i);
    if (byMatch) {
      return byMatch[1].split(/\s+(?:and|,)\s+/).map((f) => f.trim().toLowerCase());
    }
  }

  return undefined;
}

/**
 * Main reduction pipeline — orchestrates data transformation.
 * Returns transformation result with compact text and metadata.
 */
export async function applyReductionPipeline(
  args: ReductionPipelineArgs
): Promise<ReductionPipelineResult> {
  const resultLength = args.toolResult.length;
  const evidenceStart = args.toolResult.slice(0, 300);

  // Check for root-cause failures that should not be classified as large_result
  const rootCause = detectRootCauseSemanticFailure("", args.toolResult);
  if (rootCause.detected) {
    return {
      transformed: false,
      compactText: "",
      scannedCount: 0,
      matchedCount: 0,
      evidenceText: evidenceStart,
      failureReason: `Root cause: ${rootCause.reason}. Should not apply reduction. Return failure.type='${rootCause.failureType}' instead.`,
    };
  }

  // Check if reduction is needed
  if (!shouldApplyReduction({
    resultText: args.toolResult,
    hadToolActivity: args.hadToolActivity,
    hasExplicitTruncation: /TRUNCATED|token limit|context limit/i.test(args.toolResult),
  })) {
    return {
      transformed: false,
      compactText: args.toolResult,
      scannedCount: 0,
      matchedCount: 0,
      evidenceText: evidenceStart,
    };
  }

  // Try to parse as JSON and extract fields
  let extracted: unknown[] = [];
  let scannedCount = 0;
  let matchedCount = 0;
  let fields: string[] = [];

  try {
    const raw = JSON.parse(args.toolResult);
    const requestedFields = extractRequestedFieldsFromRequest(args.userRequest);
    fields = requestedFields ?? ["id", "name", "status", "type"];

    // Extract helper
    const extract = (item: unknown) => {
      if (!item || typeof item !== "object") return item;
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        if (f in (item as Record<string, unknown>)) {
          obj[f] = (item as Record<string, unknown>)[f];
        }
      }
      return obj;
    };

    // Determine items to extract
    let items: unknown[] = [];
    if (Array.isArray(raw)) {
      items = raw;
      scannedCount = raw.length;
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      // Try common list keys
      const listKeys = ["items", "results", "records", "data", "entries", "objects"];
      for (const key of listKeys) {
        if (Array.isArray(obj[key])) {
          items = obj[key] as unknown[];
          scannedCount = items.length;
          break;
        }
      }
      if (items.length === 0) {
        items = [raw];
        scannedCount = 1;
      }
    } else {
      items = [raw];
      scannedCount = 1;
    }

    // Limit to MAX_INLINE_ITEMS
    const limited = items.slice(0, MAX_INLINE_ITEMS);
    matchedCount = limited.length;
    extracted = limited.map(extract);

    // Format as compact text
    const compactText = formatReductionResult({
      extracted,
      scannedCount,
      matchedCount,
      fields,
      userRequest: args.userRequest,
    });

    return {
      transformed: true,
      compactText,
      scannedCount,
      matchedCount,
      evidenceText: evidenceStart,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      transformed: false,
      compactText: "",
      scannedCount: 0,
      matchedCount: 0,
      evidenceText: evidenceStart,
      failureReason: `Extraction failed: ${reason}. Switch to pagination mode.`,
    };
  }
}
