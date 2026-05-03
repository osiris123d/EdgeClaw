/**
 * memoryRoutes.ts
 *
 * DO-level HTTP handler for all /memory/* routes.
 *
 * Called from MainAgent.onRequest() after the Think framework strips the
 * WebSocket / get-messages path first.  The worker-level proxy in server.ts
 * strips /api and forwards requests here with a path like:
 *
 *   GET  /memory
 *   PUT  /memory/:label
 *   POST /memory/:label/append
 *   DEL  /memory/:label
 *   POST /memory/refresh-prompt
 *   GET  /memory/search?q=…
 *   POST /memory/delete-messages
 *   POST /memory/clear-history
 */

import type { UIMessage } from "ai";
import type { ContextBlock } from "agents/experimental/memory/session";

// ── Adapter interface ─────────────────────────────────────────────────────────
// MainAgent implements every method below; the handler depends only on this
// interface so there is no circular import.

export interface MemoryRouteAdapter {
  // Message history (typed on Think itself)
  getMessages(): UIMessage[];
  clearMessages(): void;

  // Ensure block providers are loaded and user-created blocks are re-registered.
  // Must be awaited before any read — fixes cold-DO empty-block problem.
  memoryEnsureReady(): Promise<void>;

  // Context block operations (bridge to session internals)
  memoryGetBlocks(): ContextBlock[];
  memoryGetBlock(label: string): ContextBlock | null;
  memoryReplaceBlock(label: string, content: string): Promise<ContextBlock>;
  memoryAppendBlock(label: string, content: string): Promise<ContextBlock>;
  memoryRemoveBlock(label: string): boolean;
  memorySearch(query: string, limit?: number): Array<{
    id: string;
    role: string;
    content: string;
    createdAt?: string;
  }>;
  memoryDeleteMessages(ids: string[]): void;
  memoryRefreshPrompt(): Promise<string>;
}

// ── Shared response shape ─────────────────────────────────────────────────────

interface MemoryBlock {
  label: string;
  description?: string;
  content: string;
  maxTokens?: number;
  updatedAt?: string;
  isWritable?: boolean;
}

interface MemoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface MemoryOverview {
  totalBlocks: number;
  totalMessages: number;
  estimatedChars: number;
  lastUpdatedAt: string;
}

interface MemoryResponse {
  overview: MemoryOverview;
  blocks: MemoryBlock[];
  messages: MemoryMessage[];
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

/** Extract plain text from a UIMessage's parts array. */
function extractText(msg: UIMessage): string {
  const parts = (msg as unknown as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
  const fromParts = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  if (fromParts) return fromParts;
  // Fallback: older message shapes may use .content directly
  if (typeof (msg as unknown as { content: unknown }).content === "string") {
    return (msg as unknown as { content: string }).content;
  }
  return "";
}

/** Normalize a ContextBlock into the wire shape expected by the frontend. */
function serializeBlock(b: ContextBlock): MemoryBlock {
  return {
    label: b.label,
    description: (b as unknown as { description?: string }).description,
    content: (b.content as string | null) ?? "",
    maxTokens: (b as unknown as { maxTokens?: number }).maxTokens,
    updatedAt: (b as unknown as { updatedAt?: string }).updatedAt,
    isWritable: (b as unknown as { isWritable?: boolean }).isWritable,
  };
}

/** Normalize a UIMessage into the wire shape expected by the frontend. */
function serializeMessage(msg: UIMessage): MemoryMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: extractText(msg),
    createdAt: (msg as unknown as { createdAt?: string }).createdAt,
  };
}

/** Build the full overview + blocks + messages payload. */
function buildResponse(agent: MemoryRouteAdapter): MemoryResponse {
  const rawBlocks = agent.memoryGetBlocks();
  const rawMessages = agent.getMessages();

  const blocks = rawBlocks.map(serializeBlock);
  const messages = rawMessages.map(serializeMessage);

  const estimatedChars =
    blocks.reduce((n, b) => n + b.content.length, 0) +
    messages.reduce((n, m) => n + m.content.length, 0);

  return {
    overview: {
      totalBlocks: blocks.length,
      totalMessages: messages.length,
      estimatedChars,
      lastUpdatedAt: new Date().toISOString(),
    },
    blocks,
    messages,
  };
}

/**
 * Parse the memory sub-path from the raw request pathname.
 *
 * Supports both:
 *   /memory/label         (called directly from client)
 *   /agents/main-agent/session/memory/label  (routed through DO)
 *
 * Returns the segment starting at "/memory", e.g. "/memory/label/append".
 */
function parseSubpath(pathname: string): string {
  const match = /\/memory(\/[^?]*)?(?:[?]|$)/.exec(pathname);
  return "/memory" + (match?.[1] ?? "");
}

/**
 * Parse JSON from the request body, returning null on parse error.
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
 * pathname includes "/memory".
 *
 * Returns null if the path does not match any memory route (so the caller can
 * fall through to other handlers).
 */
export async function handleMemoryRoute(
  request: Request,
  agent: MemoryRouteAdapter
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = parseSubpath(url.pathname);
  const { method } = request;

  try {
    // Ensure block providers are loaded and user-created blocks are re-registered
    // before any read. Fixes empty responses on cold DO wake-up.
    await agent.memoryEnsureReady();

    // ── GET /memory ─────────────────────────────────────────────────────────
    if (subpath === "/memory" && method === "GET") {
      return json(buildResponse(agent));
    }

    // ── GET /memory/search?q= ────────────────────────────────────────────────
    if (subpath === "/memory/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) {
        return json(buildResponse(agent));
      }

      const matchedMessages = agent.memorySearch(q.trim(), 50).map(
        (m): MemoryMessage => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })
      );

      const allBlocks = agent.memoryGetBlocks().map(serializeBlock);
      const overview: MemoryOverview = {
        totalBlocks: allBlocks.length,
        totalMessages: matchedMessages.length,
        estimatedChars:
          allBlocks.reduce((n, b) => n + b.content.length, 0) +
          matchedMessages.reduce((n, m) => n + m.content.length, 0),
        lastUpdatedAt: new Date().toISOString(),
      };

      return json({ overview, blocks: allBlocks, messages: matchedMessages });
    }

    // ── POST /memory/refresh-prompt ──────────────────────────────────────────
    if (subpath === "/memory/refresh-prompt" && method === "POST") {
      await agent.memoryRefreshPrompt();
      return json({ ok: true, refreshedAt: new Date().toISOString() });
    }

    // ── POST /memory/delete-messages ─────────────────────────────────────────
    if (subpath === "/memory/delete-messages" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const bodyObj = body as Record<string, unknown>;
      if (!Array.isArray(bodyObj.ids)) {
        return errJson('"ids" must be a non-empty array of message ID strings.');
      }
      const ids = bodyObj.ids as unknown[];
      if (ids.some((id) => typeof id !== "string")) {
        return errJson('Each ID in "ids" must be a string.');
      }
      if (ids.length === 0) {
        return errJson('"ids" must contain at least one message ID.');
      }

      agent.memoryDeleteMessages(ids as string[]);
      return json(buildResponse(agent));
    }

    // ── POST /memory/clear-history ───────────────────────────────────────────
    if (subpath === "/memory/clear-history" && method === "POST") {
      agent.clearMessages();
      return json(buildResponse(agent));
    }

    // ── Label-based routes: extract label from /memory/:label[/append] ───────
    const labelMatch = /^\/memory\/([^/]+)(\/append)?$/.exec(subpath);
    if (!labelMatch) {
      return errJson(`Unknown memory route: ${subpath}`, 404);
    }

    const label = decodeURIComponent(labelMatch[1]);
    const isAppend = Boolean(labelMatch[2]);

    // Validate label: no empty strings, no path separators
    if (!label || label.includes("/")) {
      return errJson("Invalid block label.", 400);
    }

    // ── PUT /memory/:label ───────────────────────────────────────────────────
    if (!isAppend && method === "PUT") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const bodyObj = body as Record<string, unknown>;
      if (typeof bodyObj.content !== "string") {
        return errJson('"content" must be a string.');
      }

      await agent.memoryReplaceBlock(label, bodyObj.content);
      // Refresh system prompt so next turn sees the updated block.
      await agent.memoryRefreshPrompt();
      return json(buildResponse(agent));
    }

    // ── POST /memory/:label/append ───────────────────────────────────────────
    if (isAppend && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const bodyObj = body as Record<string, unknown>;
      if (typeof bodyObj.content !== "string" || !bodyObj.content) {
        return errJson('"content" must be a non-empty string.');
      }

      await agent.memoryAppendBlock(label, bodyObj.content);
      await agent.memoryRefreshPrompt();
      return json(buildResponse(agent));
    }

    // ── DELETE /memory/:label ────────────────────────────────────────────────
    if (!isAppend && method === "DELETE") {
      const existed = agent.memoryRemoveBlock(label);
      if (!existed) {
        return errJson(`Block "${label}" not found.`, 404);
      }
      await agent.memoryRefreshPrompt();
      return json(buildResponse(agent));
    }

    return errJson(`Method ${method} not allowed for ${subpath}`, 405);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error.";
    console.error("[memoryRoutes]", err);
    return errJson(message, 500);
  }
}
