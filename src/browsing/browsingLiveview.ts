/**
 * Live View URL resolution for the Agent Browsing panel.
 *
 * Why we enumerate all CF sessions, not just the one from sessions():
 *
 *   @cloudflare/playwright's sessions() returns a Playwright-level session ID.
 *   Cloudflare's public DevTools API (browser-rendering/devtools/*) may use a
 *   different session-ID namespace — the dashboard-visible session that actually
 *   contains the Playwright-controlled page can differ from the one sessions()
 *   returns.  The Playwright session's /json/list often only exposes the initial
 *   about:blank target because that target was registered before Playwright
 *   attached its internal CDP session to it.
 *
 *   Strategy:
 *   1. Try the known Playwright session ID first (fast path).
 *   2. If only about:blank targets are found there, enumerate all live sessions
 *      via /devtools/session and query each one's /json/list.
 *   3. Across all targets found, pick the one whose URL best matches the active
 *      Playwright page URL, then prefer any http(s) page over about:blank.
 */
import type { Env } from "../lib/env";
import {
  LIVE_VIEW_RETRY_ATTEMPTS,
  LIVE_VIEW_RETRY_DELAY_MS,
} from "./browser/browsingConstants";

function accountId(env: Env): string | undefined {
  const v = env.CLOUDFLARE_ACCOUNT_ID ?? env.Variables?.CLOUDFLARE_ACCOUNT_ID;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Prefer dedicated Browser Run token; fall back to general CF API token (see README). */
function browserRenderingToken(env: Env): string | undefined {
  const t =
    env.BROWSER_RENDERING_API_TOKEN?.trim() ??
    env.CLOUDFLARE_BROWSER_API_TOKEN?.trim() ??
    env.CLOUDFLARE_API_TOKEN?.trim();
  return t || undefined;
}

export type FetchLiveViewOptions = {
  /** Playwright's active page URL — used to pick the matching CDP page target. */
  pageUrl?: string;
};

type ListTargetRow = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  devtoolsFrontendUrl?: string;
};

type CfSession = {
  sessionId: string;
};

function unwrapCfPayload(payload: unknown): unknown[] {
  const root =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const inner = root && "result" in root && root.result !== undefined ? root.result : payload;
  if (Array.isArray(inner)) return inner;
  return [];
}

function normalizeListTargetRow(raw: unknown): ListTargetRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const targetId =
    (typeof r.targetId === "string" && r.targetId) ||
    (typeof r.target_id === "string" && r.target_id) ||
    (typeof r.id === "string" && r.id) ||
    (typeof r.target === "string" && r.target);
  if (!targetId) return null;
  const devtoolsFrontendUrl =
    (typeof r.devtoolsFrontendUrl === "string" && r.devtoolsFrontendUrl) ||
    (typeof r.devtools_frontend_url === "string" && r.devtools_frontend_url) ||
    undefined;
  if (!devtoolsFrontendUrl) return null;
  return {
    targetId,
    type: typeof r.type === "string" ? r.type : undefined,
    title: typeof r.title === "string" ? r.title : undefined,
    url: typeof r.url === "string" ? r.url : undefined,
    devtoolsFrontendUrl,
  };
}

/**
 * Pick the CDP target whose DevTools URL is wired to the page we care about.
 * Preference order:
 *   1. Exact URL match with pageUrl (after stripping hash)
 *   2. Same origin + pathname match
 *   3. Any https? page that is not about:blank
 *   4. Any non-blank page
 *   5. Last resort: whatever is available
 */
export function selectLiveViewTarget(
  rawRows: unknown[],
  options?: FetchLiveViewOptions
): ListTargetRow | null {
  const targets = rawRows
    .map(normalizeListTargetRow)
    .filter((t): t is ListTargetRow => t !== null);

  if (targets.length === 0) return null;

  const pageLike = (t: ListTargetRow) =>
    t.type === "page" || t.type === "tab" || t.type === undefined;

  const pool = targets.filter(pageLike);
  const searchIn = pool.length > 0 ? pool : targets;

  const pageUrl = options?.pageUrl?.trim();
  if (pageUrl && pageUrl !== "about:blank") {
    try {
      const want = new URL(pageUrl);
      // Exact match (origin + pathname + search)
      const keyWant = `${want.origin}${want.pathname}${want.search}`;
      const exact = searchIn.find((t) => {
        if (!t.url || t.url === "about:blank") return false;
        try {
          const u = new URL(t.url);
          return `${u.origin}${u.pathname}${u.search}` === keyWant;
        } catch {
          return t.url === pageUrl;
        }
      });
      if (exact) return exact;

      // Same-origin + pathname match (ignore search params — redirected URL may differ)
      const originPath = `${want.origin}${want.pathname}`;
      const originMatch = searchIn.find((t) => {
        if (!t.url || t.url === "about:blank") return false;
        try {
          const u = new URL(t.url);
          return `${u.origin}${u.pathname}` === originPath;
        } catch {
          return false;
        }
      });
      if (originMatch) return originMatch;

      // Same-origin match
      const sameOrigin = searchIn.find((t) => {
        if (!t.url || t.url === "about:blank") return false;
        try {
          return new URL(t.url).origin === want.origin;
        } catch {
          return false;
        }
      });
      if (sameOrigin) return sameOrigin;
    } catch {
      /* ignore bad pageUrl */
    }
  }

  const http = searchIn.find((t) => t.url && /^https?:\/\//i.test(t.url) && t.url !== "about:blank");
  if (http) return http;

  const nonBlank = searchIn.find((t) => t.url && t.url !== "about:blank");
  if (nonBlank) return nonBlank;

  // All targets are about:blank — return the last one so the caller can
  // decide whether to keep searching other sessions.
  return searchIn[searchIn.length - 1] ?? null;
}

/** True if the target is essentially useless (blank start page). */
function isBlankTarget(t: ListTargetRow | null): boolean {
  if (!t) return true;
  const url = t.url ?? "";
  return url === "" || url === "about:blank";
}

function finalizeDevtoolsTabUrl(devtoolsUrl: string): string {
  try {
    const liveUrl = new URL(devtoolsUrl);
    liveUrl.searchParams.set("mode", "tab");
    return liveUrl.toString();
  } catch {
    return devtoolsUrl;
  }
}

async function cfGet(url: string, apiToken: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) {
      console.warn(`[Live View] GET ${url} → ${res.status}`);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (err) {
    console.warn(`[Live View] GET ${url} threw:`, err);
    return null;
  }
}

/** List all active browser sessions from the Cloudflare DevTools API. */
async function listCfSessions(aid: string, apiToken: string): Promise<CfSession[]> {
  const payload = await cfGet(
    `https://api.cloudflare.com/client/v4/accounts/${aid}/browser-rendering/devtools/session`,
    apiToken
  );
  if (!payload) return [];
  const rows = unwrapCfPayload(payload);
  const sessions: CfSession[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const sid =
      (typeof r.sessionId === "string" && r.sessionId) ||
      (typeof r.session_id === "string" && r.session_id) ||
      (typeof r.id === "string" && r.id);
    if (sid) sessions.push({ sessionId: sid });
  }
  return sessions;
}

/** List targets for a specific browser session. */
async function listSessionTargets(
  aid: string,
  apiToken: string,
  sessionId: string
): Promise<ListTargetRow[]> {
  const payload = await cfGet(
    `https://api.cloudflare.com/client/v4/accounts/${aid}/browser-rendering/devtools/browser/${encodeURIComponent(sessionId)}/json/list`,
    apiToken
  );
  if (!payload) return [];
  return unwrapCfPayload(payload)
    .map(normalizeListTargetRow)
    .filter((t): t is ListTargetRow => t !== null);
}

export async function fetchLiveViewUrl(
  env: Env,
  /** Session ID from @cloudflare/playwright's sessions() — used as first hint. */
  playwrightSessionId: string,
  options?: FetchLiveViewOptions
): Promise<string | null> {
  const aid = accountId(env);
  const apiToken = browserRenderingToken(env);

  if (!aid || !apiToken) {
    console.error(
      "[Live View] Missing CLOUDFLARE_ACCOUNT_ID or a Browser-capable API token " +
        "(BROWSER_RENDERING_API_TOKEN / CLOUDFLARE_BROWSER_API_TOKEN / CLOUDFLARE_API_TOKEN)"
    );
    return null;
  }

  // ── Step 1: fast path — try the known Playwright session ID ──────────────
  const knownTargets = await listSessionTargets(aid, apiToken, playwrightSessionId);
  const knownChosen = selectLiveViewTarget(knownTargets, options);

  if (knownChosen && !isBlankTarget(knownChosen)) {
    console.info(
      `[Live View] Fast-path hit: session=${playwrightSessionId} ` +
        `targetId=${knownChosen.targetId} url=${knownChosen.url ?? "(none)"}`
    );
    return finalizeDevtoolsTabUrl(knownChosen.devtoolsFrontendUrl!);
  }

  // ── Step 2: enumerate all CF browser sessions ─────────────────────────────
  // The Playwright session ID often only exposes the initial about:blank target.
  // The dashboard-visible session (different ID) contains the real navigated page.
  console.info(
    `[Live View] Fast-path only found blank target; enumerating all CF sessions ` +
      `(playwrightSession=${playwrightSessionId} pageUrl=${options?.pageUrl ?? "(none)"})`
  );

  const allSessions = await listCfSessions(aid, apiToken);
  console.info(`[Live View] Found ${allSessions.length} total CF session(s)`);

  // Collect candidates from every session except the one we already tried
  type Candidate = { sessionId: string; target: ListTargetRow };
  const candidates: Candidate[] = [];

  for (const session of allSessions) {
    if (session.sessionId === playwrightSessionId) continue;
    const targets = await listSessionTargets(aid, apiToken, session.sessionId);
    for (const t of targets) {
      candidates.push({ sessionId: session.sessionId, target: t });
    }
  }

  // Also include targets from the known session as low-priority fallback
  for (const t of knownTargets) {
    candidates.push({ sessionId: playwrightSessionId, target: t });
  }

  if (candidates.length === 0) {
    console.error("[Live View] No targets found across any CF session");
    return null;
  }

  // Re-run selection logic across the combined pool
  const allRawRows = candidates.map((c) => ({
    ...c.target,
    // keep targetId unique across sessions
    _sessionId: c.sessionId,
  }));

  const best = selectLiveViewTarget(allRawRows, options);
  if (!best?.devtoolsFrontendUrl) {
    console.error("[Live View] No target with devtoolsFrontendUrl across any session");
    return null;
  }

  const bestSession =
    candidates.find((c) => c.target.targetId === best.targetId)?.sessionId ?? "(unknown)";

  console.info(
    `[Live View] Best cross-session target: session=${bestSession} ` +
      `targetId=${best.targetId} url=${best.url ?? "(none)"} ` +
      `pageUrl=${options?.pageUrl ?? "(none)"}`
  );

  return finalizeDevtoolsTabUrl(best.devtoolsFrontendUrl);
}

export async function fetchLiveViewUrlWithRetry(
  env: Env,
  sessionId: string,
  options?: FetchLiveViewOptions
): Promise<string | null> {
  for (let attempt = 1; attempt <= LIVE_VIEW_RETRY_ATTEMPTS; attempt++) {
    const url = await fetchLiveViewUrl(env, sessionId, options);
    if (url) return url;

    console.error(
      `[Live View] Attempt ${attempt}/${LIVE_VIEW_RETRY_ATTEMPTS} failed`
    );

    if (attempt < LIVE_VIEW_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, LIVE_VIEW_RETRY_DELAY_MS));
    }
  }
  console.error(
    `[Live View] All ${LIVE_VIEW_RETRY_ATTEMPTS} attempts failed — live view unavailable`
  );
  return null;
}
