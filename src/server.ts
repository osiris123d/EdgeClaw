/**
 * Cloudflare Workers entry point
 *
 * Routing strategy:
 *  1. `routeAgentRequest` handles all WebSocket upgrades and the `cf_agent_*`
 *     protocol automatically — this covers interactive chat sessions.
 *  2. `/health`           — liveness probe.
 *  3. `/webhook/trigger`  — POST a versioned JSON payload to inject a user
 *                           message into a named agent instance. The Worker forwards
 *                           to the MainAgent DO via `fetch(POST /webhook/trigger-turn)` so
 *                           Think `onStart`/Session is initialized before `saveMessages`
 *                           (bare `stub.triggerTurn()` RPC can fail in local dev).
 *  4. `/webhook/scheduled`— POST for cron-triggered programmatic turns
 *                           (called from the `scheduled` export below).
 *  5. Static asset serving (if ASSETS binding is configured) with SPA fallback.
 *  6. `GET|POST /api/debug/orchestrate` — **debug only** when `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true`;
 *     runs a tiny real MainAgent coding loop (see `src/debug/`). Optional query/JSON fields:
 *     `childTurn=normal|stateless`, `noSharedTools=true|false`, `projectId=<control-plane project>`,
 *     `taskId=<control-plane task>` (requires `projectId`; task must belong to that project and be
 *     todo|in_progress|review). Off by default.
 *     `GET|POST /api/debug/delegated-ping` — same gate; MainAgent → child `rpcPing` only (transport probe).
 *     `GET|POST /api/debug/coordinator-chain` — same gate; MainAgent DO → `SUBAGENT_COORDINATOR` → Coder smoke (debug).
 *     `GET|POST /api/debug/project-autonomy` — same gate; bounded coordinator picks next runnable todo task and runs
 *     task-backed debug orchestration (see `src/debug/projectAutonomyHttp.shared.ts`).
 *  7. `GET /api/repro/subagent/agent-ping` and `GET /api/repro/subagent/think-chat` — **debug only**
 *     when `ENABLE_SUBAGENT_REPRO_ENDPOINT=true`; isolated Agent/Think sub-agent repro (`src/repro/`).
 *  8. `GET|PATCH|POST|DELETE /api/coordinator/*` — optional KV-backed control plane for Sub-Agents UI
 *     (health, projects, tasks, run log). Does not proxy to MainAgent.
 *  9. 404 catch-all.
 *
 * **Codemode wire diagnostics:** set `EDGECLAW_CODEMODE_WIRE_DEBUG=true` in Wrangler vars;
 * `syncCodemodeWireDebugFromEnv` runs in Worker `fetch` / `scheduled` and in MainAgent / ToolAgent DO
 * constructors so each isolate sees `[EdgeClaw][codemode-wire-delegated]` logs (no payloads).
 *
 * Agent DO instances referenced from this Worker must be exported at the
 * module level so CF resolves `ctx.exports` correctly.
 */

import { routeAgentRequest } from "agents";
import type { Env } from "./lib/env";
import { MainAgent } from "./agents/MainAgent";
import { ResearchAgent } from "./agents/subagents/ResearchAgent";
import { ExecutionAgent } from "./agents/subagents/ExecutionAgent";
import { CoderAgent } from "./agents/subagents/CoderAgent";
import { TesterAgent } from "./agents/subagents/TesterAgent";
import { ToolAgent } from "./agents/subagents/ToolAgent";
import { EdgeclawResearchWorkflow }  from "./workflows/EdgeclawResearchWorkflow";
import { EdgeclawPageIntelWorkflow } from "./workflows/EdgeclawPageIntelWorkflow";
import { EdgeclawPreviewPromotionWorkflow } from "./workflows/EdgeclawPreviewPromotionWorkflow";
import { EdgeclawProductionDeployWorkflow } from "./workflows/EdgeclawProductionDeployWorkflow";
import { buildBrowserSmokePrompts } from "./debug/browserSmoke";
import { runStagingPromotionSmoke } from "./promotion/promotionOperationalStaging";
import { gateDebugOrchestrationAtWorker } from "./debug/debugOrchestrationWorkerGate";
import { forwardToAgentDebugOrchestration } from "./debug/forwardDebugOrchestration";
import { forwardToAgentDebugDelegatedPing } from "./debug/forwardDebugDelegatedPing";
import { forwardToAgentDebugCoordinatorChain } from "./debug/forwardDebugCoordinatorChain";
import { forwardToAgentDebugProjectAutonomy } from "./debug/forwardDebugProjectAutonomy";
import { handleCoordinatorControlPlaneRequest } from "./coordinatorControlPlane/coordinatorControlPlaneRoutes";
import {
  gateSubagentReproAtWorker,
  forwardReproAgentPing,
  forwardReproThinkChat,
} from "./repro/subagentReproForward";
import { ReproParentAgent, ReproChildAgent } from "./repro/subagentAgentReproDo";
import { ReproParentThink, ReproChildThink } from "./repro/subagentThinkReproDo";
import { DebugMinimalDelegationChildThink } from "./debug/DebugMinimalDelegationChildThink";
import { DebugPingChildThink } from "./debug/DebugPingChildThink";
import { SubagentCoordinatorThink } from "./agents/SubagentCoordinatorThink";
import { EdgeclawBrowsingAgent } from "./browsing/EdgeclawBrowsingAgent";
import { syncCodemodeWireDebugFromEnv } from "./tools/codemodeRouterHelpers";

// ── Versioned webhook payload ────────────────────────────────────────────────

/**
 * JSON body accepted by `POST /webhook/trigger` and `POST /webhook/scheduled`.
 *
 * | Field       | Required | Description                                          |
 * |-------------|----------|------------------------------------------------------|
 * | version     | yes      | Schema version — must be `"1"`.                      |
 * | prompt      | yes      | The text to inject as a user message.                |
 * | agentName   | no       | DO instance name. Defaults to `"default"`.           |
 * | metadata    | no       | Arbitrary string key-value context added to the msg. |
 *
 * @example
 * ```json
 * {
 *   "version": "1",
 *   "prompt": "Run the nightly report.",
 *   "agentName": "default",
 *   "metadata": { "source": "cron", "job": "nightly-report" }
 * }
 * ```
 */
export interface WebhookPayload {
  version: "1";
  prompt: string;
  agentName?: string;
  metadata?: Record<string, string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function summarizeAgentRouteRequest(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  const upgrade = (request.headers.get("Upgrade") ?? "").toLowerCase();
  return {
    method: request.method,
    path: url.pathname,
    hasPk: url.searchParams.has("_pk"),
    isWebSocketUpgrade: upgrade === "websocket",
    cfRay: request.headers.get("cf-ray") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
    origin: request.headers.get("origin") ?? undefined,
    secWebSocketVersion: request.headers.get("sec-websocket-version") ?? undefined,
    secWebSocketExtensions: request.headers.get("sec-websocket-extensions") ?? undefined,
  };
}

function normalizeUnknownError(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  try {
    return { name: "NonError", message: JSON.stringify(e) };
  } catch {
    return { name: "NonError", message: String(e) };
  }
}

async function serveStaticAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const direct = await env.ASSETS.fetch(request);
  if (direct.status !== 404) return direct;

  const url = new URL(request.url);
  const isLikelyFileRequest = url.pathname.includes(".");
  if (isLikelyFileRequest) return direct;

  const indexUrl = new URL("/index.html", url);
  const indexRequest = new Request(indexUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const index = await env.ASSETS.fetch(indexRequest);
  if (index.status !== 404) return index;

  return direct;
}

// ── Webhook input limits ──────────────────────────────────────────────────────

/** Maximum byte length for the `prompt` field in a webhook payload. */
const MAX_PROMPT_LENGTH = 8_000;
/** Maximum byte length for the `agentName` field. */
const MAX_AGENT_NAME_LENGTH = 128;
/** Maximum number of entries in the `metadata` object. */
const MAX_METADATA_KEYS = 20;
/** Maximum byte length for a single metadata key or value. */
const MAX_METADATA_VALUE_LENGTH = 512;
/** Header used for authenticated webhook trigger automation. */
const WEBHOOK_TRIGGER_TOKEN_HEADER = "X-EdgeClaw-Webhook-Token";

function secureEqualsConstantTime(left: string, right: string): boolean {
  const leftLen = left.length;
  const rightLen = right.length;
  let mismatch = leftLen ^ rightLen;
  const maxLen = leftLen > rightLen ? leftLen : rightLen;
  for (let i = 0; i < maxLen; i += 1) {
    const l = i < leftLen ? left.charCodeAt(i) : 0;
    const r = i < rightLen ? right.charCodeAt(i) : 0;
    mismatch |= l ^ r;
  }
  return mismatch === 0;
}

function resolveExpectedWebhookTriggerToken(env: Env): string {
  const directToken = (env as Env & { EDGECLAW_WEBHOOK_TOKEN?: string }).EDGECLAW_WEBHOOK_TOKEN?.trim();
  const varsToken = (
    env as Env & { Variables?: Record<string, string | undefined> }
  ).Variables?.EDGECLAW_WEBHOOK_TOKEN?.trim();
  return directToken || varsToken || "";
}

function verifyWebhookTriggerAutomationToken(request: Request, env: Env): Response | null {
  const expectedToken = resolveExpectedWebhookTriggerToken(env);
  const providedToken = request.headers.get(WEBHOOK_TRIGGER_TOKEN_HEADER)?.trim() || "";
  if (!expectedToken || !providedToken || !secureEqualsConstantTime(providedToken, expectedToken)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function parseWebhookPayload(request: Request): Promise<WebhookPayload | Response> {
  // Require JSON content type to prevent CSRF-style cross-origin form submissions.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object." }, 400);
  }

  const payload = body as Partial<WebhookPayload>;

  if (payload.version !== "1") {
    return json({ error: "Unsupported payload version. Expected \"1\"." }, 400);
  }

  if (typeof payload.prompt !== "string" || payload.prompt.trim() === "") {
    return json({ error: "\"prompt\" must be a non-empty string." }, 400);
  }
  if (payload.prompt.length > MAX_PROMPT_LENGTH) {
    return json({ error: `"prompt" must not exceed ${MAX_PROMPT_LENGTH} characters.` }, 400);
  }

  if (payload.agentName !== undefined) {
    if (typeof payload.agentName !== "string") {
      return json({ error: "\"agentName\" must be a string." }, 400);
    }
    if (payload.agentName.length > MAX_AGENT_NAME_LENGTH) {
      return json({ error: `"agentName" must not exceed ${MAX_AGENT_NAME_LENGTH} characters.` }, 400);
    }
    // Restrict agent names to safe identifier characters to prevent injection
    // into DO id-from-name lookups.
    if (!/^[a-zA-Z0-9_.-]+$/.test(payload.agentName)) {
      return json({ error: "\"agentName\" may only contain alphanumerics, hyphens, underscores, and dots." }, 400);
    }
  }

  if (payload.metadata !== undefined) {
    if (typeof payload.metadata !== "object" || payload.metadata === null || Array.isArray(payload.metadata)) {
      return json({ error: "\"metadata\" must be a flat string-to-string object." }, 400);
    }
    const entries = Object.entries(payload.metadata);
    if (entries.length > MAX_METADATA_KEYS) {
      return json({ error: `"metadata" must not have more than ${MAX_METADATA_KEYS} keys.` }, 400);
    }
    for (const [k, v] of entries) {
      if (k.length > MAX_METADATA_VALUE_LENGTH || typeof v !== "string" || v.length > MAX_METADATA_VALUE_LENGTH) {
        return json({ error: `Each metadata key and value must be a string no longer than ${MAX_METADATA_VALUE_LENGTH} characters.` }, 400);
      }
    }
  }

  return payload as WebhookPayload;
}

/**
 * Resolve a MainAgent DO instance by name and run one programmatic turn.
 *
 * Uses `stub.fetch(POST /webhook/trigger-turn)` — not bare `stub.triggerTurn()` RPC — so the Agent
 * `fetch` path runs after Think `onStart()` has created `session` (Miniflare and some RPC paths
 * could otherwise call `saveMessages` before `this.session` exists).
 */
/** Minimal DO namespace accessor — avoids TS type-depth issues with `DurableObjectNamespace<T>` generics. */
interface PlainDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

/**
 * Forward a /api/memory/* request to the appropriate MainAgent DO instance.
 *
 * The DO is resolved by the `session` query param (default: "default").
 * The path is rewritten: /api/memory → /memory so the DO's onRequest sees
 * the canonical sub-path.
 *
 * All other request properties (method, headers, body) are preserved.
 */
async function forwardToAgentMemory(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  // Validate session identifier (mirrors agent-name validation).
  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  // Rewrite URL: /api/memory[/…] → https://do-internal/memory[/…]
  // The host is arbitrary for DO-internal fetch calls.
  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  // Clone the request with the rewritten URL.  Body streams must not be
  // forwarded as a new Request body because they may already be consumed;
  // use arrayBuffer() to buffer first when there is a body.
  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  return stub.fetch(doRequest);
}

/**
 * Forward `POST /api/voice/*` to the MainAgent DO (TTS speaker, Flux STT tuning).
 */
async function forwardToAgentVoice(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  return stub.fetch(doRequest);
}

/**
 * Forward a /api/tasks/* request to the appropriate MainAgent DO instance.
 *
 * Mirrors forwardToAgentMemory and forwardToAgentMcp — same session
 * resolution, same URL rewriting (/api/tasks → /tasks), same body buffering.
 *
 * Routes proxied:
 *   GET    /api/tasks           → GET    /tasks
 *   POST   /api/tasks           → POST   /tasks
 *   PATCH  /api/tasks/:id       → PATCH  /tasks/:id
 *   DELETE /api/tasks/:id       → DELETE /tasks/:id
 *   POST   /api/tasks/:id/toggle→ POST   /tasks/:id/toggle
 */
async function forwardToAgentTasks(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  // Rewrite URL: /api/tasks[/…] → https://do-internal/tasks[/…]
  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  return stub.fetch(doRequest);
}

/**
 * Forward a /api/skills/* request to the appropriate MainAgent DO instance.
 *
 * Mirrors forwardToAgentMemory and forwardToAgentTasks — same session
 * resolution, same URL rewriting (/api/skills → /skills), same body buffering.
 *
 * Routes proxied:
 *   GET    /api/skills          → GET    /skills
 *   GET    /api/skills/:key     → GET    /skills/:key
 *   POST   /api/skills          → POST   /skills
 *   PATCH  /api/skills/:key     → PATCH  /skills/:key
 *   DELETE /api/skills/:key     → DELETE /skills/:key
 */
async function forwardToAgentSkills(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  // Rewrite URL: /api/skills[/…] → https://do-internal/skills[/…]
  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  return stub.fetch(doRequest);
}

/**
 * Forward a /api/workflows/* request to the appropriate MainAgent DO instance.
 *
 * Mirrors forwardToAgentSkills — same session resolution, same URL rewriting
 * (/api/workflows → /workflows), same body buffering.
 *
 * Routes proxied:
 *   GET    /api/workflows                → GET    /workflows
 *   POST   /api/workflows                → POST   /workflows
 *   PATCH  /api/workflows/:id            → PATCH  /workflows/:id
 *   DELETE /api/workflows/:id            → DELETE /workflows/:id
 *   POST   /api/workflows/:id/launch     → POST   /workflows/:id/launch
 *   GET    /api/workflows/runs           → GET    /workflows/runs
 *   GET    /api/workflows/runs/:runId    → GET    /workflows/runs/:runId
 *   POST   /api/workflows/runs/:runId/abort → POST /workflows/runs/:runId/abort
 */
async function forwardToAgentWorkflows(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  // Rewrite URL: /api/workflows[/…] → https://do-internal/workflows[/…]
  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  return stub.fetch(doRequest);
}

/**
 * Forward a /api/mcp/* request to the appropriate MainAgent DO instance.
 *
 * Mirrors forwardToAgentMemory exactly — same session resolution,
 * same URL rewriting, same body-buffering approach.
 */
async function forwardToAgentMcp(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const traceId = crypto.randomUUID();
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return json(
      { error: "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars)." },
      400
    );
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  // Rewrite URL: /api/mcp[/…] → https://do-internal/mcp[/…]
  const doUrl = new URL(request.url);
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const hasBody = request.body !== null && !["GET", "HEAD"].includes(request.method);
  const doRequest = hasBody
    ? new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      })
    : new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

  const startedAt = Date.now();
  console.info("[EdgeClaw][mcp-forward] begin", {
    traceId,
    method: request.method,
    inboundPath: url.pathname,
    doPath: doUrl.pathname,
    session,
    hasBody,
    cfRay: request.headers.get("cf-ray") ?? undefined,
  });

  try {
    const response = await stub.fetch(doRequest);
    const elapsedMs = Date.now() - startedAt;
    const status = response.status;

    console.info("[EdgeClaw][mcp-forward] end", {
      traceId,
      status,
      elapsedMs,
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: response.headers.get("content-length") ?? undefined,
    });

    if (status >= 500) {
      let preview: string | undefined;
      try {
        preview = (await response.clone().text()).slice(0, 1500);
      } catch {
        preview = undefined;
      }
      console.error("[EdgeClaw][mcp-forward] do-5xx", {
        traceId,
        status,
        elapsedMs,
        bodyPreview: preview,
      });
    }

    const out = new Response(response.body, response);
    out.headers.set("x-edgeclaw-mcp-trace-id", traceId);
    return out;
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const normalized = normalizeUnknownError(e);
    console.error("[EdgeClaw][mcp-forward] throw", {
      traceId,
      elapsedMs,
      method: request.method,
      inboundPath: url.pathname,
      doPath: doUrl.pathname,
      session,
      cfRay: request.headers.get("cf-ray") ?? undefined,
      error: normalized,
    });

    return json(
      {
        error: "mcp_forward_internal_error",
        traceId,
      },
      503
    );
  }
}

async function dispatchTurn(
  env: Env,
  payload: WebhookPayload
): Promise<Response> {
  const agentName = payload.agentName ?? "default";

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(agentName));

  const internalUrl = "https://do/webhook/trigger-turn";
  const doRes = await stub.fetch(
    new Request(internalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: payload.prompt,
        metadata: payload.metadata,
      }),
    })
  );

  let parsed: unknown;
  try {
    parsed = await doRes.json();
  } catch {
    return json(
      { ok: false, agentName, error: "MainAgent trigger-turn response was not JSON." },
      doRes.ok ? 502 : doRes.status
    );
  }

  if (!doRes.ok) {
    const err =
      parsed &&
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `MainAgent returned HTTP ${doRes.status}`;
    return json({ ok: false, agentName, error: err, details: parsed }, doRes.status);
  }

  return json({ ok: true, agentName, ...(parsed as Record<string, unknown>) });
}

// ── Worker export ─────────────────────────────────────────────────────────────

export default {
  /**
   * HTTP / WebSocket handler.
   *
   * Interactive WebSocket sessions (the Agents SDK `cf_agent_*` protocol)
   * are handled transparently by `routeAgentRequest`. Requests that don't
   * match the DO routing fall through to the explicit path handlers below.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    syncCodemodeWireDebugFromEnv(env);

    // 1. Let the Agents SDK route agent/WebSocket traffic first.
    const routeAttemptId = crypto.randomUUID();
    let routed: Response | null;
    try {
      routed = await routeAgentRequest(request, env);
    } catch (e) {
      const normalized = normalizeUnknownError(e);
      console.error("[EdgeClaw][agent-route] routeAgentRequest threw", {
        routeAttemptId,
        request: summarizeAgentRouteRequest(request),
        error: normalized,
      });
      return json(
        {
          error: "agent_route_internal_error",
          routeAttemptId,
        },
        503
      );
    }

    if (routed) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/agents/")) {
        const status = routed.status;
        if (status >= 500) {
          console.error("[EdgeClaw][agent-route] routed 5xx", {
            routeAttemptId,
            status,
            request: summarizeAgentRouteRequest(request),
          });
        }
      }
    }
    if (routed) return routed;

    const url = new URL(request.url);
    const { pathname } = url;

    // 2. Liveness probe.
    if (pathname === "/health") {
      return json({ status: "ok" });
    }

    // 2a-debug. MainAgent DO → optional SubagentCoordinatorThink coding loop / probes (gated by env + optional Bearer).
    if (pathname === "/api/debug/orchestrate" || pathname === "/api/debug/orchestrate/") {
      const gated = gateDebugOrchestrationAtWorker(request, env);
      if (gated) return gated;
      return forwardToAgentDebugOrchestration(request, env, url);
    }

    if (pathname === "/api/debug/delegated-ping" || pathname === "/api/debug/delegated-ping/") {
      const gated = gateDebugOrchestrationAtWorker(request, env);
      if (gated) return gated;
      return forwardToAgentDebugDelegatedPing(request, env, url);
    }

    if (pathname === "/api/debug/coordinator-chain" || pathname === "/api/debug/coordinator-chain/") {
      const gated = gateDebugOrchestrationAtWorker(request, env);
      if (gated) return gated;
      return forwardToAgentDebugCoordinatorChain(request, env, url);
    }

    if (pathname === "/api/debug/project-autonomy" || pathname === "/api/debug/project-autonomy/") {
      const gated = gateDebugOrchestrationAtWorker(request, env);
      if (gated) return gated;
      return forwardToAgentDebugProjectAutonomy(request, env, url);
    }

    // 2a-repro. Minimal Agent / Think sub-agent repro (isolated DO namespaces — `src/repro/`).
    if (
      pathname === "/api/repro/subagent/agent-ping" ||
      pathname === "/api/repro/subagent/agent-ping/" ||
      pathname === "/api/repro/subagent/think-chat" ||
      pathname === "/api/repro/subagent/think-chat/"
    ) {
      const gated = gateSubagentReproAtWorker(request, env);
      if (gated) return gated;
      const session = url.searchParams.get("session") ?? "default";
      if (pathname.includes("think-chat")) {
        return forwardReproThinkChat(env, session);
      }
      return forwardReproAgentPing(env, session);
    }

    // 2a-staging. Promotion platform staging report (Bearer auth; optional secret).
    if (pathname === "/api/ops/staging-report" && request.method === "GET") {
      const token = env.STAGING_OPS_TOKEN?.trim() ?? env.Variables?.STAGING_OPS_TOKEN?.trim();
      if (!token) {
        return json(
          {
            error:
              "STAGING_OPS_TOKEN is not configured — set Workers secret or vars to enable this route.",
          },
          503
        );
      }
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${token}`) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = await runStagingPromotionSmoke(env);
      return json(body);
    }

    // 2a. Memory REST API — proxy to the agent Durable Object.
    //
    // Routes:   GET/PUT/POST/DELETE /api/memory[/:label][/append]
    //           GET  /api/memory/search?q=…
    //           POST /api/memory/refresh-prompt
    //           POST /api/memory/delete-messages
    //           POST /api/memory/clear-history
    //
    // The ?session= query param selects the DO instance (defaults to "default").
    // The worker strips "/api" from the path so the DO sees "/memory/…".
    if (pathname.startsWith("/api/memory")) {
      return forwardToAgentMemory(request, env, url);
    }

    // 2b. MCP REST API — proxy to the agent Durable Object.
    //
    // Routes:   GET  /api/mcp
    //           POST /api/mcp/add
    //           POST /api/mcp/remove
    //           POST /api/mcp/reconnect
    //
    // The ?session= query param selects the DO instance (defaults to "default").
    // The worker strips "/api" so the DO sees "/mcp/…".
    if (pathname.startsWith("/api/mcp")) {
      return forwardToAgentMcp(request, env, url);
    }

    // 2c. Tasks REST API — proxy to the agent Durable Object.
    //
    // Routes:   GET    /api/tasks
    //           POST   /api/tasks
    //           PATCH  /api/tasks/:id
    //           DELETE /api/tasks/:id
    //           POST   /api/tasks/:id/toggle
    //
    // The ?session= query param selects the DO instance (defaults to "default").
    // The worker strips "/api" so the DO sees "/tasks/…".
    if (pathname.startsWith("/api/tasks")) {
      return forwardToAgentTasks(request, env, url);
    }

    // 2d. Skills REST API — proxy to the agent Durable Object.
    //
    // Routes:   GET    /api/skills
    //           GET    /api/skills/:key
    //           POST   /api/skills
    //           PATCH  /api/skills/:key
    //           DELETE /api/skills/:key
    //
    // The ?session= query param selects the DO instance (defaults to "default").
    // The worker strips "/api" so the DO sees "/skills/…".
    if (pathname.startsWith("/api/skills")) {
      return forwardToAgentSkills(request, env, url);
    }

    // 2e. Workflows REST API — proxy to the agent Durable Object.
    //
    // Routes:   GET    /api/workflows
    //           POST   /api/workflows
    //           PATCH  /api/workflows/:id
    //           DELETE /api/workflows/:id
    //           POST   /api/workflows/:id/launch
    //           GET    /api/workflows/runs
    //           GET    /api/workflows/runs/:runId
    //           POST   /api/workflows/runs/:runId/abort
    //
    // The worker strips "/api" so the DO sees "/workflows/…".
    if (pathname.startsWith("/api/workflows")) {
      return forwardToAgentWorkflows(request, env, url);
    }

    if (pathname.startsWith("/api/coordinator")) {
      return handleCoordinatorControlPlaneRequest(request, env, url);
    }

    if (pathname.startsWith("/api/voice")) {
      return forwardToAgentVoice(request, env, url);
    }

    // 2f. Browser tools smoke-test prompts for manual validation.
    if (pathname === "/debug/browser-smoke-prompts" && request.method === "GET") {
      const target = url.searchParams.get("url") ?? "https://example.com";
      return json(buildBrowserSmokePrompts(target));
    }

    // 3. Inbound webhook — inject a user message into a named agent DO instance.
    if (pathname === "/webhook/trigger" && request.method === "POST") {
      const tokenError = verifyWebhookTriggerAutomationToken(request, env);
      if (tokenError) return tokenError;
      const payloadOrError = await parseWebhookPayload(request);
      if (payloadOrError instanceof Response) return payloadOrError;
      return dispatchTurn(env, payloadOrError);
    }

    // 4. Scheduled webhook — same shape, separate path for cron parity.
    if (pathname === "/webhook/scheduled" && request.method === "POST") {
      const payloadOrError = await parseWebhookPayload(request);
      if (payloadOrError instanceof Response) return payloadOrError;
      return dispatchTurn(env, payloadOrError);
    }

    const staticAsset = await serveStaticAsset(request, env);
    if (staticAsset) return staticAsset;

    return json({ error: "Not found" }, 404);
  },

  /**
   * Cloudflare Workers scheduled (cron) handler.
   *
   * Configure cron triggers in `wrangler.jsonc` under `triggers.crons`.
   * The handler POSTs a `WebhookPayload` to the DO via `dispatchTurn` so that
   * the full agentic turn (tools, approval, lifecycle hooks) fires normally.
   *
   * @example wrangler.jsonc
   * ```jsonc
   * "triggers": { "crons": ["0 6 * * *"] }
   * ```
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    syncCodemodeWireDebugFromEnv(env);
    await dispatchTurn(env, {
      version: "1",
      prompt: "Scheduled turn triggered by cron.",
      agentName: "default",
      metadata: { source: "cron", cron: event.cron },
    });
  },
};

// ── Durable Object exports ────────────────────────────────────────────────────
// These must be module-level for Cloudflare to resolve `ctx.exports`.

export { MainAgent, ResearchAgent, ExecutionAgent, CoderAgent, TesterAgent, ToolAgent, ReproParentAgent, ReproChildAgent, ReproParentThink, ReproChildThink, DebugMinimalDelegationChildThink, DebugPingChildThink, SubagentCoordinatorThink, EdgeclawBrowsingAgent, EdgeclawResearchWorkflow, EdgeclawPageIntelWorkflow, EdgeclawPreviewPromotionWorkflow, EdgeclawProductionDeployWorkflow };
