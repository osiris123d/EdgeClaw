import type { ToolAgentFailureDetail, ToolAgentResultEnvelope } from "./delegation";
import {
  MAX_FINAL_RESPONSE_CHARS,
  isLikelyLargeResult,
  clampToolEvidenceForEnvelope,
} from "./toolAgentLargeResultGuards";

interface BuildToolAgentEnvelopeArgs {
  ok: boolean;
  resultText?: string;
  errorText?: string;
  toolSynthesisText?: string;
  hadToolActivity: boolean;
  /** Pre-computed scanned count from paginated extraction. */
  scannedCount?: number;
  /** Pre-computed matched count from paginated extraction. */
  matchedCount?: number;
  /** Compact matched records from reduced payload. */
  matched?: unknown[];
  /** Artifact/workspace key where full findings are stored. */
  artifactPointer?: string;
  /** Explicit where hint for failure classification. */
  whereHint?: string;
  /** Whether failure occurred during reduction pipeline. */
  couldBeReductionFailure?: boolean;
  /** Whether failure occurred during finalization/extraction. */
  couldBeFinalizationFailure?: boolean;
}

function compactInline(s: string, maxLen = 600): string {
  const out = s.replace(/\s+/g, " ").trim();
  return out.length > maxLen ? `${out.slice(0, maxLen)}...` : out;
}

/**
 * Extract compact evidence snippets (max 3 snippets, max 300 chars each).
 * Prioritizes lines matching key error patterns, then adds additional context lines.
 * Used to keep evidence digestible and avoid raw dumps in assistant-visible text.
 */
function extractCompactEvidence(evidenceCorpus: string): string {
  if (!evidenceCorpus) return "";
  
  const lines = evidenceCorpus.split("\n").filter(l => l.trim().length > 0);
  const snippets: string[] = [];
  
  // Prioritize lines that match key error patterns
  const priorityPatterns = [
    /conflicting[_\s-]?tool[_\s-]?input/i,
    /authentication error|authorization|permission/i,
    /multiple accounts/i,
    /account_id/i,
    /missing|required/i,
    /spec is not defined/i,
    /cannot.*perform/i,
  ];
  
  for (const pattern of priorityPatterns) {
    for (const line of lines) {
      if (pattern.test(line) && snippets.length < 3) {
        const snippet = line.replace(/\s+/g, " ").trim();
        const clamped = snippet.length > 300 ? snippet.slice(0, 300) + "…" : snippet;
        if (!snippets.includes(clamped)) snippets.push(clamped);
      }
    }
  }
  
  // If we don't have 3 yet, add more lines
  for (const line of lines) {
    if (snippets.length >= 3) break;
    const snippet = line.replace(/\s+/g, " ").trim();
    const clamped = snippet.length > 300 ? snippet.slice(0, 300) + "…" : snippet;
    if (!snippets.includes(clamped)) snippets.push(clamped);
  }
  
  return snippets.join(" | ");
}

function detectWhere(text: string, context?: { hadToolActivity?: boolean; couldBeReductionFailure?: boolean; couldBeFinalizationFailure?: boolean }): string | undefined {
  // Check for explicit where markers that indicate terminal success/failure location
  if (context?.couldBeReductionFailure && /reduction_pipeline|extracted|transformed|compacted|scannedCount|matchedCount/i.test(text)) {
    return "reduction_pipeline";
  }

  if (context?.couldBeFinalizationFailure && /fallback_extraction|parsed.*fields|final_result_text|extracted_result/i.test(text)) {
    return "finalization";
  }

  // Tool-specific detections (last tool that was invoked is most likely terminal failure location)
  const toolMarkers = [
    { re: /\btools_call\b/i, where: "tools_call" },
    { re: /\btools_call_code\b/i, where: "tools_call_code" },
    { re: /\bopenapi_search\b/i, where: "openapi_search" },
    { re: /\bopenapi_describe_operation\b/i, where: "openapi_describe_operation" },
    { re: /\bcloudflare_request\b/i, where: "http_relay" },
    { re: /\bmcp\b/i, where: "mcp_tool" },
    { re: /\bcodemode\b/i, where: "codemode" },
  ];

  // Find LAST occurrence of any tool marker (most recent tool activity)
  let lastMatch: { pos: number; where: string } | null = null;
  for (const marker of toolMarkers) {
    let pos = 0;
    let match;
    // Find all occurrences of this marker
    const regex = new RegExp(marker.re.source, marker.re.flags + "g");
    while ((match = regex.exec(text)) !== null) {
      if (match.index > (lastMatch?.pos ?? -1)) {
        lastMatch = { pos: match.index, where: marker.where };
      }
    }
  }

  return lastMatch?.where;
}

export function classifyToolAgentFailure(args: {
  resultText?: string;
  errorText?: string;
  hadToolActivity: boolean;
  whereHint?: string;
  couldBeReductionFailure?: boolean;
  couldBeFinalizationFailure?: boolean;
}): ToolAgentFailureDetail | null {
  const result = (args.resultText ?? "").trim();
  const error = (args.errorText ?? "").trim();
  const evidenceCorpus = [error, result].filter(Boolean).join("\n");
  const where = args.whereHint || detectWhere(evidenceCorpus, {
    hadToolActivity: args.hadToolActivity,
    couldBeReductionFailure: args.couldBeReductionFailure,
    couldBeFinalizationFailure: args.couldBeFinalizationFailure,
  });
  const compactEvidence = extractCompactEvidence(evidenceCorpus);

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIORITY 1: Semantic root-cause errors — always checked first.
  // Priority order:
  //   conflicting_tool_input > auth/permission > missing_tool_input > wrong_tool_api
  //   > invalid_tool_input > too_much_data/large_result > timeout > tool_error
  // A large/truncated transcript made of repeated semantic errors must still be
  // classified by its root cause, NOT transcript size.
  // ─────────────────────────────────────────────────────────────────────────────

  if (/mcp-required-input-inject-conflict|\bconflicting_tool_input\b|existing=.*context=/i.test(evidenceCorpus)) {
    return {
      type: "conflicting_tool_input",
      where,
      semanticKey: "conflicting_tool_input:top_level_identifier_mismatch",
      whatFailed: "Conflicting top-level tool inputs were detected before native MCP execution.",
      summary: "Conflicting top-level tool inputs were detected before native MCP execution.",
      evidence: compactEvidence,
      suggestedFix:
        "Use exactly one authoritative value for each top-level native tool input (account_id, organization_id, project_id, workspace_id, tenant_id, region). " +
        "Do not provide conflicting values across task text, runtime context, and explicit tool input.",
      suggestedRetryPrompt:
        "Retry delegated tool task with one consistent top-level tool input value per required identifier. " +
        "If multiple candidate identifiers exist, resolve the conflict first and then call native execute once.",
    };
  }

  if (/\b(?:forbidden|permission denied|not authorized|authorization error|insufficient permissions?)\b|\b403\b/i.test(evidenceCorpus)) {
    return {
      type: "permission_error",
      where,
      semanticKey: "permission_error:provider_access_denied",
      whatFailed: "The native MCP execute call reached the provider, but permissions are insufficient for the requested resource.",
      summary: "The native MCP execute call reached the provider, but permissions are insufficient for the requested resource.",
      evidence: compactEvidence,
      suggestedFix:
        "Verify role/permission grants for the selected token, project, organization, workspace, or tenant before retrying.",
      suggestedRetryPrompt:
        "Retry delegated tool task only after confirming the selected credential has the required permissions. " +
        "Do not retry by moving identifiers into path/query/knownValues.",
    };
  }

  // Auth error: Cloudflare API error 10000 (Authentication error) — token/account binding issue.
  // Must be checked BEFORE missing_tool_input to prevent reclassification.
  if (/Cloudflare API error:\s*10000|Authentication error/i.test(evidenceCorpus)) {
    return {
      type: "auth_error",
      where,
      semanticKey: "auth_error:cloudflare_api_10000",
      whatFailed: "The MCP execute call reached Cloudflare, but the selected token/account context is not authorized for the requested account.",
      summary: "The MCP execute call reached Cloudflare, but the selected token/account context is not authorized for the requested account.",
      evidence: compactEvidence,
      suggestedFix:
        "The selected Cloudflare token does not have permission for the target account. " +
        "Verify the token/account binding and that the target account is available to the selected credential. " +
        "Do not retry by moving account_id into path/query/knownValues.",
      suggestedRetryPrompt:
        "Retry delegated tool task after verifying the Cloudflare token/account binding has access to the requested account. " +
        "Do not retry by moving account_id into HTTP parameters or codemode knownValues — that will not fix the auth issue.",
    };
  }

  // Specific "Multiple accounts available" — native tool requires account_id.
  if (/Multiple accounts available|multiple accounts.*specify.*account_id/i.test(evidenceCorpus)) {
    return {
      type: "missing_tool_input",
      where,
      semanticKey: "missing_tool_input:account_id",
      whatFailed: "ToolAgent could not continue because required MCP tool input (account_id) was missing.",
      summary: "ToolAgent could not continue because required MCP tool input (account_id) was missing.",
      evidence: compactEvidence,
      suggestedFix:
        "Pass the required account_id at the native MCP tool invocation level, not inside HTTP path/query/knownValues. " +
        "The native MCP execute tool must receive account_id as a top-level tool argument.",
      suggestedRetryPrompt:
        "Retry delegated tool task. Call the native MCP execute tool directly with account_id as a top-level tool input argument. " +
        "Do not place account_id in HTTP query parameters, path segments, or codemode knownValues.",
    };
  }

  if (
    /missing_required_tool_input|missing[_\s-]?account[_\s-]?id|account[_\s-]?id[^\n]{0,80}(required|missing)|multiple accounts?|please specify[^\n]{0,80}parameter/i.test(
      evidenceCorpus
    )
  ) {
    return {
      type: "missing_tool_input",
      where,
      semanticKey: "missing_tool_input:generic",
      whatFailed: "ToolAgent could not continue because required MCP tool input was missing or ambiguous.",
      summary: "ToolAgent could not continue because required MCP tool input was missing or ambiguous.",
      evidence: compactEvidence,
      suggestedFix:
        "Provide required identifiers explicitly (for example account/project/resource ids) and disambiguate when multiple candidates exist. " +
        "Pass these as top-level tool arguments, not inside query/path/knownValues.",
      suggestedRetryPrompt:
        "Retry delegated tool task. Before calling tools, identify required input parameters from tool descriptions and provide explicit values for all required identifiers as top-level tool inputs.",
    };
  }

  if (
    /spec is not defined|unknown_helper_argument|unknown_wrapped_tool|no_wrapped_execute_tool|execute_tool_missing|tools_call[_\s-]?(?:invalid|invalid_input)|invalid tools_call input|wrong tool api|spec_not_defined_in_execute_tool/i.test(
      evidenceCorpus
    )
  ) {
    // Separate sub-classification: missing_openapi_describe_same_invocation is a describe/cache
    // failure (chain was followed but describe cache is empty), NOT a generic wrong-tool-api.
    if (
      /missing_openapi_describe_same_invocation|wrong_tool_api:missing_same_invocation_describe|openapi_describe_failed_same_invocation/i.test(
        evidenceCorpus
      )
    ) {
      return {
        type: "non_retryable",
        where,
        semanticKey: "describe_cache_failure:missing_same_invocation_describe",
        whatFailed:
          "cloudflare_request was blocked because openapi_describe_operation did not cache a result for this invocation.",
        summary:
          "cloudflare_request was blocked because openapi_describe_operation did not cache a result for this invocation.",
        evidence: compactEvidence,
        suggestedFix:
          "Call openapi_describe_operation({ method, path }) in the SAME codemode invocation before cloudflare_request. The describe cache is invocation-local.",
        suggestedRetryPrompt:
          "Retry delegated tool task. In the same codemode invocation, call openapi_describe_operation first, then cloudflare_request.",
      };
    }
    return {
      type: "wrong_tool_api",
      where,
      semanticKey: "wrong_tool_api:invalid_execution_context",
      whatFailed: "ToolAgent used the wrong MCP tool API shape or wrong execution context.",
      summary: "ToolAgent used the wrong MCP tool API shape or wrong execution context.",
      evidence: compactEvidence,
      suggestedFix:
        "Call tools with the exact declared input schema and use spec/discovery tools only in supported contexts.",
      suggestedRetryPrompt:
        "Retry delegated tool task. Use tools_describe before invocation, then call each tool with exact schema-compliant input. Do not reference unsupported globals or helper-only variables.",
    };
  }

  if (/invalid[_\s-]?tool[_\s-]?input|unrecognized_keys|schema validation|invalid_input|zod/i.test(evidenceCorpus)) {
    return {
      type: "invalid_tool_input",
      where,
      semanticKey: "invalid_tool_input:schema_validation_failed",
      whatFailed: "ToolAgent invoked a tool with invalid input that did not satisfy the tool schema.",
      summary: "ToolAgent invoked a tool with invalid input that did not satisfy the tool schema.",
      evidence: compactEvidence,
      suggestedFix: "Rebuild the tool call arguments strictly from the described input schema and retry once.",
      suggestedRetryPrompt:
        "Retry delegated tool task with schema-valid tool arguments only. Validate required fields and types before calling execute.",
    };
  }

  if (/"nonRetryable"\s*:\s*true|\bnonRetryable\s*[:=]\s*true|\bnon_retryable\b/i.test(evidenceCorpus)) {
    return {
      type: "non_retryable",
      where,
      summary: "ToolAgent received a non-retryable tool error and stopped safely.",
      evidence: compactEvidence,
      suggestedFix:
        "Change inputs or credentials instead of retrying the same call. Verify permissions, resource existence, and API compatibility.",
      suggestedRetryPrompt:
        "Retry delegated tool task only after correcting inputs/credentials. Validate prerequisites first, then execute once with corrected parameters.",
    };
  }

  if (args.hadToolActivity && result.length === 0 && error.length === 0) {
    return {
      type: "empty_result",
      where,
      summary: "ToolAgent executed tools but produced no useful final answer.",
      evidence: compactEvidence || "No final answer text returned.",
      suggestedFix: "Require a concise final summary after tool execution, including key findings and next actions.",
      suggestedRetryPrompt:
        "Retry delegated tool task. After running tools, always provide a concise final answer with findings, evidence, and explicit next step.",
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIORITY 2: Size/truncation classifications.
  // Only reached when NO semantic root-cause error was detected above.
  // large_result only applies to genuinely large successful data payloads,
  // not to error transcripts that accumulated size due to repeated failures.
  // ─────────────────────────────────────────────────────────────────────────────

  if (
    /\b(?:TRUNCATED|Response was ~\d+ tokens|token limit|context limit|payload too large|too much data|result too large|max tokens reached)\b/i.test(
      evidenceCorpus
    )
  ) {
    return {
      type: "too_much_data",
      where,
      summary: "ToolAgent returned too much data to complete a useful final answer.",
      evidence: compactEvidence,
      suggestedFix: "Narrow scope and request summarized fields, pagination, or a smaller subset.",
      suggestedRetryPrompt:
        "Retry delegated tool task. Keep the same objective, but limit output size: summarize only key findings, fetch one page at a time, and return compact JSON with essential fields.",
    };
  }

  if (isLikelyLargeResult(evidenceCorpus) && evidenceCorpus.length > MAX_FINAL_RESPONSE_CHARS) {
    return {
      type: "large_result",
      where,
      summary:
        "ToolAgent produced a result too large to return inline. Switch to paginated extraction mode.",
      evidence: compactEvidence,
      suggestedFix:
        "Fetch one page at a time, extract only requested fields, accumulate compact findings, " +
        "store full results in shared workspace or an artifact, and return scannedCount + matchedCount + artifactPointer.",
      suggestedRetryPrompt:
        "Retry delegated tool task in paginated extraction mode. " +
        "Do NOT return raw JSON arrays or large payloads inline. " +
        "Extract only requested fields, accumulate compact findings (max 50 items inline), " +
        "store full findings in shared_workspace_write or an artifact, " +
        "and report scannedCount + matchedCount + artifactPointer.",
    };
  }

  if (/tool_agent_delegation_timeout_after_\d+_ms|\btimeout\b|\btimed out\b|\babort(?:ed)?\b/i.test(evidenceCorpus)) {
    return {
      type: "timeout",
      where,
      semanticKey: "timeout:delegated_tool_execution",
      whatFailed: "ToolAgent timed out before finishing the delegated task.",
      summary: "ToolAgent timed out before finishing the delegated task.",
      evidence: compactEvidence,
      suggestedFix: "Retry with a narrower task or split it into smaller steps.",
      suggestedRetryPrompt:
        "Retry delegated tool task with narrower scope. Split into sequential steps and return progress after each step.",
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIORITY 3: Generic tool_error — last resort when an error is present but
  // did not match any semantic or size pattern above.
  // ─────────────────────────────────────────────────────────────────────────────

  if (error.length > 0) {
    return {
      type: "tool_error",
      where,
      semanticKey: "tool_error:generic",
      whatFailed: "ToolAgent encountered a tool/runtime error during delegated execution.",
      summary: "ToolAgent encountered a tool/runtime error during delegated execution.",
      evidence: compactEvidence,
      suggestedFix: "Retry with validated parameters and narrower scope.",
      suggestedRetryPrompt:
        "Retry delegated tool task with validated parameters and a narrower scope. If any call fails, explain the exact failing step and required correction.",
    };
  }

  return null;
}

export function buildToolAgentResultEnvelope(args: BuildToolAgentEnvelopeArgs): ToolAgentResultEnvelope {
  const resultText = (args.resultText ?? "").trim();
  const errorText = (args.errorText ?? "").trim();
  const toolSynthesisText = (args.toolSynthesisText ?? "").trim();

  const failure = classifyToolAgentFailure({
    resultText,
    errorText,
    hadToolActivity: args.hadToolActivity,
    whereHint: args.whereHint,
    couldBeReductionFailure: args.couldBeReductionFailure,
    couldBeFinalizationFailure: args.couldBeFinalizationFailure,
  });

  const partialResultText =
    failure && toolSynthesisText.length > 0 && toolSynthesisText !== resultText ? toolSynthesisText : undefined;

  const extractionMeta = {
    ...(args.scannedCount !== undefined ? { scannedCount: args.scannedCount } : {}),
    ...(args.matchedCount !== undefined ? { matchedCount: args.matchedCount } : {}),
    ...(Array.isArray(args.matched) ? { matched: args.matched } : {}),
    ...(args.artifactPointer ? { artifactPointer: args.artifactPointer } : {}),
  };

  if (!args.ok || failure) {
    return {
      ok: false,
      ...(resultText ? { resultText } : {}),
      ...(failure
        ? { failure }
        : {
            failure: {
              type: "unknown",
              summary: "ToolAgent reported failure without a recognized error pattern.",
              ...(errorText ? { evidence: compactInline(errorText) } : {}),
              suggestedFix: "Retry with narrower scope and explicit tool input values.",
              suggestedRetryPrompt:
                "Retry delegated tool task. Use smaller scope, explicit required inputs, and return a concise final summary.",
            } satisfies ToolAgentFailureDetail,
          }),
      ...(errorText ? { rawToolErrorPreview: compactInline(errorText, 1200) } : {}),
      ...(partialResultText ? { partialResultText } : {}),
      ...extractionMeta,
    };
  }

  // Success path: clamp final response to guard threshold; flag oversized payloads as large_result.
  const clampedResult =
    resultText.length > MAX_FINAL_RESPONSE_CHARS
      ? resultText.slice(0, MAX_FINAL_RESPONSE_CHARS) +
        "\n\n[… result truncated at inline limit; request artifact for full access]"
      : resultText;

  return {
    ok: true,
    ...(clampedResult ? { resultText: clampedResult } : {}),
    ...extractionMeta,
  };
}

export function formatToolAgentFailureAssistantMessage(envelope: ToolAgentResultEnvelope): string {
  const f = envelope.failure;
  if (!f) {
    return "[delegate_tool_task] failed: ToolAgent returned an unknown failure envelope.";
  }

  const lines: string[] = [];
  lines.push("[delegate_tool_task] failed: ToolAgent could not complete the delegated task.");
  lines.push("");
  lines.push(`Failure type: ${f.type}`);
  lines.push(`What failed: ${f.whatFailed ?? f.summary}`);
  if (f.where) lines.push(`Where: ${f.where}`);
  if (f.evidence) lines.push(`Evidence: ${f.evidence}`);
  if (f.suggestedFix) lines.push(`What to do next: ${f.suggestedFix}`);
  if (f.suggestedRetryPrompt) {
    lines.push("");
    lines.push("Retry prompt:");
    lines.push(f.suggestedRetryPrompt);
  }
  if (envelope.partialResultText?.trim()) {
    lines.push("");
    lines.push("Partial findings:");
    lines.push(compactInline(envelope.partialResultText.trim(), 2000));
  }
  return lines.join("\n");
}
