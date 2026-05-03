/**
 * DEBUG ONLY — Think child facet with a trivial `@callable` RPC (no model, tools, or message persistence).
 * Used with MainAgent `subAgent` + cleared `agentContext` to isolate cross-DO transport vs chat stack.
 */
import { Think, type Session } from "@cloudflare/think";
import { callable } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../lib/env";

const WHO = "DebugPingChildThink";

export type DebugPingChildResponse = { ok: true; who: string };

export class DebugPingChildThink extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitForMcpConnections = false;
    this.chatRecovery = false;
    this.maxSteps = 1;
    console.info(
      "debug_ping_child_facet_ctor",
      JSON.stringify({ class: WHO })
    );
  }

  override getModel(): LanguageModel {
    if (!this.env.AI) {
      throw new Error(`${WHO} requires Workers AI binding \`AI\` (facet init only; rpcPing does not call the model).`);
    }
    return createWorkersAI({ binding: this.env.AI as never })("@cf/meta/llama-3.1-8b-instruct");
  }

  override getSystemPrompt(): string {
    return "Debug ping child — not used for rpcPing.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return session;
  }

  @callable()
  async rpcPing(): Promise<DebugPingChildResponse> {
    console.info("debug_delegated_child_ping_entered", JSON.stringify({ who: WHO }));
    const out: DebugPingChildResponse = { ok: true, who: WHO };
    console.info("debug_delegated_child_ping_returning", JSON.stringify(out));
    return out;
  }
}
