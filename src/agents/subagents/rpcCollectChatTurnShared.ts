import type { UIMessage } from "ai";
import type { Agent } from "agents";
import { __DO_NOT_USE_WILL_BREAK__agentContext } from "agents";
import type { SubAgentResult } from "../delegation";

/** Extract assistant-visible plain text from persisted Think `UIMessage[]`. */
export function assistantPlainTextFromMessages(msgs: UIMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== "assistant") continue;
    return extractTextFromUiMessage(msgs[i]!);
  }
  return "";
}

function extractTextFromUiMessage(msg: UIMessage): string {
  const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (Array.isArray(parts) && parts.length > 0) {
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  const content = (msg as unknown as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  return "";
}

/**
 * When the model ends on tool outcomes without prose, surface tool JSON so RPC callers
 * (e.g. {@link MainAgent} `delegate_tool_task`) return meaningful text.
 */
export function synthesizeAssistantTextFromToolParts(msgs: UIMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== "assistant") continue;
    const msg = msgs[i]!;
    const chunks: string[] = [];
    const parts = (msg as { parts?: unknown[] }).parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        const o = p as Record<string, unknown>;
        const typ = typeof o.type === "string" ? o.type : "";
        const looksLikeToolPart =
          typ === "tool-invocation" ||
          typ === "dynamic-tool" ||
          typ.startsWith("tool-") ||
          typeof o.toolCallId === "string";
        if (!looksLikeToolPart) continue;
        const out = o.output ?? o.result;
        if (out === undefined || out === null) continue;
        const body = typeof out === "string" ? out : JSON.stringify(out);
        const label =
          typeof o.toolName === "string"
            ? o.toolName
            : typeof o.toolCallId === "string"
              ? o.toolCallId
              : "tool";
        chunks.push(`[${label}]\n${body}`);
      }
    }
    if (chunks.length > 0) return chunks.join("\n\n---\n\n");
    break;
  }

  const tail: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const role = (m as { role?: string }).role;
    if (role === "user") break;
    if (role === "tool") {
      const t = extractTextFromUiMessage(m).trim();
      if (t) tail.push(t);
      else {
        const c = (m as unknown as { content?: unknown }).content;
        if (c !== undefined && c !== null) {
          tail.push(typeof c === "string" ? c : JSON.stringify(c));
        }
      }
      continue;
    }
    if (role === "assistant") break;
  }
  tail.reverse();
  return tail.length > 0 ? tail.join("\n\n---\n\n") : "";
}

type RpcTurnHost = {
  saveMessages(
    messages: UIMessage[],
    options?: Record<string, unknown>
  ): Promise<{ status: "completed" | "skipped" | "aborted" }>;
  getMessages(): UIMessage[];
};

/**
 * Buffered sub-agent turn: `saveMessages` + read last assistant — no `StreamCallback` / `chat()` stream.
 * For persistence-free isolation, see `executeRpcCollectStatelessModelTurn` in `statelessSubAgentModelTurn.ts`.
 */
export async function executeRpcCollectChatTurn(
  self: Agent & RpcTurnHost,
  message: string
): Promise<SubAgentResult> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) {
    return {
      text: "",
      events: [],
      ok: false,
      error: "rpcCollectChatTurn: message must be non-empty.",
    };
  }

  return __DO_NOT_USE_WILL_BREAK__agentContext.run(
    {
      agent: self,
      connection: undefined,
      request: undefined,
      email: undefined,
    },
    async () => {
      try {
        const userMsg: UIMessage = {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: trimmed }],
        };
        const saveResult = await self.saveMessages([userMsg], {});
        const thread = self.getMessages();
        let text = assistantPlainTextFromMessages(thread).trim();
        if (!text) {
          text = synthesizeAssistantTextFromToolParts(thread).trim();
        }

        if (saveResult.status === "skipped") {
          return { text: text || "", events: [], ok: false, error: "turn skipped" };
        }
        if (saveResult.status === "aborted") {
          return { text: text || "", events: [], ok: false, error: "aborted" };
        }
        return { text, events: [], ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: "", events: [], ok: false, error: msg };
      }
    }
  );
}
