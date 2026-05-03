/**
 * mcpRoutes.ts
 *
 * DO-level HTTP handler for all /mcp/* routes.
 *
 * Called from MainAgent.onRequest() after the Think framework strips the
 * WebSocket / get-messages path first.  The worker-level proxy in server.ts
 * strips /api and forwards requests here with a path like:
 *
 *   GET  /mcp                  → full discovery snapshot
 *   POST /mcp/add              → connect a new MCP server
 *   POST /mcp/remove           → disconnect and remove a server by name
 *   POST /mcp/reconnect        → disconnect + reconnect a server by name
 *
 * The response shape for all routes is McpDiscoverySnapshot (imported from
 * mcpDiscovery.ts).  This carries the full normalized model: per-server
 * capability structs, discovered tools/prompts/resources with input schemas,
 * lifecycle state, auth metadata, and raw debug fields.
 */

// Re-export the shared types so callers only need to import from this module.
export type {
  McpTransport,
  McpServerLifecycleState,
  McpServerCapabilities,
  McpAuthMeta,
  DiscoveredMcpTool,
  DiscoveredMcpPrompt,
  DiscoveredMcpPromptArg,
  DiscoveredMcpResource,
  DiscoveredMcpServer,
  McpDiscoverySnapshot,
  RawSdkMcpState,
  PersistedMcpServer,
} from "../lib/mcpDiscovery";

import type { McpDiscoverySnapshot, McpTransport } from "../lib/mcpDiscovery";

// ── Adapter interface ─────────────────────────────────────────────────────────
// MainAgent implements every method below; the handler depends only on this
// interface so there is no circular import.

export interface McpRouteAdapter {
  /** Return current full MCP discovery snapshot (SDK runtime + persisted config). */
  mcpGetState(): McpDiscoverySnapshot;

  /**
   * Connect a new MCP server.
   * Returns the full updated snapshot after the connection attempt.
   */
  mcpAddServer(
    name: string,
    url: string,
    options?: {
      transport?: McpTransport;
      /** Arbitrary HTTP headers forwarded to the server (e.g. Authorization, CF-Access). */
      headers?: Record<string, string>;
      /** @deprecated Use headers instead. */
      token?: string;
    }
  ): Promise<McpDiscoverySnapshot>;

  /**
   * Disconnect and remove a server by its user-assigned name.
   * Returns the full updated snapshot.
   */
  mcpRemoveServer(name: string): Promise<McpDiscoverySnapshot>;

  /**
   * Disconnect then reconnect a server by name, re-using its persisted config.
   * Useful for recovering a stuck or failed connection.
   * Returns the full updated snapshot.
   */
  mcpReconnectServer(name: string): Promise<McpDiscoverySnapshot>;

  /**
   * Update mutable config fields of an existing server.
   * Currently supports: enabled (true/false — connects or disconnects the server).
   * Returns the full updated snapshot.
   */
  mcpUpdateServer(name: string, updates: { enabled?: boolean }): Promise<McpDiscoverySnapshot>;
}

// ── Transport validation ──────────────────────────────────────────────────────
//
// CF_Truth supports three URL-based MCP transports.  An RPC/binding transport
// is intentionally absent — no McpBinding is configured in wrangler.jsonc.
// If an unknown transport value is submitted the request is rejected with a
// descriptive 400; we never silently downgrade to a different transport.

const VALID_TRANSPORTS: readonly McpTransport[] = ["streamable-http", "sse", "auto"];

/**
 * The default transport for all user-added remote MCP servers.
 *
 * "streamable-http" is the recommended transport per the MCP spec and Cloudflare
 * documentation.  It is stateful, bidirectional, and OAuth-capable.
 *
 * "auto" is NOT the default: auto-detection silently falls back from
 * streamable-http to SSE when a server returns a 4xx, producing non-specific
 * connection errors that are hard to diagnose.
 */
const DEFAULT_TRANSPORT: McpTransport = "streamable-http";

/**
 * Validate and resolve the transport value from a POST /mcp/add request body.
 *
 * Rules:
 *  - If not supplied → default to "streamable-http".
 *  - If supplied and valid → use as-is (no silent downgrade).
 *  - If supplied and invalid → return a 400 Response with a clear explanation.
 *
 * @returns A McpTransport string, or a Response (400) on validation failure.
 */
function resolveTransport(raw: unknown): McpTransport | Response {
  if (raw === undefined || raw === null) {
    return DEFAULT_TRANSPORT;
  }
  if (typeof raw !== "string") {
    return errJson(
      `"transport" must be a string. Got ${typeof raw}. ` +
        `Valid values: ${VALID_TRANSPORTS.map((v) => `"${v}"`).join(", ")}.`
    );
  }
  if (!VALID_TRANSPORTS.includes(raw as McpTransport)) {
    // Give an explicit hint about RPC so callers understand why it's absent.
    const isRpc = raw === "rpc" || raw === "binding";
    const hint = isRpc
      ? ' Note: "rpc"/"binding" transport is not supported — CF_Truth connects to MCP servers ' +
        "over https:// (streamable-http or sse), not via internal worker bindings."
      : "";
    return errJson(
      `"transport" value "${raw}" is not recognised.` +
        hint +
        ` Valid values: ${VALID_TRANSPORTS.map((v) => `"${v}"`).join(", ")}.`
    );
  }
  return raw as McpTransport;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Extract the canonical MCP sub-path from the raw request pathname.
 *
 * Supports both:
 *   /mcp/add                 (rewritten by worker proxy)
 *   /agents/main-agent/session/mcp/add  (routed through DO directly)
 *
 * Returns the segment starting at "/mcp", e.g. "/mcp/add".
 */
function parseSubpath(pathname: string): string {
  const match = /\/mcp(\/[^?]*)?(?:[?]|$)/.exec(pathname);
  return "/mcp" + (match?.[1] ?? "");
}

/**
 * Parse JSON from the request body.
 * Returns an error Response if Content-Type is wrong or body is unparseable.
 */
async function parseJsonBody(request: Request): Promise<unknown | Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("text/plain")) {
    return errJson("Content-Type must be application/json.", 415);
  }
  try {
    return await request.json();
  } catch {
    return errJson("Invalid JSON body.", 400);
  }
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

/**
 * Entry point — call from MainAgent.onRequest() for any request whose
 * pathname includes "/mcp".
 *
 * Returns a JSON Response for all handled routes.  The body is always a
 * McpDiscoverySnapshot (or { error: string } on failure).
 */
export async function handleMcpRoute(
  request: Request,
  agent: McpRouteAdapter
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = parseSubpath(url.pathname);
  const { method } = request;

  try {
    // ── GET /mcp ─────────────────────────────────────────────────────────────
    if (subpath === "/mcp" && method === "GET") {
      return json(agent.mcpGetState());
    }

    // ── POST /mcp/add ─────────────────────────────────────────────────────────
    if (subpath === "/mcp/add" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;

      if (typeof b.name !== "string" || !b.name.trim()) {
        return errJson('"name" must be a non-empty string.');
      }
      if (typeof b.url !== "string" || !b.url.trim()) {
        return errJson('"url" must be a non-empty string.');
      }

      // Validate transport — returns the resolved McpTransport or a 400 Response.
      const transportResult = resolveTransport(b.transport);
      if (transportResult instanceof Response) return transportResult;

      if (b.token !== undefined && typeof b.token !== "string") {
        return errJson('"token" must be a string when provided.');
      }
      if (b.headers !== undefined) {
        if (typeof b.headers !== "object" || Array.isArray(b.headers) || b.headers === null) {
          return errJson('"headers" must be an object of string key-value pairs.');
        }
        for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) {
          if (typeof k !== "string" || typeof v !== "string") {
            return errJson('"headers" values must all be strings.');
          }
        }
      }

      const snapshot = await agent.mcpAddServer(b.name.trim(), b.url.trim(), {
        transport: transportResult,
        headers: b.headers as Record<string, string> | undefined,
        token: typeof b.token === "string" ? b.token : undefined,
      });
      return json(snapshot);
    }

    // ── POST /mcp/remove ──────────────────────────────────────────────────────
    if (subpath === "/mcp/remove" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      if (typeof b.name !== "string" || !b.name.trim()) {
        return errJson('"name" must be a non-empty string.');
      }

      const snapshot = await agent.mcpRemoveServer(b.name.trim());
      return json(snapshot);
    }

    // ── POST /mcp/reconnect ───────────────────────────────────────────────────
    if (subpath === "/mcp/reconnect" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      if (typeof b.name !== "string" || !b.name.trim()) {
        return errJson('"name" must be a non-empty string.');
      }

      const snapshot = await agent.mcpReconnectServer(b.name.trim());
      return json(snapshot);
    }

    // ── POST /mcp/update ──────────────────────────────────────────────────────
    if (subpath === "/mcp/update" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      if (typeof b.name !== "string" || !b.name.trim()) {
        return errJson('"name" must be a non-empty string.');
      }
      if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
        return errJson('"enabled" must be a boolean when provided.');
      }
      if (b.enabled === undefined) {
        return errJson('At least one of "enabled" must be provided.');
      }

      const snapshot = await agent.mcpUpdateServer(b.name.trim(), {
        ...(b.enabled !== undefined ? { enabled: b.enabled as boolean } : {}),
      });
      return json(snapshot);
    }

    return errJson(`Unknown MCP route: ${subpath}`, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error.";
    console.error("[mcpRoutes]", err);
    return errJson(message, 500);
  }
}
