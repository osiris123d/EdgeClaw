/**
 * Cloudflare Browser Run API client.
 *
 * Focused responsibilities:
 * - Retrieve Browser Run sessions and targets (server-side only)
 * - Normalize target payloads to the small shape used by BrowserSessionManager
 *
 * Notes:
 * - Never expose account ID or API token to clients.
 * - Failures are handled by callers as soft-fail paths.
 */

export interface CloudflareBrowserRunTarget {
  targetId: string;
  title?: string;
  url?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
}

export interface CloudflareBrowserRunSession {
  sessionId: string;
  status?: string;
  webSocketDebuggerUrl?: string;
}

export type BrowserRunAuthSource = "CLOUDFLARE_BROWSER_API_TOKEN" | "CLOUDFLARE_API_TOKEN" | "none";

export interface BrowserRunAuthResolution {
  accountId: string | undefined;
  token: string | undefined;
  selectedTokenSource: BrowserRunAuthSource;
}

/**
 * Single source of truth for selecting which Cloudflare browser-run credentials
 * to use. Must be called from every code path that constructs auth headers or
 * logs token/account identity so all readings are consistent.
 *
 * Invariant: if token is defined, selectedTokenSource is never "none".
 *            if selectedTokenSource is "none", token is undefined.
 */
export function resolveBrowserRunAuth(env: {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
}): BrowserRunAuthResolution {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
  const browserApiToken = env.CLOUDFLARE_BROWSER_API_TOKEN?.trim() || undefined;
  const apiTokenFallback = env.CLOUDFLARE_API_TOKEN?.trim() || undefined;

  let token: string | undefined;
  let selectedTokenSource: BrowserRunAuthSource;

  if (browserApiToken) {
    token = browserApiToken;
    selectedTokenSource = "CLOUDFLARE_BROWSER_API_TOKEN";
  } else if (apiTokenFallback) {
    token = apiTokenFallback;
    selectedTokenSource = "CLOUDFLARE_API_TOKEN";
  } else {
    token = undefined;
    selectedTokenSource = "none";
  }

  // Invariant assertion
  if ((token !== undefined && selectedTokenSource === "none") ||
      (token === undefined && selectedTokenSource !== "none")) {
    console.error(
      `[BrowserSession][auth] Auth resolution invariant violated: ` +
        `token=${token !== undefined ? "present" : "absent"} selectedTokenSource=${selectedTokenSource}`
    );
  }

  return { accountId, token, selectedTokenSource };
}

export interface CloudflareBrowserRunApiConfig {
  accountId: string;
  apiToken: string;
  authSource?: BrowserRunAuthSource;
  /**
   * Controls which browser automation backend is used for action execution.
   *
   * "cdp"       (default) — raw CDP over WebSocket. Requires no extra dependencies.
   *                         Currently the production-tested approach.
   * "puppeteer" — @cloudflare/puppeteer connected to the Browser Run session's
   *               WebSocket endpoint. Cleaner API, better navigation handling.
   *               To switch: set stepExecutor: "puppeteer" in createCloudflareBrowserSessionProvider().
   */
  stepExecutor?: "cdp" | "puppeteer";
}

export interface CloudflareBrowserRunCreateSessionOptions {
  keepAliveMs?: number;
}

type FetchLike = typeof fetch;
const DEFAULT_KEEP_ALIVE_MS = 600_000;
const PROVIDER_MAX_KEEP_ALIVE_MS = 1_200_000;

function clampKeepAliveMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_KEEP_ALIVE_MS;
  if (value > PROVIDER_MAX_KEEP_ALIVE_MS) {
    console.warn(
      `[BrowserSession] keepAliveMs=${value} exceeds provider max ${PROVIDER_MAX_KEEP_ALIVE_MS}; clamping.`
    );
    return PROVIDER_MAX_KEEP_ALIVE_MS;
  }
  return Math.floor(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function maskIdentifier(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pickFirstNonEmptyArray(...candidates: unknown[]): unknown[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function normalizeTarget(raw: unknown): CloudflareBrowserRunTarget | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;

  const targetId =
    asString(rec.targetId) ??
    asString(rec.target_id) ??
    asString(rec.id) ??
    asString(rec.target);

  if (!targetId) return undefined;

  return {
    targetId,
    title: asString(rec.title),
    url: asString(rec.url),
    type: asString(rec.type),
    devtoolsFrontendUrl:
      asString(rec.devtoolsFrontendUrl) ?? asString(rec.devtools_frontend_url),
    webSocketDebuggerUrl:
      asString(rec.webSocketDebuggerUrl) ?? asString(rec.web_socket_debugger_url),
  };
}

export class CloudflareBrowserRunApi {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly authSource: CloudflareBrowserRunApiConfig["authSource"];
  private readonly fetcher: FetchLike;

  constructor(config: CloudflareBrowserRunApiConfig, fetcher: FetchLike = fetch) {
    this.accountId = config.accountId;
    this.apiToken = config.apiToken;
    this.authSource = config.authSource ?? "none";
    // Keep invocation context stable for runtimes that throw on detached invocation.
    this.fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
      fetcher.call(globalThis, input, init);
    
    // Startup diagnostics: verify auth configuration before first request
    const hasAccountId = (this.accountId?.length ?? 0) > 0 ? "yes" : "no";
    const selectedAccountId = this.accountId ?? "(missing)";
    if ((this.accountId?.length ?? 0) === 0) {
      console.error(
        `[BrowserSession][auth-startup] CONFIGURATION ERROR: accountId missing or empty. ` +
          `selectedTokenSource=${this.authSource} authHeaderMode=Bearer`
      );
    }
    console.info(
      `[BrowserSession][auth-startup] hasAccountId=${hasAccountId} selectedAccountId=${maskIdentifier(selectedAccountId)} ` +
        `accountFingerprint=${fingerprint(this.accountId)} selectedTokenSource=${this.authSource} ` +
        `tokenLength=${this.apiToken.length} tokenFingerprint=${fingerprint(this.apiToken)} authHeaderMode=Bearer`
    );
  }

  private buildUrl(path: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`;
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const requestUrl = this.buildUrl(path);
    const method = init.method ?? "GET";
    console.info(
      `[BrowserSession][auth-request] method=${method} path=${path} accountId=${maskIdentifier(this.accountId)} ` +
        `accountFingerprint=${fingerprint(this.accountId)} selectedTokenSource=${this.authSource} ` +
        `authHeaderMode=Bearer tokenLength=${this.apiToken.length} tokenFingerprint=${fingerprint(this.apiToken)}`
    );
    const res = await this.fetcher(requestUrl, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const responsePreview = (await res.text().catch(() => "")).slice(0, 240);
      console.warn(
        `[BrowserSession][auth] request failed status=${res.status} method=${init.method ?? "GET"} ` +
          `path=${path} responsePreview=${JSON.stringify(responsePreview)}`
      );
      if (res.status === 401) {
        throw new Error(
          `Browser Run auth failed (method=${init.method ?? "GET"}, path=${path}): ` +
          "verify Worker secret value, selected token source, Bearer header, and account id/path alignment."
        );
      }
      throw new Error(`Cloudflare Browser Run API ${path} failed with status ${res.status}`);
    }

    return (await res.json()) as unknown;
  }

  private async getJson(path: string): Promise<unknown> {
    return this.requestJson(path, { method: "GET" });
  }

  private unwrapResult(payload: unknown): unknown {
    const root = asRecord(payload);
    if (!root) return payload;
    return root.result ?? payload;
  }

  async createBrowserSession(
    options: CloudflareBrowserRunCreateSessionOptions = {}
  ): Promise<CloudflareBrowserRunSession> {
    const keepAliveMs = clampKeepAliveMs(options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
    const payload = await this.requestJson(
      `/browser-rendering/devtools/browser?keep_alive=${encodeURIComponent(String(keepAliveMs))}&targets=true`,
      { method: "POST" }
    );

    const rec = asRecord(this.unwrapResult(payload)) ?? {};
    const sessionId = asString(rec.sessionId) ?? asString(rec.session_id) ?? asString(rec.id);

    if (!sessionId) {
      throw new Error("Cloudflare Browser Run API did not return a sessionId for devtools browser launch");
    }

    return {
      sessionId,
      status: asString(rec.status),
      webSocketDebuggerUrl:
        asString(rec.webSocketDebuggerUrl) ?? asString(rec.web_socket_debugger_url),
    };
  }

  async listSessions(): Promise<CloudflareBrowserRunSession[]> {
    const payload = await this.getJson("/browser-rendering/devtools/session");
    const sessionsArray = pickFirstNonEmptyArray(this.unwrapResult(payload));

    const normalized: CloudflareBrowserRunSession[] = [];
    for (const item of sessionsArray) {
      const rec = asRecord(item);
      if (!rec) continue;
      const sessionId =
        asString(rec.sessionId) ??
        asString(rec.session_id) ??
        asString(rec.id);
      if (!sessionId) continue;
      normalized.push({
        sessionId,
        status: asString(rec.status),
        webSocketDebuggerUrl:
          asString(rec.webSocketDebuggerUrl) ?? asString(rec.web_socket_debugger_url),
      });
    }

    return normalized;
  }

  async createSessionTarget(sessionId: string, url: string): Promise<CloudflareBrowserRunTarget> {
    const payload = await this.requestJson(
      `/browser-rendering/devtools/browser/${encodeURIComponent(sessionId)}/json/new?url=${encodeURIComponent(url)}`,
      { method: "PUT" }
    );

    const target = normalizeTarget(this.unwrapResult(payload));
    if (!target) {
      throw new Error(
        `Cloudflare Browser Run API did not return a valid target for session ${sessionId}`
      );
    }
    return target;
  }

  async listSessionTargets(sessionId: string): Promise<CloudflareBrowserRunTarget[]> {
    const payload = await this.getJson(
      `/browser-rendering/devtools/browser/${encodeURIComponent(sessionId)}/json/list`
    );

    const targetsRaw = pickFirstNonEmptyArray(this.unwrapResult(payload));

    const normalized: CloudflareBrowserRunTarget[] = [];
    for (const item of targetsRaw) {
      const target = normalizeTarget(item);
      if (target) normalized.push(target);
    }

    return normalized;
  }
}
