/**
 * Success-aware finalization for delegated ToolAgent tasks.
 *
 * Core problem: Earlier exploratory tool calls may fail (e.g., "spec not defined"),
 * but later tool calls may succeed and return usable API data. The final failure
 * classification should prioritize the LATEST terminal state (success with data)
 * over earlier exploratory errors.
 *
 * This module provides helpers to:
 * 1. Detect successful API data retrieval from tool outputs
 * 2. Track tool call sequence and results
 * 3. Classify failure only when NO usable success path exists
 * 4. Extract usable data from truncated/malformed results as fallback
 */

import type { ToolAgentResultEnvelope, ToolAgentFailureDetail } from "./delegation";

/** Represents a single tool call in the transcript. */
export interface ToolCallRecord {
  /** 0-indexed sequence number (tool call order) */
  sequence: number;
  /** Tool name (e.g., "codemode", "openapi_search", "tools_call") */
  toolName: string;
  /** Whether the tool call reported ok=true or error */
  ok: boolean;
  /** Error message if ok=false */
  error?: string;
  /** Tool output/result if ok=true */
  result?: string;
  /** Approximate size of result payload */
  resultLength: number;
  /** Whether result contains usable data (non-empty, not just status) */
  hasUsableData: boolean;
}

export interface FallbackExtractionResult {
  /** Whether extraction succeeded (found some usable data) */
  success: boolean;
  /** Extracted fields/records as compact text */
  extractedText: string;
  /** How many items were scanned */
  scannedCount?: number;
  /** How many items matched filters */
  matchedCount?: number;
  /** Extraction strategy used */
  strategy: "full_json_parse" | "regex_object_scan" | "field_extraction" | "not_found";
}

export interface CompactReducedTerminalData {
  scannedCount: number;
  matchedCount: number;
  matched: unknown[];
}

function normalizeRuleRow(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const id = row.rule_id ?? row.id ?? row.ruleId;
  const name = row.rule_name ?? row.ruleName ?? row.name;
  if (id === undefined && name === undefined) return undefined;
  const normalized: Record<string, unknown> = {};
  if (id !== undefined) normalized.rule_id = id;
  if (name !== undefined) normalized.rule_name = name;
  return normalized;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractCompactReducedPayload(
  value: unknown,
  depth: number = 0
): CompactReducedTerminalData | undefined {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  if (isCompactReducedPayload(value)) return value;

  const rec = value as Record<string, unknown>;
  const scannedCount = toFiniteNumber(rec.scannedCount);
  const matchedCount = toFiniteNumber(rec.matchedCount);
  const rules = Array.isArray(rec.rules) ? rec.rules : undefined;
  const matched = Array.isArray(rec.matched) ? rec.matched : undefined;

  if (scannedCount !== undefined && matchedCount !== undefined) {
    if (matched) {
      return {
        scannedCount,
        matchedCount,
        matched,
      };
    }
    if (rules) {
      const normalizedRules = rules
        .map((r) => normalizeRuleRow(r) ?? r)
        .filter((r) => r !== undefined);
      return {
        scannedCount,
        matchedCount,
        matched: normalizedRules,
      };
    }
  }

  const wrappers = ["result", "data", "response", "payload", "output", "apiResult"];
  for (const key of wrappers) {
    if (rec[key] === undefined) continue;
    const nested = extractCompactReducedPayload(rec[key], depth + 1);
    if (nested) return nested;
  }

  return undefined;
}

function isCompactReducedPayload(value: unknown): value is CompactReducedTerminalData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.scannedCount === "number" &&
    typeof rec.matchedCount === "number" &&
    Array.isArray(rec.matched)
  );
}

export function formatCompactMatchedResultText(data: CompactReducedTerminalData): string {
  const header = `Matched ${data.matchedCount} of ${data.scannedCount} scanned item(s).`;
  if (!Array.isArray(data.matched) || data.matched.length === 0) {
    return `${header}\n\nNo matched items.`;
  }

  const allObjects = data.matched.every(
    (v) => v && typeof v === "object" && !Array.isArray(v)
  );

  if (allObjects) {
    const rows = data.matched as Array<Record<string, unknown>>;
    const ruleIdOnly = rows.every((row) => {
      const keys = Object.keys(row);
      return keys.length === 1 && keys[0] === "rule_id";
    });
    if (ruleIdOnly) {
      const lines = rows.map((row) => `| ${String(row.rule_id ?? "")} |`);
      return [
        header,
        "",
        "| rule id |",
        "| --- |",
        ...lines,
      ].join("\n");
    }

    const ruleIdAndName = rows.every((row) => {
      const keys = Object.keys(row);
      return keys.length === 2 && keys.includes("rule_id") && keys.includes("name");
    });
    if (ruleIdAndName) {
      const lines = rows.map((row) => `| ${String(row.rule_id ?? "")} | ${String(row.name ?? "")} |`);
      return [
        header,
        "",
        "| rule id | rule name |",
        "| --- | --- |",
        ...lines,
      ].join("\n");
    }

    const ruleIdAndRuleName = rows.every((row) => {
      const keys = Object.keys(row);
      return keys.length === 2 && keys.includes("rule_id") && keys.includes("rule_name");
    });
    if (ruleIdAndRuleName) {
      const lines = rows.map(
        (row) => `| ${String(row.rule_id ?? "")} | ${String(row.rule_name ?? "")} |`
      );
      return [
        header,
        "",
        "| rule id | rule name |",
        "| --- | --- |",
        ...lines,
      ].join("\n");
    }

    const idAndName = rows.every((row) => {
      const keys = Object.keys(row);
      return keys.length === 2 && keys.includes("id") && keys.includes("name");
    });
    if (idAndName) {
      const lines = rows.map((row) => `| ${String(row.id ?? "")} | ${String(row.name ?? "")} |`);
      return [
        header,
        "",
        "| rule id | rule name |",
        "| --- | --- |",
        ...lines,
      ].join("\n");
    }

    const ruleIdCamelAndRuleNameCamel = rows.every((row) => {
      const keys = Object.keys(row);
      return keys.length === 2 && keys.includes("ruleId") && keys.includes("ruleName");
    });
    if (ruleIdCamelAndRuleNameCamel) {
      const lines = rows.map(
        (row) => `| ${String(row.ruleId ?? "")} | ${String(row.ruleName ?? "")} |`
      );
      return [
        header,
        "",
        "| rule id | rule name |",
        "| --- | --- |",
        ...lines,
      ].join("\n");
    }
  }

  return `${header}\n\n${JSON.stringify(data.matched, null, 2)}`;
}

/**
 * Detects whether a tool output is a raw API response (not reduced).
 * Raw payloads have "response" or "success"/"result" wrappers without reduction metadata.
 * Reduced payloads have scannedCount/matchedCount metadata.
 */
export function isRawApiPayload(toolOutput: string | undefined): boolean {
  if (!toolOutput || typeof toolOutput !== "string") return false;

  const trimmed = toolOutput.trim();
  if (trimmed.length === 0) return false;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      // Nested execute wrappers may contain reduced metadata under result/result.rules.
      if (extractCompactReducedPayload(parsed)) {
        return false;
      }

      // Reduced payloads always have these metadata fields
      if (
        typeof (parsed as Record<string, unknown>).scannedCount === "number" ||
        typeof (parsed as Record<string, unknown>).matchedCount === "number"
      ) {
        return false; // Has reduction metadata - not raw
      }

      // Raw API responses have bare success/result wrappers without reduction
      if ((parsed as Record<string, unknown>).response !== undefined) {
        return true; // Bare response wrapper is raw payload
      }

      const rec = parsed as Record<string, unknown>;
      if (
        rec.success !== undefined &&
        !(typeof rec.scannedCount === "number" || typeof rec.matchedCount === "number") &&
        (rec.result !== undefined || rec.data !== undefined)
      ) {
        // success + result/data wrapper without reduction metadata is raw
        return true;
      }
    }
  } catch {
    // Malformed JSON, not a raw API payload in structured form
  }

  return false;
}

/**
 * Detects whether a tool output represents successful API data retrieval.
 * Returns true for outputs that indicate real data was returned, even if partial.
 * Now also checks that raw payloads (without reduction metadata) are flagged appropriately.
 */
export function detectUsableSuccessfulData(toolOutput: string | undefined): boolean {
  if (!toolOutput || typeof toolOutput !== "string") return false;

  const trimmed = toolOutput.trim();
  if (trimmed.length === 0) return false;

  // Detect JSON with success indicator
  if (/["\s]success["'\s]*:\s*true/.test(trimmed)) return true;

  // Detect HTTP 2xx status (but not in error messages)
  if (/\b(200|201|202|204|2\d{2})\b|\bOK\b/i.test(trimmed)) {
    // Make sure it's not an error message
    const firstLine = trimmed.split("\n")[0]!;
    if (!/\b(fail|error|failed|timeout|denied|unauthorized|forbidden|cannot|invalid)\b/i.test(firstLine)) {
      return true;
    }
  }

  // Detect JSON array or object wrapping results
  const t = trimmed.slice(0, 1);
  if (t === "[" || t === "{") {
    try {
      const parsed = JSON.parse(trimmed);
      // Don't return true just for valid JSON — check for actual data
      if (typeof parsed === "object" && parsed !== null) {
        // If success field exists and is false, this is not a success
        if ((parsed as Record<string, unknown>).success === false) {
          return false;
        }
        // If error field exists, this is likely an error response
        if ((parsed as Record<string, unknown>).error && !(parsed as Record<string, unknown>).data) {
          return false;
        }
        // Discovery/spec-only helper outputs are not terminal task success.
        const rec = parsed as Record<string, unknown>;
        const keys = Object.keys(rec);
        const discoveryOnlyKeys = new Set([
          "ok",
          "path",
          "method",
          "openapiParameterSlots",
          "openapiRequestBodies",
          "endpoints",
          "operations",
        ]);
        const looksDiscoveryOnly =
          keys.length > 0 &&
          keys.every((k) => discoveryOnlyKeys.has(k)) &&
          !(typeof rec.scannedCount === "number" || typeof rec.matchedCount === "number");
        if (looksDiscoveryOnly) return false;
        if (rec.ok === true && keys.length === 1) return false;
      }

      if (Array.isArray(parsed) && parsed.length > 0) return true;
      if (typeof parsed === "object" && parsed !== null) {
        // Check for result/data/items wrapper keys
        const wrapperKeys = ["result", "results", "data", "items", "records", "objects", "entries", "resources"];
        for (const k of wrapperKeys) {
          const v = (parsed as Record<string, unknown>)[k];
          if (Array.isArray(v) && v.length > 0) return true;
          if (v && typeof v === "object") return true;
        }
        // Any non-empty object is potentially usable
        if (Object.keys(parsed).length > 0) return true;
      }
    } catch {
      // Malformed JSON — check for partial data markers
      if (/\{.*"(id|name|status|type)"\s*:/i.test(trimmed)) return true;
      if (/\[.*\{.*"id"\s*:/i.test(trimmed)) return true;
    }
  }

  return false;
}

function isDiscoveryOnlyTerminalOutput(
  toolName: string | undefined,
  output: string | undefined
): boolean {
  const name = (toolName ?? "").toLowerCase();
  if (name === "openapi_search" || name === "openapi_describe_operation" || name === "tools_describe") {
    return true;
  }
  if (!output || typeof output !== "string") return false;
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const rec = JSON.parse(trimmed) as Record<string, unknown>;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return false;
    const keys = Object.keys(rec);
    const discoveryOnlyKeys = new Set([
      "ok",
      "path",
      "method",
      "openapiParameterSlots",
      "openapiRequestBodies",
      "endpoints",
      "operations",
    ]);
    const hasReducedMetadata =
      typeof rec.scannedCount === "number" || typeof rec.matchedCount === "number" || Array.isArray(rec.matched);
    if (hasReducedMetadata) return false;
    return keys.length > 0 && keys.every((k) => discoveryOnlyKeys.has(k));
  } catch {
    return false;
  }
}

/**
 * Tracks tool calls in synthesis text and identifies the chronological terminal state.
 * Parses tool_invocation markers and synthesized output blocks.
 *
 * Example synthesis text:
 * ```
 * [openapi_search]
 * spec is not defined
 *
 * ---
 *
 * [codemode]
 * {"id": 1, "name": "Resource A"}
 * ```
 *
 * Returns records sorted by sequence (earliest first).
 */
export function parseToolCallSequence(synthesisText: string): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  if (!synthesisText || typeof synthesisText !== "string") return records;

  // Split on common tool-output boundary markers
  const blocks = synthesisText.split(/\n---\n|\n\n\n(?=\[)/);

  let sequence = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Try to extract tool name from [toolName] markers
    const nameMatch = /^\[([^\]]+)\]\n/.exec(trimmed);
    const toolName = nameMatch ? nameMatch[1]!.trim().toLowerCase() : "unknown";

    // Extract the output (everything after the tool name marker)
    const output = nameMatch ? trimmed.slice(nameMatch[0].length) : trimmed;
    const outputTrimmed = output.trim();

    // Heuristic: if output contains error keywords and no data, mark as error
    const hasErrorKeywords =
      /\b(error|failed|failed to|cannot|unsupported|not defined|missing|invalid|unauthorized|forbidden)\b/i.test(
        outputTrimmed.slice(0, 500)
      );
    const hasData = detectUsableSuccessfulData(outputTrimmed);

    records.push({
      sequence: sequence++,
      toolName,
      ok: !hasErrorKeywords || hasData,
      error: hasErrorKeywords && !hasData ? outputTrimmed.slice(0, 200) : undefined,
      result: hasData ? outputTrimmed : undefined,
      resultLength: outputTrimmed.length,
      hasUsableData: hasData,
    });
  }

  return records;
}

/**
 * Identifies the latest (chronologically last) successful tool call with usable data.
 * If found, that call's output should be used for success classification,
 * regardless of earlier failed or exploratory calls.
 */
export function findTerminalSuccessfulCall(records: ToolCallRecord[]): ToolCallRecord | undefined {
  // A success is terminal only if it appears after the most recent failure.
  // This prevents earlier successes from masking later semantic/runtime failures.
  let lastFailureIndex = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i]!.ok) {
      lastFailureIndex = i;
      break;
    }
  }

  // Reverse order (latest first), but only consider successes after last failure.
  for (let i = records.length - 1; i > lastFailureIndex; i--) {
    const r = records[i]!;
    if (r.ok && r.hasUsableData) return r;
  }
  return undefined;
}

/**
 * Extracts usable data from a result string using multiple fallback strategies.
 * Used when full JSON.parse fails but we need to recover partial data.
 *
 * Strategies (in order):
 * 1. Full JSON parse (already tried, but included for completeness)
 * 2. Regex-based object scanning (find {...} patterns)
 * 3. Field extraction from likely key=value or "key": value patterns
 * 4. Give up and return not_found
 */
export function fallbackResultExtractor(
  resultText: string,
  maxItems: number = 50
): FallbackExtractionResult {
  if (!resultText || typeof resultText !== "string") {
    return { success: false, extractedText: "", strategy: "not_found" };
  }

  const trimmed = resultText.trim();
  if (trimmed.length === 0) {
    return { success: false, extractedText: "", strategy: "not_found" };
  }

  // Strategy 1: Try full parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const items = parsed.slice(0, maxItems);
      return {
        success: true,
        extractedText: items.map((i) => JSON.stringify(i)).join("\n"),
        scannedCount: parsed.length,
        matchedCount: items.length,
        strategy: "full_json_parse",
      };
    }
    if (typeof parsed === "object" && parsed !== null) {
      // Try to find array wrapper
      const wrapperKeys = ["result", "results", "data", "items", "records", "objects"];
      for (const k of wrapperKeys) {
        const v = (parsed as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          const items = v.slice(0, maxItems);
          return {
            success: true,
            extractedText: items.map((i) => JSON.stringify(i)).join("\n"),
            scannedCount: v.length,
            matchedCount: items.length,
            strategy: "full_json_parse",
          };
        }
      }
      // Single object is also valid
      return {
        success: true,
        extractedText: JSON.stringify(parsed),
        strategy: "full_json_parse",
      };
    }
  } catch {
    // Fall through to regex strategy
  }

  // Strategy 2: Regex-based object scanning
  // Look for {...} patterns that might be JSON objects
  const objectMatches = [...trimmed.matchAll(/\{[^{}]*(?:"[^"]*"\s*:\s*[^,}]*(?:,\s*"[^"]*"\s*:\s*[^,}]*)*)*\}/g)];
  if (objectMatches.length > 0) {
    const items: string[] = [];
    for (const match of objectMatches.slice(0, maxItems)) {
      try {
        const obj = JSON.parse(match[0]!);
        if (typeof obj === "object" && obj !== null) {
          items.push(JSON.stringify(obj));
        }
      } catch {
        // Invalid JSON in match, skip
      }
    }
    if (items.length > 0) {
      return {
        success: true,
        extractedText: items.join("\n"),
        scannedCount: objectMatches.length,
        matchedCount: items.length,
        strategy: "regex_object_scan",
      };
    }
  }

  // Strategy 3: Field extraction from key=value or "key": value patterns
  // Look for lines with common field names
  const lines = trimmed.split("\n");
  const fieldPatterns = ["id", "name", "status", "type", "title", "email", "url"];
  const extracted: string[] = [];

  for (const line of lines) {
    for (const field of fieldPatterns) {
      const regexStr = `"${field}"\\s*:\\s*"?([^",}]*)"?`;
      const regex = new RegExp(regexStr, "i");
      const match = regex.exec(line);
      if (match) {
        extracted.push(`${field}=${match[1]!}`);
        break;
      }
    }
    if (extracted.length >= maxItems) break;
  }

  if (extracted.length > 0) {
    return {
      success: true,
      extractedText: extracted.join("\n"),
      matchedCount: extracted.length,
      strategy: "field_extraction",
    };
  }

  return { success: false, extractedText: "", strategy: "not_found" };
}

export interface SuccessAwareFinalizeArgs {
  /** Tool synthesis text from the chat thread (all tool calls and outputs) */
  synthesisText: string;
  /** Final model-generated result text */
  resultText: string;
  /** Any error message from the execution layer */
  errorText: string;
  /** Whether any tool was invoked */
  hadToolActivity: boolean;
}

export interface SuccessAwareFinalizeResult {
  /** Should we treat this as success? (even if there were earlier errors) */
  shouldBeSuccess: boolean;
  /** Extracted/reduced result text if usable data was found */
  extractedResult?: string;
  /** Count of items scanned (for pagination metadata) */
  scannedCount?: number;
  /** Count of items matched (for pagination metadata) */
  matchedCount?: number;
  /** Matched compact items preserved for downstream envelope/result rendering */
  matched?: unknown[];
  /** Which stage detected the terminal success/failure */
  where?: string;
  /** If no success found, which error should be treated as terminal */
  terminalErrorText?: string;
  /** Warnings for earlier non-terminal failures to include */
  warnings: string[];
}

/**
 * Main entry point: determines whether a ToolAgent result should be classified
 * as success or failure, considering tool call chronology and usable data.
 *
 * Core logic:
 * 1. Parse tool call sequence from synthesis text
 * 2. If ANY later tool call has usable data → SUCCESS (ignore earlier errors)
 * 3. If all attempts fail with semantic errors → FAILURE with latest error
 * 4. If reduction/extraction fails but data is recoverable → TRY FALLBACK EXTRACTION
 */
export function finalizeSuccessAware(args: SuccessAwareFinalizeArgs): SuccessAwareFinalizeResult {
  const warnings: string[] = [];

  // Step 1: Parse tool call sequence from synthesis
  const toolCalls = parseToolCallSequence(args.synthesisText);

  // Step 2: Look for terminal success (latest successful call with data)
  const terminalSuccess = findTerminalSuccessfulCall(toolCalls);
  if (terminalSuccess) {
    if (isDiscoveryOnlyTerminalOutput(terminalSuccess.toolName, terminalSuccess.result)) {
      warnings.push(
        `Terminal result is discovery/schema metadata only (${terminalSuccess.toolName}); ` +
          `final success requires compact API data from cloudflare_request/reduced output.`
      );
      // Fall through to failure classification.
    } else
    // Check if this success is a raw API payload (not reduced)
    if (isRawApiPayload(terminalSuccess.result)) {
      // Raw payload when reduction was expected = failure
      warnings.push(
        `Terminal result contains raw API payload (no reduction metadata like scannedCount/matchedCount). ` +
          `Expected reduced output with field filtering and metadata.`
      );
      // Fall through to failure classification
    } else {
      // Report any earlier errors as warnings
      for (let i = 0; i < terminalSuccess.sequence; i++) {
        const prior = toolCalls[i];
        if (prior && !prior.ok && prior.error) {
          warnings.push(`Earlier: ${prior.toolName} failed with: ${prior.error.slice(0, 100)}`);
        }
      }

      // Use the terminal success result (it's reduced or has scannedCount metadata)
      let extracted = null;
      let scannedCount: number | undefined;
      let matchedCount: number | undefined;
      let matched: unknown[] | undefined;

      // For reduced payloads, try to extract scannedCount/matchedCount metadata
      if (terminalSuccess.result) {
        try {
          const parsed = JSON.parse(terminalSuccess.result);
          const compact = extractCompactReducedPayload(parsed);
          if (compact) {
            return {
              shouldBeSuccess: true,
              extractedResult: formatCompactMatchedResultText(compact),
              scannedCount: compact.scannedCount,
              matchedCount: compact.matchedCount,
              matched: compact.matched,
              where: terminalSuccess.toolName,
              warnings,
            };
          }

          if (typeof parsed === "object" && parsed !== null) {
            if (isCompactReducedPayload(parsed)) {
              return {
                shouldBeSuccess: true,
                extractedResult: formatCompactMatchedResultText(parsed),
                scannedCount: parsed.scannedCount,
                matchedCount: parsed.matchedCount,
                matched: parsed.matched,
                where: terminalSuccess.toolName,
                warnings,
              };
            }
            scannedCount = typeof (parsed as Record<string, unknown>).scannedCount === "number" 
              ? (parsed as Record<string, unknown>).scannedCount as number 
              : undefined;
            matchedCount = typeof (parsed as Record<string, unknown>).matchedCount === "number" 
              ? (parsed as Record<string, unknown>).matchedCount as number 
              : undefined;
            matched = Array.isArray((parsed as Record<string, unknown>).matched)
              ? ((parsed as Record<string, unknown>).matched as unknown[])
              : undefined;
          }
        } catch {
          // Not JSON, continue with fallback
        }
      }

      // For large payloads, use full extraction
      if (terminalSuccess.result && terminalSuccess.resultLength > 40_000) {
        extracted = fallbackResultExtractor(terminalSuccess.result);
        scannedCount = extracted.scannedCount ?? scannedCount;
        matchedCount = extracted.matchedCount ?? matchedCount;
      }

      return {
        shouldBeSuccess: true,
        extractedResult: extracted?.success ? extracted.extractedText : terminalSuccess.result,
        scannedCount,
        matchedCount,
        matched,
        where: terminalSuccess.toolName,
        warnings,
      };
    }
  }

  // Step 3: If result text has usable data despite tool synthesis errors, extract it
  if (args.resultText && detectUsableSuccessfulData(args.resultText)) {
    if (isDiscoveryOnlyTerminalOutput("final_result_text", args.resultText)) {
      warnings.push(
        "Final result contains discovery/schema metadata only; terminal success requires compact API data."
      );
      // Fall through to failure classification.
    } else
    // Check if this is a raw API payload
    if (isRawApiPayload(args.resultText)) {
      // Raw payload in final result = reduction failed
      warnings.push(
        `Final result contains raw API payload without reduction metadata. ` +
          `Expected reduced output with scannedCount/matchedCount.`
      );
      // Fall through to failure
    } else {
      try {
        const parsed = JSON.parse(args.resultText);
        const compact = extractCompactReducedPayload(parsed);
        if (compact) {
          return {
            shouldBeSuccess: true,
            extractedResult: formatCompactMatchedResultText(compact),
            scannedCount: compact.scannedCount,
            matchedCount: compact.matchedCount,
            matched: compact.matched,
            where: "final_result_text",
            warnings,
          };
        }

        if (isCompactReducedPayload(parsed)) {
          return {
            shouldBeSuccess: true,
            extractedResult: formatCompactMatchedResultText(parsed),
            scannedCount: parsed.scannedCount,
            matchedCount: parsed.matchedCount,
            matched: parsed.matched,
            where: "final_result_text",
            warnings,
          };
        }
      } catch {
        // Non-JSON final result path continues with fallback extraction.
      }
      // Earlier tool calls failed, but we have usable final result text (reduced)
      const extracted = fallbackResultExtractor(args.resultText);
      if (extracted.success) {
        for (const call of toolCalls.filter((c) => !c.ok)) {
          if (call.error) {
            warnings.push(`Earlier: ${call.toolName} failed with: ${call.error.slice(0, 100)}`);
          }
        }
        return {
          shouldBeSuccess: true,
          extractedResult: extracted.extractedText,
          scannedCount: extracted.scannedCount,
          matchedCount: extracted.matchedCount,
          where: "final_result_text",
          warnings,
        };
      }
    }
  }

  // Step 4: No usable success found — classify as failure
  // Use the latest error (not the earliest)
  let terminalError = args.errorText || "";
  if (toolCalls.length > 0) {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const call = toolCalls[i]!;
      if (!call.ok && call.error) {
        terminalError = call.error;
        break;
      }
    }
  }

  // If we detected raw payloads as the issue, include that in the error
  if (warnings.length > 0) {
    terminalError = warnings.join(" ") || terminalError || "Reduction failed: raw API payload returned";
  }

  return {
    shouldBeSuccess: false,
    terminalErrorText: terminalError,
    where: "final_state",
    warnings,
  };
}
