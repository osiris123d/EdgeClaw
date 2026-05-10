import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

const STUB_NOTICE =
  "[EdgeClaw] No tool result was found in persisted history for this call (session may have been interrupted). " +
  "Continuing the conversation is safe — retry the Codemode or MCP step if needed.";

function augmentPendingFromAssistant(pending: Map<string, string>, msg: AssistantModelMessage): void {
  const content = msg.content;
  if (typeof content === "string" || !Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool-call") continue;
    if (part.providerExecuted === true) continue;
    const id = typeof part.toolCallId === "string" ? part.toolCallId : undefined;
    const name = typeof part.toolName === "string" ? part.toolName : "unknown";
    if (!id) continue;
    pending.set(id, name);
  }
}

function subtractToolResults(pending: Map<string, string>, msg: ToolModelMessage): void {
  const content = msg.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool-result") continue;
    const id = typeof part.toolCallId === "string" ? part.toolCallId : undefined;
    if (id) pending.delete(id);
  }
}

function appendSyntheticStub(pending: Map<string, string>, repairedIdsAcc: string[], out: ModelMessage[]): void {
  if (pending.size === 0) return;
  for (const id of pending.keys()) repairedIdsAcc.push(id);
  out.push({
    role: "tool",
    content: [...pending.entries()].map(([toolCallId, toolName]) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName,
      output: { type: "error-text" as const, value: STUB_NOTICE },
    })),
  });
  pending.clear();
}

/**
 * Mirrors AI SDK `convertToLanguageModelPrompt` bookkeeping around tool calls: any assistant
 * `tool-call` lacking a companion `tool-result` before the next user/system boundary (or end of
 * history) triggers `MissingToolResultsError`. This inserts stub tool-result rows so a turn can
 * start despite interrupted prior Codemode / gateway runs.
 */
export function repairOpenAssistantToolCallsInModelMessages(messages: readonly unknown[]): {
  messages: ModelMessage[];
  repairedIds: string[];
} {
  const safe = messages as ModelMessage[];
  const repairedIds: string[] = [];

  /** Fast path — no dangling calls at boundaries. */
  {
    const scan = new Map<string, string>();
    let needsRepair = false;
    const boundary = (): void => {
      if (scan.size > 0) needsRepair = true;
      scan.clear();
    };
    for (const msg of safe) {
      if (msg.role === "assistant") augmentPendingFromAssistant(scan, msg);
      else if (msg.role === "tool") subtractToolResults(scan, msg);
      else if (msg.role === "user" || msg.role === "system") boundary();
    }
    boundary();
    if (!needsRepair) return { messages: [...safe], repairedIds: [] };
  }

  const out: ModelMessage[] = [];
  const pending = new Map<string, string>();

  for (const msg of safe) {
    if (msg.role === "assistant") {
      augmentPendingFromAssistant(pending, msg);
      out.push(msg);
      continue;
    }
    if (msg.role === "tool") {
      subtractToolResults(pending, msg);
      out.push(msg);
      continue;
    }
    if (msg.role === "user" || msg.role === "system") {
      appendSyntheticStub(pending, repairedIds, out);
      pending.clear();
      out.push(msg);
      continue;
    }
    out.push(msg);
  }
  appendSyntheticStub(pending, repairedIds, out);

  return { messages: out, repairedIds };
}
