import type { ChatRecoveryContext } from "@cloudflare/think";

/** Exported for Node regression tests — mirrors MainAgent chat recovery policy. */
export function computeMainAgentChatRecoveryDecision(ctx: ChatRecoveryContext): {
  persist: boolean;
  continueInference: boolean;
  shouldNotifyInterruptedNoPartial: boolean;
  ageMs: number;
  withinWindow: boolean;
  hasPartial: boolean;
} {
  const ageMs = Date.now() - ctx.createdAt;
  const withinWindow = ageMs < 5 * 60 * 1_000;
  const hasPartial =
    (typeof ctx.partialText === "string" && ctx.partialText.trim().length > 0) ||
    (Array.isArray(ctx.partialParts) && ctx.partialParts.length > 0);

  const continueInference = withinWindow && hasPartial;
  const shouldNotifyInterruptedNoPartial = withinWindow && !hasPartial;

  return {
    persist: true,
    continueInference,
    shouldNotifyInterruptedNoPartial,
    ageMs,
    withinWindow,
    hasPartial,
  };
}

type AnyMessage = { role?: string; parts?: unknown[] };

/**
 * Scans the messages after the last user turn to determine whether
 * `delegate_tool_task` already completed **and** its result was finalized as a
 * visible assistant text message (injected by `maybeInjectDelegateToolTaskSuccessAssistantMessage`).
 *
 * When both conditions are true, chat recovery should not continue — the turn is
 * already finished and resuming would produce a duplicate answer.
 *
 * Detection criteria (all within messages after the last user message):
 * 1. At least one assistant message contains a `delegate_tool_task` tool-invocation part.
 * 2. At least one assistant message that comes **after** that tool call is a **pure text**
 *    message (no tool-invocation parts) with non-empty visible text — the finalized injection.
 */
export function detectDelegateFinalizedInMessages(
  messages: readonly AnyMessage[]
): boolean {
  // Find the index of the last user message to scope the scan to the current turn.
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      turnStart = i + 1;
      break;
    }
  }

  const turnMessages = messages.slice(turnStart);

  let delegateCallIndex = -1;

  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i]!;
    if (msg.role !== "assistant") continue;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];

    const hasDelegateToolCall = parts.some((p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      const t = typeof o.type === "string" ? o.type : "";
      return (t === "tool-invocation" || t.startsWith("tool-")) && o.toolName === "delegate_tool_task";
    });

    if (hasDelegateToolCall) {
      delegateCallIndex = i;
    }
  }

  if (delegateCallIndex < 0) return false;

  // Look for a pure text assistant message AFTER the delegate tool call.
  for (let i = delegateCallIndex + 1; i < turnMessages.length; i++) {
    const msg = turnMessages[i]!;
    if (msg.role !== "assistant") continue;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];

    const hasToolInvocationPart = parts.some((p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      const t = typeof o.type === "string" ? o.type : "";
      return t === "tool-invocation" || t.startsWith("tool-");
    });

    const hasNonEmptyText = parts.some((p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return (
        o.type === "text" &&
        typeof o.text === "string" &&
        (o.text as string).trim().length > 0
      );
    });

    if (!hasToolInvocationPart && hasNonEmptyText) {
      return true;
    }
  }

  return false;
}
