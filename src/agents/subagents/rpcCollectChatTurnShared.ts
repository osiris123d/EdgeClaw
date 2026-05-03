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
        const text = assistantPlainTextFromMessages(self.getMessages()).trim();

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
