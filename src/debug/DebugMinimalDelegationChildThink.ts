/**
 * DEBUG ONLY — minimal Think child for isolation: same `delegateTo` → `subAgent` →
 * `rpcCollectChatTurn` / `rpcCollectStatelessModelTurn` boundary as CoderAgent, but class shape
 * matches {@link ReproChildThink} (direct Workers AI, empty tools, trivial session).
 */
import { Think, type Session } from "@cloudflare/think";
import { callable } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../lib/env";
import type { AgentTurnContext } from "../agents/agentTurnContext";
import type { SubAgentResult } from "../agents/delegation";
import { executeRpcCollectChatTurn } from "../agents/subagents/rpcCollectChatTurnShared";
import { executeRpcCollectStatelessModelTurn } from "../agents/subagents/statelessSubAgentModelTurn";

export class DebugMinimalDelegationChildThink extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitForMcpConnections = false;
    this.chatRecovery = false;
    this.maxSteps = 1;
    console.info(
      "debug_minimal_delegation_child_facet_ctor",
      JSON.stringify({ class: "DebugMinimalDelegationChildThink" })
    );
  }

  override async onStart(): Promise<void> {
    console.info("debug_minimal_delegation_child_onstart_enter");
    await super.onStart();
    console.info("debug_minimal_delegation_child_onstart_done");
  }

  override getModel(): LanguageModel {
    if (!this.env.AI) {
      throw new Error("DebugMinimalDelegationChildThink requires Workers AI binding `AI`.");
    }
    return createWorkersAI({ binding: this.env.AI as never })("@cf/meta/llama-3.1-8b-instruct");
  }

  /** Required by {@link executeRpcCollectStatelessModelTurn}; mirrors default model. */
  async getModelForTurn(_turn: AgentTurnContext = {}): Promise<LanguageModel> {
    return this.getModel();
  }

  override getSystemPrompt(): string {
    return "You are a debug minimal-delegation child. Reply with one very short sentence only.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return session;
  }

  @callable()
  async rpcCollectChatTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    console.info(
      "debug_minimal_delegation_child_rpc_enter",
      JSON.stringify({
        rpc: "rpcCollectChatTurn",
        messageChars: raw.length,
      })
    );
    const result = await executeRpcCollectChatTurn(this, raw);
    console.info(
      "debug_minimal_delegation_child_rpc_exit",
      JSON.stringify({
        rpc: "rpcCollectChatTurn",
        ok: result.ok,
        textLen: (result.text ?? "").length,
      })
    );
    return result;
  }

  @callable()
  async rpcCollectStatelessModelTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    console.info(
      "debug_minimal_delegation_child_rpc_enter",
      JSON.stringify({
        rpc: "rpcCollectStatelessModelTurn",
        messageChars: raw.length,
      })
    );
    const result = await executeRpcCollectStatelessModelTurn(this, raw);
    console.info(
      "debug_minimal_delegation_child_rpc_exit",
      JSON.stringify({
        rpc: "rpcCollectStatelessModelTurn",
        ok: result.ok,
        textLen: (result.text ?? "").length,
      })
    );
    return result;
  }
}
