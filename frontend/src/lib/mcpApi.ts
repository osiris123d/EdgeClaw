import type { McpDiscoverySnapshot, McpAddServerRequest } from "../types/mcp";

const BASE = "/api/mcp";

// ── Internal helper ───────────────────────────────────────────────────────────

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json() as Record<string, unknown>;
      if (typeof body.error === "string") detail = body.error;
      else detail = JSON.stringify(body);
    } catch {
      try {
        detail = await res.text();
      } catch {
        // fall through to statusText
      }
    }
    throw new Error(`[mcpApi] ${res.status} — ${detail}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`[mcpApi] Response from ${url} was not valid JSON`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the full normalized MCP discovery snapshot.
 * Pass `sessionId` so the Durable Object matches the chat session (same as WebSocket /api/mcp?session=…).
 */
export function getMcpState(signal?: AbortSignal, sessionId?: string): Promise<McpDiscoverySnapshot> {
  const path =
    sessionId != null && sessionId.length > 0
      ? `${BASE}?session=${encodeURIComponent(sessionId)}`
      : BASE;
  return requestJson<McpDiscoverySnapshot>(path, { signal });
}

/** Connect a new MCP server. Returns the updated discovery snapshot. */
export function addMcpServer(
  req: McpAddServerRequest,
  signal?: AbortSignal
): Promise<McpDiscoverySnapshot> {
  return requestJson<McpDiscoverySnapshot>(`${BASE}/add`, {
    method: "POST",
    body: JSON.stringify(req),
    signal,
  });
}

/** Disconnect and remove a server by name. Returns the updated snapshot. */
export function removeMcpServer(
  name: string,
  signal?: AbortSignal
): Promise<McpDiscoverySnapshot> {
  return requestJson<McpDiscoverySnapshot>(`${BASE}/remove`, {
    method: "POST",
    body: JSON.stringify({ name }),
    signal,
  });
}

/** Reconnect a server by name using its persisted config. Returns the updated snapshot. */
export function reconnectMcpServer(
  name: string,
  signal?: AbortSignal
): Promise<McpDiscoverySnapshot> {
  return requestJson<McpDiscoverySnapshot>(`${BASE}/reconnect`, {
    method: "POST",
    body: JSON.stringify({ name }),
    signal,
  });
}

/**
 * Update mutable config fields of an existing server.
 * Currently supports: enabled (true/false).
 * Returns the updated snapshot.
 */
export function updateMcpServer(
  name: string,
  updates: { enabled?: boolean },
  signal?: AbortSignal
): Promise<McpDiscoverySnapshot> {
  return requestJson<McpDiscoverySnapshot>(`${BASE}/update`, {
    method: "POST",
    body: JSON.stringify({ name, ...updates }),
    signal,
  });
}
