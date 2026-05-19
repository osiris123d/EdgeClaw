// Pure helper for visible assistant message injection (success/failure) for delegate ToolAgent results.
// This module contains no MainAgent or Cloudflare dependencies.

export interface VisibleAssistantInjectionLatches {
  successInserted: boolean;
  failureInserted: boolean;
}

export interface VisibleAssistantInjectionParams {
  resultMessageText: string; // The visible assistant message text (from result.message)
  replyText: string; // The exact reply text to inject (success or failure)
  latch: boolean; // Per-turn latch for this path (success or failure)
  shouldInject: boolean; // Whether the delegate succeeded/failed (per-path)
}

export interface VisibleAssistantInjectionResult {
  shouldInject: boolean;
  reason: string;
}

/**
 * Determines whether to inject a visible assistant message for delegate ToolAgent results.
 * Handles per-turn latches and duplicate suppression (normalized-contains).
 *
 * This is a pure function: it does not mutate latches or perform side effects.
 *
 * @param params Injection parameters for the current path (success or failure)
 * @returns Injection result: shouldInject and reason
 */
export function shouldInjectVisibleAssistantMessage(params: VisibleAssistantInjectionParams): VisibleAssistantInjectionResult {
  const { resultMessageText, replyText, latch, shouldInject } = params;
  const trimmedReply = replyText.trim();
  if (!shouldInject) {
    return { shouldInject: false, reason: "not_applicable" };
  }
  if (trimmedReply.length === 0) {
    return { shouldInject: false, reason: "empty_reply_text" };
  }
  if (latch) {
    return { shouldInject: false, reason: "already_injected_this_turn" };
  }
  const normalizedExistingText = resultMessageText.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedReplyText = trimmedReply.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    normalizedExistingText.length > 0 &&
    normalizedReplyText.length > 0 &&
    normalizedExistingText.includes(normalizedReplyText)
  ) {
    return { shouldInject: false, reason: "already_visible_exact_or_contained" };
  }
  return { shouldInject: true, reason: normalizedExistingText.length > 0 ? "existing_visible_non_duplicate" : "no_visible_text" };
}
