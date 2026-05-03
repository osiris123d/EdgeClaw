/**
 * Minimal Agent → Agent sub-agent repro (official `subAgent` + `@callable` pattern).
 * Isolated DO namespace `REPRO_SUBAGENT_AGENT` — not MainAgent / coding loop.
 */
import { Agent, callable } from "agents";
import type { Env } from "../lib/env";

export class ReproChildAgent extends Agent<Env, Record<string, never>> {
  initialState = {} as Record<string, never>;

  @callable()
  async ping(): Promise<{ ok: true; who: string }> {
    return { ok: true, who: "ReproChildAgent" };
  }
}

export class ReproParentAgent extends Agent<Env, Record<string, never>> {
  initialState = {} as Record<string, never>;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/repro/ping" && url.pathname !== "/repro/agent/ping") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const child = await this.subAgent(ReproChildAgent, "repro-child");
    const ping = await child.ping();
    const body = {
      repro: "agent_subagent",
      parent: "ReproParentAgent",
      childPing: ping,
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
