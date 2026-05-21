import type { ToolAgentResultEnvelope } from "./delegation";
import { formatCompactMatchedResultText } from "./toolAgentSuccessAwareFinalization";

function compactInline(text: string, maxLen = 240): string {
  const out = text.replace(/\s+/g, " ").trim();
  return out.length > maxLen ? `${out.slice(0, maxLen)}...` : out;
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function looksLikeRawToolWrapperJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const quickHit =
    trimmed.includes('"code"') &&
    trimmed.includes('"result"') &&
    trimmed.includes('"logs"');
  if (quickHit) return true;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const rec = parsed as Record<string, unknown>;
    return "code" in rec && "result" in rec && "logs" in rec;
  } catch {
    return false;
  }
}

function isSubstantiveNarrativeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (looksLikeRawToolWrapperJson(trimmed)) return false;
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && /"(?:code|result|logs)"/.test(trimmed)) {
    return false;
  }
  return /[A-Za-z]/.test(trimmed) || trimmed.includes("|");
}

function looksLikeIntermediatePlanningText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, " ").toLowerCase();
  if (compact.length > 220) return false;
  return /^(let me|i(?:'| wi)ll|i am going to|first,? i(?:'| wi)ll|next,? i(?:'| wi)ll|i need to|i should)\b/.test(compact);
}

function tryStructuredSummary(toolAgentResult: ToolAgentResultEnvelope | undefined): string | undefined {
  if (!toolAgentResult) return undefined;

  if (
    typeof toolAgentResult.scannedCount === "number" &&
    typeof toolAgentResult.matchedCount === "number" &&
    Array.isArray(toolAgentResult.matched)
  ) {
    return formatCompactMatchedResultText({
      scannedCount: toolAgentResult.scannedCount,
      matchedCount: toolAgentResult.matchedCount,
      matched: toolAgentResult.matched,
    }).trim();
  }

  const candidates = [toolAgentResult.resultText, toolAgentResult.partialResultText];
  for (const c of candidates) {
    if (typeof c === "string" && isSubstantiveNarrativeText(c)) {
      return c.trim();
    }
  }

  return undefined;
}

function buildConciseFailureSummary(args: {
  toolAgentResult?: ToolAgentResultEnvelope;
  errorText?: string;
  attempted?: string;
}): string {
  const attempted = args.attempted?.trim() || "delegated tool task";
  const failure = args.toolAgentResult?.failure;
  const code = failure?.semanticKey?.trim() || failure?.type?.trim() || "tool_error";
  const nonRetryable =
    failure?.type === "non_retryable" ||
    code.toLowerCase().includes("non_retryable") ||
    /\bnonRetryable\s*[:=]\s*true\b/i.test(
      `${failure?.evidence ?? ""}\n${failure?.summary ?? ""}\n${args.errorText ?? ""}`
    ) ||
    /"nonRetryable"\s*:\s*true/i.test(
      `${failure?.evidence ?? ""}\n${failure?.summary ?? ""}\n${args.errorText ?? ""}`
    );
  const isProviderParseFailure =
    code === "provider_response_parse_failed" ||
    /provider_response_parse_failed|parse[_\s-]?failed|not parseable/i.test(
      `${failure?.summary ?? ""}\n${args.errorText ?? ""}`
    );
  const reason = isProviderParseFailure
    ? "The provider API call returned a payload that was too large or not parseable."
    : compactInline(
        failure?.summary?.trim() ||
          args.errorText?.trim() ||
          args.toolAgentResult?.rawToolErrorPreview?.trim() ||
          "No failure details were returned."
      );
  const nextStep = isProviderParseFailure
    ? "Retry with a reduced request (narrower scope or fewer fields) instead of issuing a raw fetch."
    : "Retry with a narrower request and explicit constraints so the delegated tool can return a bounded, parseable result.";

  return [
    "I couldn't complete the delegated task.",
    `Attempted: ${attempted}`,
    `Error: ${code}`,
    ...(nonRetryable ? ["Non-retryable: yes"] : []),
    `Reason: ${reason}`,
    `Next step: ${nextStep}`,
  ].join("\n");
}

export function synthesizeDelegationVisibleAssistantText(args: {
  llmText?: string;
  preferredText?: string;
  toolAgentResult?: ToolAgentResultEnvelope;
  errorText?: string;
  attempted?: string;
}): string {
  const llm = typeof args.llmText === "string" ? args.llmText.trim() : "";
  if (args.toolAgentResult?.ok === false || !isBlank(args.errorText)) {
    return buildConciseFailureSummary({
      toolAgentResult: args.toolAgentResult,
      errorText: args.errorText,
      attempted: args.attempted,
    });
  }

  if (isSubstantiveNarrativeText(llm) && !looksLikeIntermediatePlanningText(llm)) return llm;

  const preferred = typeof args.preferredText === "string" ? args.preferredText.trim() : "";
  if (isSubstantiveNarrativeText(preferred)) return preferred;

  const structured = tryStructuredSummary(args.toolAgentResult);
  if (structured && structured.trim().length > 0) return structured;

  return "I couldn't complete the lookup. No final response was produced by the tool agent.";
}
