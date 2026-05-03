import type { Env } from "../lib/env";

function isExplicitTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = value.trim().toLowerCase();
  return n === "true" || n === "1" || n === "yes" || n === "on";
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Gate minimal sub-agent repro HTTP routes (off by default). */
export function isSubagentReproEnabled(env: Env): boolean {
  const top =
    typeof env.ENABLE_SUBAGENT_REPRO_ENDPOINT === "string" ? env.ENABLE_SUBAGENT_REPRO_ENDPOINT : undefined;
  const nested =
    env.Variables && typeof env.Variables.ENABLE_SUBAGENT_REPRO_ENDPOINT === "string"
      ? env.Variables.ENABLE_SUBAGENT_REPRO_ENDPOINT
      : undefined;
  return isExplicitTrue(top ?? nested);
}

function reproToken(env: Env): string | undefined {
  const top = typeof env.SUBAGENT_REPRO_TOKEN === "string" ? env.SUBAGENT_REPRO_TOKEN.trim() : "";
  if (top) return top;
  const nested =
    env.Variables && typeof env.Variables.SUBAGENT_REPRO_TOKEN === "string"
      ? env.Variables.SUBAGENT_REPRO_TOKEN.trim()
      : "";
  return nested || undefined;
}

/**
 * Worker-edge gate for `/api/repro/subagent/*`.
 * Returns a Response when the request must not reach the repro DO; `null` to forward.
 */
export function gateSubagentReproAtWorker(request: Request, env: Env): Response | null {
  if (!isSubagentReproEnabled(env)) {
    return json(
      {
        error: "repro_disabled",
        hint: "Set Worker var ENABLE_SUBAGENT_REPRO_ENDPOINT=true (wrangler.jsonc vars or dashboard) and redeploy. Omit Authorization unless SUBAGENT_REPRO_TOKEN is set.",
      },
      404
    );
  }
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  const token = reproToken(env);
  if (token) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return json({ error: "Unauthorized" }, 401);
    }
  }
  return null;
}

function validateSessionId(session: string): Response | null {
  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      {
        error:
          "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars).",
      },
      400
    );
  }
  return null;
}

interface PlainDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

/**
 * GET → parent Agent DO; parent runs `subAgent(ReproChildAgent).ping()`.
 * Plain `stub.fetch` Request (no client Request headers/body forwarded).
 */
export async function forwardReproAgentPing(env: Env, session: string): Promise<Response> {
  const bad = validateSessionId(session);
  if (bad) return bad;

  const ns = env.REPRO_SUBAGENT_AGENT as unknown as PlainDONamespace | undefined;
  if (!ns) {
    return json(
      {
        error: "REPRO_SUBAGENT_AGENT binding missing — add durable_objects binding + migration.",
      },
      503
    );
  }

  const stub = ns.get(ns.idFromName(session));
  const doUrl = `https://repro-agent.internal/repro/ping`;
  const doRequest = new Request(doUrl, { method: "GET", headers: new Headers() });
  return stub.fetch(doRequest);
}

/**
 * GET → parent Think DO; parent runs `subAgent(ReproChildThink).chat("hello", callback)`.
 */
export async function forwardReproThinkChat(env: Env, session: string): Promise<Response> {
  const bad = validateSessionId(session);
  if (bad) return bad;

  const ns = env.REPRO_SUBAGENT_THINK as unknown as PlainDONamespace | undefined;
  if (!ns) {
    return json(
      {
        error: "REPRO_SUBAGENT_THINK binding missing — add durable_objects binding + migration.",
      },
      503
    );
  }

  const stub = ns.get(ns.idFromName(session));
  const doUrl = `https://repro-think.internal/repro/chat`;
  const doRequest = new Request(doUrl, { method: "GET", headers: new Headers() });
  return stub.fetch(doRequest);
}
