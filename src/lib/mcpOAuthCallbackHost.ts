/**
 * Resolves MCP OAuth `callbackHost` when ToolAgent restore runs without an HTTP Request
 * (Agents SDK normally derives the origin from {@link getCurrentAgent}.request).
 */

import type { Env } from "./env";

function trimOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Optional Worker var: canonical public origin (`https://…`) when chat requests are unavailable. */
export function resolveMcpOAuthCallbackHostFromEnv(env: Env): string | undefined {
  const raw = env.Variables?.EDGECLAW_PUBLIC_ORIGIN ?? env.EDGECLAW_PUBLIC_ORIGIN;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const u = new URL(trimOrigin(raw));
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Prefer live request origin (MainAgent chat / HTTP), then {@link EDGECLAW_PUBLIC_ORIGIN}.
 * Call **before** `agentContext.run` clears `request` during ToolAgent delegation RPC.
 */
export async function resolveMcpOAuthCallbackHostForToolAgentDelegation(
  env: Env
): Promise<string | undefined> {
  try {
    const { getCurrentAgent } = await import("agents");
    const { request } = getCurrentAgent();
    if (request?.url) {
      const u = new URL(request.url);
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    /* getCurrentAgent unavailable outside agent scope */
  }
  return resolveMcpOAuthCallbackHostFromEnv(env);
}
