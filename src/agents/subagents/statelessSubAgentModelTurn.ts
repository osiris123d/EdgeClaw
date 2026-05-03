import type { Agent } from "agents";
import { __DO_NOT_USE_WILL_BREAK__agentContext } from "agents";
import { generateText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import type { LanguageModel } from "ai";
import type { AgentTurnContext } from "../agentTurnContext";
import type { SubAgentResult } from "../delegation";

/** When the model ignores loop discipline, shrink the RPC return; workspace remains source of truth. */
const MAX_STATELESS_REPLY_CHARS_RETURNED = 14_000;

function compactStatelessChildReplyForOrchestration(
  role: string,
  text: string,
  stepCount: number
): string {
  const t = (text ?? "").trim();
  if (t.length <= MAX_STATELESS_REPLY_CHARS_RETURNED) return t;
  return (
    `[${role}] Done — long assistant reply omitted (${t.length} chars, ${stepCount} step(s)). ` +
    `**Orchestrator:** use shared_workspace_list_patches, shared_workspace_get_patch, and reads under staging/ to inspect work; do not rely on this chat for full diffs.\n\n` +
    `[reply excerpt]\n${t.slice(0, 6_000)}`
  );
}

/**
 * Minimal host surface for a one-shot `generateText` turn without Think
 * `saveMessages` / `getMessages` session persistence.
 *
 * Bypasses the same path as `executeRpcCollectChatTurn` (`saveMessages` → inference → `getMessages`),
 * which can still touch cross-facet / request-scoped native I/O in some Think builds.
 */
type StatelessModelHost = Agent & {
  getModelForTurn(turn?: AgentTurnContext): Promise<LanguageModel>;
  getTools(): ToolSet;
};

/** Enough tool rounds for shared_workspace patch + verify style tasks in debug harness. */
const DEBUG_STATELESS_MAX_STEPS = 20;

/**
 * DEBUG / isolation — one child RPC turn: direct `generateText` + role tools only.
 * Does **not** call `saveMessages` or `getMessages`.
 */
export async function executeRpcCollectStatelessModelTurn(
  self: StatelessModelHost,
  message: string
): Promise<SubAgentResult> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) {
    return {
      text: "",
      events: [],
      ok: false,
      error: "rpcCollectStatelessModelTurn: message must be non-empty.",
    };
  }

  const role = self.constructor.name;

  return __DO_NOT_USE_WILL_BREAK__agentContext.run(
    {
      agent: self,
      connection: undefined,
      request: undefined,
      email: undefined,
    },
    async () => {
      console.info(
        "debug_stateless_child_turn_enter",
        JSON.stringify({ role, messageChars: trimmed.length })
      );
      try {
        const model = await self.getModelForTurn({
          message: trimmed,
          likelyToolUsage: true,
        });
        const tools = self.getTools();
        const toolCount = Object.keys(tools).length;

        console.info(
          "debug_stateless_model_call_started",
          JSON.stringify({ role, toolCount })
        );

        const result = await generateText({
          model,
          prompt: trimmed,
          tools,
          stopWhen: stepCountIs(DEBUG_STATELESS_MAX_STEPS),
        });

        const rawText = (result.text ?? "").trim();
        const stepCount = Array.isArray(result.steps) ? result.steps.length : 0;
        const text = compactStatelessChildReplyForOrchestration(role, rawText, stepCount);
        console.info(
          "debug_stateless_model_call_finished",
          JSON.stringify({
            role,
            ok: true,
            textLen: text.length,
            rawReplyChars: rawText.length,
            stepCount,
          })
        );
        return { text, events: [], ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          "debug_stateless_model_call_finished",
          JSON.stringify({ role, ok: false, error: msg })
        );
        return { text: "", events: [], ok: false, error: msg };
      }
    }
  );
}
