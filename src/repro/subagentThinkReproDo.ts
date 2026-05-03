/**
 * Minimal Think → Think sub-agent repro: parent calls `child.chat("hello", callback)` per Think docs.
 * Empty tools, no shared workspace wiring — isolated DO namespace `REPRO_SUBAGENT_THINK`.
 */
import { Think, type Session, type StreamCallback } from "@cloudflare/think";
import type { ToolSet } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../lib/env";

export class ReproChildThink extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitForMcpConnections = false;
    this.chatRecovery = false;
    this.maxSteps = 1;
  }

  override getModel(): LanguageModel {
    if (!this.env.AI) {
      throw new Error("ReproChildThink requires Workers AI binding `AI`.");
    }
    return createWorkersAI({ binding: this.env.AI as never })("@cf/meta/llama-3.1-8b-instruct");
  }

  override getSystemPrompt(): string {
    return "You are a minimal repro assistant. Reply with one very short friendly sentence only.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return session;
  }
}

export class ReproParentThink extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitForMcpConnections = false;
    this.chatRecovery = false;
    this.maxSteps = 1;
  }

  override getModel(): LanguageModel {
    if (!this.env.AI) {
      throw new Error("ReproParentThink requires Workers AI binding `AI`.");
    }
    return createWorkersAI({ binding: this.env.AI as never })("@cf/meta/llama-3.1-8b-instruct");
  }

  override getSystemPrompt(): string {
    return "Repro parent — you should not see this in normal use; child handles chat.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return session;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/repro/chat" && url.pathname !== "/repro/think/chat") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const child = await this.subAgent(ReproChildThink, "repro-child");
    const events: string[] = [];
    const callback: StreamCallback = {
      onEvent(json: string) {
        events.push(json);
      },
      async onDone() {},
      onError(err: string) {
        throw new Error(err);
      },
    };

    try {
      await child.chat("hello", callback, {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const body = { repro: "think_subagent_chat", error: msg, streamEventCount: events.length };
      return new Response(JSON.stringify(body), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = {
      repro: "think_subagent_chat",
      parent: "ReproParentThink",
      streamEventCount: events.length,
      /** Last chunk(s) for quick inspection — may be large; truncated. */
      lastEventPreview: events.length > 0 ? events[events.length - 1]!.slice(0, 800) : null,
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
