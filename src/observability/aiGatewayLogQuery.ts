/**
 * Worker-side Cloudflare AI Gateway **List Gateway Logs** client (metadata filter on `run`).
 *
 * Auth: `CLOUDFLARE_API_TOKEN` (account API token with AI Gateway read). Do not expose to the browser.
 * Target: `CLOUDFLARE_ACCOUNT_ID` + `AI_GATEWAY_ID`, or parse account/gateway from `AI_GATEWAY_BASE_URL` /compat URL.
 *
 * @see https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/
 */

import type { Env } from "../lib/env";

export const AI_GATEWAY_LOG_QUERY_VERSION = 1 as const;

export interface AiGatewayLogEntrySummary {
  id: string;
  created_at: string;
  model: string;
  provider: string;
  success: boolean;
  tokens_in: number;
  tokens_out: number;
  cost?: number;
  /** Gateway may return JSON string of custom metadata (cf-aig-metadata). */
  metadata?: string;
}

export type AiGatewayRunLogsResponse =
  | {
      ok: true;
      runId: string;
      totalCost: number;
      tokensIn: number;
      tokensOut: number;
      entryCount: number;
      entries: AiGatewayLogEntrySummary[];
    }
  | {
      ok: false;
      runId: string;
      error: string;
      hint?: string;
    };

/** Sum cost and token counters for returned log rows (used by API response + tests). */
export function aggregateAiGatewayLogSummaries(entries: AiGatewayLogEntrySummary[]): {
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
} {
  let totalCost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of entries) {
    tokensIn += Number(e.tokens_in) || 0;
    tokensOut += Number(e.tokens_out) || 0;
    if (typeof e.cost === "number" && Number.isFinite(e.cost)) totalCost += e.cost;
  }
  return { totalCost, tokensIn, tokensOut };
}

/**
 * Parses `/v1/{account_id}/{gateway_id}/…` from a compat base URL
 * (e.g. `https://gateway.ai.cloudflare.com/v1/acc/gw/openai/compat`).
 */
export function parseAiGatewayAccountAndGatewayFromCompatBaseUrl(
  baseUrl: string
): { accountId: string; gatewayId: string } | null {
  try {
    const u = new URL(baseUrl.trim());
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "v1" && parts.length >= 3) {
      return { accountId: parts[1]!, gatewayId: parts[2]! };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readEnvString(env: Env, primary: keyof Env, secondary?: keyof NonNullable<Env["Variables"]>): string | undefined {
  const a = env[primary];
  if (typeof a === "string" && a.trim()) return a.trim();
  if (secondary) {
    const b = env.Variables?.[secondary];
    if (typeof b === "string" && b.trim()) return b.trim();
  }
  return undefined;
}

function resolveLogQueryTarget(env: Env): { accountId: string; gatewayId: string } | { error: string; hint?: string } {
  const token = readEnvString(env, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN");
  if (!token) {
    return {
      error: "CLOUDFLARE_API_TOKEN is not configured.",
      hint: "Set a Workers secret with AI Gateway (read) scope to enable run log aggregation.",
    };
  }

  const explicitGateway = readEnvString(env, "AI_GATEWAY_ID", "AI_GATEWAY_ID");
  const accountFromEnv = readEnvString(env, "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
  const baseUrl =
    readEnvString(env, "AI_GATEWAY_BASE_URL", "AI_GATEWAY_BASE_URL") ||
    readEnvString(env, "AI_GATEWAY_URL", "AI_GATEWAY_URL");
  const parsed = baseUrl ? parseAiGatewayAccountAndGatewayFromCompatBaseUrl(baseUrl) : null;

  const accountId = accountFromEnv || parsed?.accountId;
  const gatewayId = explicitGateway || parsed?.gatewayId;

  if (!accountId || !gatewayId) {
    return {
      error: "AI Gateway log target is not fully configured.",
      hint:
        "Set CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_ID, or use AI_GATEWAY_BASE_URL shaped like …/v1/{account}/{gateway}/…/compat.",
    };
  }

  return { accountId, gatewayId };
}

function mapCfLogRow(raw: Record<string, unknown>): AiGatewayLogEntrySummary {
  const costRaw = raw.cost;
  const cost = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : undefined;
  const meta = raw.metadata;
  return {
    id: String(raw.id ?? ""),
    created_at: String(raw.created_at ?? ""),
    model: String(raw.model ?? ""),
    provider: String(raw.provider ?? ""),
    success: Boolean(raw.success),
    tokens_in: Number(raw.tokens_in) || 0,
    tokens_out: Number(raw.tokens_out) || 0,
    ...(cost !== undefined ? { cost } : {}),
    ...(typeof meta === "string" && meta ? { metadata: meta } : {}),
  };
}

/**
 * Lists AI Gateway logs where custom metadata key `run` equals the control-plane / loop run id.
 */
export async function queryAiGatewayLogsForRun(
  env: Env,
  runId: string,
  options?: { limit?: number }
): Promise<AiGatewayRunLogsResponse> {
  const rid = typeof runId === "string" ? runId.trim() : "";
  if (!rid) {
    return { ok: false, runId: runId ?? "", error: "runId is required." };
  }

  const target = resolveLogQueryTarget(env);
  if ("error" in target) {
    return { ok: false, runId: rid, error: target.error, hint: target.hint };
  }

  const token = readEnvString(env, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN");
  if (!token) {
    return { ok: false, runId: rid, error: "CLOUDFLARE_API_TOKEN is not configured." };
  }

  const perPage = Math.min(100, Math.max(1, options?.limit ?? 50));
  const filters = [
    { key: "metadata.key", operator: "eq" as const, value: ["run"] },
    { key: "metadata.value", operator: "eq" as const, value: [rid] },
  ];

  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/ai-gateway/gateways/${encodeURIComponent(target.gatewayId)}/logs`
  );
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "desc");
  url.searchParams.set("filters", JSON.stringify(filters));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: text.slice(0, 200) };
  }

  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "errors" in body
        ? JSON.stringify((body as { errors?: unknown }).errors)
        : text.slice(0, 300) || res.statusText;
    return {
      ok: false,
      runId: rid,
      error: `Cloudflare AI Gateway logs request failed (${res.status}): ${msg}`,
    };
  }

  const root = body as {
    success?: boolean;
    result?: unknown;
    errors?: unknown;
  };

  if (root.success === false) {
    return {
      ok: false,
      runId: rid,
      error: `Cloudflare API error: ${JSON.stringify(root.errors ?? body)}`,
    };
  }

  const rows = Array.isArray(root.result) ? root.result : [];
  const entries: AiGatewayLogEntrySummary[] = [];
  for (const item of rows) {
    if (item && typeof item === "object") {
      entries.push(mapCfLogRow(item as Record<string, unknown>));
    }
  }

  const { totalCost, tokensIn, tokensOut } = aggregateAiGatewayLogSummaries(entries);

  return {
    ok: true,
    runId: rid,
    totalCost,
    tokensIn,
    tokensOut,
    entryCount: entries.length,
    entries,
  };
}
