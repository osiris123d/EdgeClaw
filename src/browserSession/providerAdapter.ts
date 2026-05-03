import {
  CloudflareBrowserRunApi,
  type CloudflareBrowserRunApiConfig,
  type CloudflareBrowserRunTarget,
} from "./cloudflareBrowserRunApi";
import { actionToCdpScript, type BrowserAction } from "./browserActions";

export interface BrowserSessionProviderLaunchInput {
  task: string;
  recordingEnabled: boolean;
  keepAliveMs?: number;
  sessionMode?: "ephemeral" | "reusable";
  reuseSessionId?: string;
  pauseForHuman?: boolean;
  pauseForHumanOnBlocker?: boolean;
  /**
   * Optional override URL for the initial tab. Supplied by the manager when actions include a
   * `navigate` step so the browser opens the correct page immediately instead of `about:blank`.
   */
  firstNavigateUrl?: string;
}

export interface BrowserSessionProviderStepInput {
  browserRunSessionId: string;
  cdpScript: string;
  /** Structured actions. When present, the provider executes them via per-action CDP WebSocket calls
   *  (handling page navigation between actions) instead of running the compiled cdpScript IIFE. */
  actions?: BrowserAction[];
  /**
   * Per-step executor override. Takes precedence over the construction-time
   * `CloudflareBrowserRunApiConfig.stepExecutor`. Allows the caller to flip
   * the backend per-turn without re-creating the provider.
   *
   * "cdp" (default) — raw CDP over WebSocket
   * "puppeteer"     — @cloudflare/puppeteer
   */
  executorStrategy?: "cdp" | "puppeteer";
}

export interface BrowserSessionProviderResult {
  browserRunSessionId: string;
  reusableSessionId?: string;
  liveViewUrl?: string;
  devtoolsFrontendUrl?: string;
  recordingEnabled?: boolean;
  recordingId?: string;
  recordingReady?: boolean;
  recordingUrl?: string;
  currentTargetId?: string;
  currentUrl?: string;
  title?: string;
  reusedSession?: boolean;
  needsHumanIntervention?: boolean;
  humanInterventionReason?: string;
  resumableSession?: {
    sessionId: string;
    liveViewUrl?: string;
    expiresAt?: string;
  };
  screenshotDataUrl?: string;
  raw?: Record<string, unknown>;
}

export interface BrowserSessionProvider {
  launch(input: BrowserSessionProviderLaunchInput): Promise<BrowserSessionProviderResult>;
  step?(input: BrowserSessionProviderStepInput): Promise<BrowserSessionProviderResult>;
  status?(input: { browserRunSessionId: string }): Promise<BrowserSessionProviderResult>;
  close?(input: { browserRunSessionId: string }): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function sanitizeExtractedUrl(candidate: string): string {
  let sanitized = candidate.trim();

  // Strip common trailing JSON/prose punctuation when a URL was copied from
  // a larger instruction block, e.g. "https://amazon.com},/".
  // Iteratively remove invalid URL-ending characters from the end.
  const badChars = /[}\];:"'`.,]/;
  while (sanitized.length > 0 && (badChars.test(sanitized[sanitized.length - 1]) || sanitized.endsWith("/"))) {
    sanitized = sanitized.slice(0, -1);
  }

  return sanitized;
}

export function extractLaunchUrl(task: string): string {
  const trimmed = task.trim();
  const match = trimmed.match(/https?:\/\/[^\s)"']+/i);
  if (match?.[0]) return sanitizeExtractedUrl(match[0]);

  const domainMatch = trimmed.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)"']*)?/i);
  if (domainMatch?.[0]) return sanitizeExtractedUrl(`https://${domainMatch[0]}`);

  return "about:blank";
}

function chooseLaunchTarget(
  createdTarget: CloudflareBrowserRunTarget,
  listedTargets: CloudflareBrowserRunTarget[]
): CloudflareBrowserRunTarget {
  if (createdTarget.devtoolsFrontendUrl) return createdTarget;

  const byId = listedTargets.find(
    (target) => target.targetId === createdTarget.targetId && target.devtoolsFrontendUrl
  );
  if (byId) return byId;

  const firstPage = listedTargets.find(
    (target) => (target.type === "page" || target.type === undefined) && target.devtoolsFrontendUrl
  );
  if (firstPage) return firstPage;

  return createdTarget;
}

function shouldPauseForExpectedBlocker(task: string): boolean {
  return /\b(login|log\s*in|sign\s*in|captcha|verification|two-factor|2fa|review)\b/i.test(task);
}

export function normalizeProviderResult(raw: Record<string, unknown>): BrowserSessionProviderResult {
  const metadata = asRecord(raw.metadata);

  // Strict boundary: only explicit provider identity fields.
  const browserRunSessionId = firstString(
    metadata?.browserRunSessionId,
    metadata?.providerSessionId,
    metadata?.reusableSessionId,
    metadata?.resumableSessionId,
    raw.browserRunSessionId,
    raw.providerSessionId,
    raw.reusableSessionId,
    raw.resumableSessionId
  );

  if (!browserRunSessionId) {
    throw new Error(
      "Browser session provider did not return browserRunSessionId in explicit provider metadata fields"
    );
  }

  return {
    browserRunSessionId,
    reusableSessionId: firstString(
      metadata?.reusableSessionId,
      raw.reusableSessionId,
      browserRunSessionId
    ),
    liveViewUrl: firstString(raw.liveViewUrl, raw._liveViewUrl, metadata?.liveViewUrl),
    devtoolsFrontendUrl: firstString(
      raw.devtoolsFrontendUrl,
      raw._devtoolsFrontendUrl,
      metadata?.devtoolsFrontendUrl
    ),
    recordingEnabled:
      raw.recordingEnabled === true || metadata?.recordingEnabled === true || undefined,
    recordingId: firstString(raw.recordingId, metadata?.recordingId),
    recordingReady:
      typeof raw.recordingReady === "boolean"
        ? raw.recordingReady
        : typeof metadata?.recordingReady === "boolean"
          ? Boolean(metadata.recordingReady)
          : undefined,
    recordingUrl: firstString(
      raw.recordingUrl,
      raw._recordingUrl,
      raw.sessionRecordingUrl,
      metadata?.recordingUrl,
      metadata?.sessionRecordingUrl
    ),
    currentTargetId: firstString(raw.currentTargetId, metadata?.currentTargetId, metadata?.targetId),
    currentUrl: firstString(raw.currentUrl, metadata?.currentUrl, metadata?.url),
    title: firstString(raw.title, metadata?.title),
    reusedSession: raw.reusedSession === true,
    needsHumanIntervention:
      raw.needsHumanIntervention === true || metadata?.needsHumanIntervention === true || undefined,
    humanInterventionReason: firstString(
      raw.humanInterventionReason,
      metadata?.humanInterventionReason
    ),
    resumableSession:
      asRecord(raw.resumableSession) || asRecord(metadata?.resumableSession)
        ? {
            sessionId:
              firstString(
                asRecord(raw.resumableSession)?.sessionId,
                asRecord(metadata?.resumableSession)?.sessionId,
                browserRunSessionId
              ) ?? browserRunSessionId,
            liveViewUrl: firstString(
              asRecord(raw.resumableSession)?.liveViewUrl,
              asRecord(metadata?.resumableSession)?.liveViewUrl,
              raw.liveViewUrl,
              metadata?.liveViewUrl
            ),
            expiresAt: firstString(
              asRecord(raw.resumableSession)?.expiresAt,
              asRecord(metadata?.resumableSession)?.expiresAt
            ),
          }
        : undefined,
    screenshotDataUrl: firstString(raw._screenshotDataUrl, raw.screenshotDataUrl),
    raw,
  };
}

/**
 * Tiny local adapter hook-point.
 *
 * Intentionally does not infer provider identity from browser_execute output.
 * Pass an external provider implementation (for example one backed by
 * runBrowserTaskWithEnv in another project) through MainAgent config.
 */
export function createBrowserSessionProvider(
  provider?: BrowserSessionProvider
): BrowserSessionProvider | undefined {
  return provider;
}

export function createCloudflareBrowserSessionProvider(
  config: CloudflareBrowserRunApiConfig,
  apiClient = new CloudflareBrowserRunApi(config)
): BrowserSessionProvider {
  return {
    async launch(input: BrowserSessionProviderLaunchInput): Promise<BrowserSessionProviderResult> {
      const taskUrl = extractLaunchUrl(input.task);
      // Prefer the explicit firstNavigateUrl (derived from navigate actions) over task URL extraction.
      const launchUrl = input.firstNavigateUrl ?? taskUrl;
      const keepAliveMs = input.keepAliveMs ?? 600_000;
      console.info(
        `[BrowserSession][provider-launch] launchUrl=${launchUrl} ` +
          `(firstNavigateUrl=${input.firstNavigateUrl ?? "(none)"} taskUrl=${taskUrl}) ` +
          `keepAliveMs=${keepAliveMs} sessionMode=${input.sessionMode ?? "ephemeral"} ` +
          `reuseSessionId=${input.reuseSessionId ?? "(new session)"}`
      );
      const expiresAt = new Date(Date.now() + keepAliveMs).toISOString();
      const blockerPauseRequested =
        input.pauseForHumanOnBlocker === true && shouldPauseForExpectedBlocker(input.task);

      let browserRunSessionId: string;
      let chosenTarget: CloudflareBrowserRunTarget | undefined;
      let reusedSession = false;

      if (input.reuseSessionId) {
        try {
          const listedTargets = await apiClient.listSessionTargets(input.reuseSessionId);
          browserRunSessionId = input.reuseSessionId;
          chosenTarget = listedTargets.find((target) => Boolean(target.devtoolsFrontendUrl));
          reusedSession = true;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`SESSION_REUSE_FAILED: ${errorMessage}`);
        }
      } else {
        const session = await apiClient.createBrowserSession({ keepAliveMs });
        browserRunSessionId = session.sessionId;
        console.info(`[BrowserSession][provider-launch] Created session ${browserRunSessionId}; creating target at ${launchUrl}`);
        const createdTarget = await apiClient.createSessionTarget(session.sessionId, launchUrl);
        const listedTargets = await apiClient.listSessionTargets(session.sessionId);
        chosenTarget = chooseLaunchTarget(createdTarget, listedTargets);
        console.info(
          `[BrowserSession][provider-launch] Target chosen: url=${chosenTarget?.url ?? "?"} ` +
            `targetId=${chosenTarget?.targetId ?? "?"}`
        );
      }

      const raw: Record<string, unknown> = {
        browserRunSessionId,
        reusableSessionId:
          input.sessionMode === "reusable" || input.pauseForHuman || input.reuseSessionId
            ? browserRunSessionId
            : undefined,
        currentTargetId: chosenTarget?.targetId,
        currentUrl: chosenTarget?.url,
        title: chosenTarget?.title,
        devtoolsFrontendUrl: chosenTarget?.devtoolsFrontendUrl,
        liveViewUrl: chosenTarget?.devtoolsFrontendUrl,
        recordingEnabled: input.recordingEnabled,
        recordingId: input.recordingEnabled ? browserRunSessionId : undefined,
        recordingReady: false,
        reusedSession,
        needsHumanIntervention: input.pauseForHuman || blockerPauseRequested,
        humanInterventionReason: input.pauseForHuman || blockerPauseRequested
          ? blockerPauseRequested
            ? "Blocked on a likely login or verification step. Open Live View and resume when ready."
            : "Paused for human review. Open Live View and resume when ready."
          : undefined,
        resumableSession:
          input.sessionMode === "reusable" || input.pauseForHuman || input.reuseSessionId || blockerPauseRequested
            ? {
                sessionId: browserRunSessionId,
                liveViewUrl: chosenTarget?.devtoolsFrontendUrl,
                expiresAt,
              }
            : undefined,
        metadata: {
          browserRunSessionId,
          reusableSessionId:
            input.sessionMode === "reusable" || input.pauseForHuman || input.reuseSessionId
              ? browserRunSessionId
              : undefined,
          devtoolsFrontendUrl: chosenTarget?.devtoolsFrontendUrl,
          liveViewUrl: chosenTarget?.devtoolsFrontendUrl,
          recordingEnabled: input.recordingEnabled,
          recordingId: input.recordingEnabled ? browserRunSessionId : undefined,
          recordingReady: false,
          needsHumanIntervention: input.pauseForHuman || blockerPauseRequested,
          humanInterventionReason: input.pauseForHuman || blockerPauseRequested
            ? blockerPauseRequested
              ? "Blocked on a likely login or verification step. Open Live View and resume when ready."
              : "Paused for human review. Open Live View and resume when ready."
            : undefined,
          resumableSession:
            input.sessionMode === "reusable" || input.pauseForHuman || input.reuseSessionId || blockerPauseRequested
              ? {
                  sessionId: browserRunSessionId,
                  liveViewUrl: chosenTarget?.devtoolsFrontendUrl,
                  expiresAt,
                }
              : undefined,
        },
      };

      if (!browserRunSessionId) {
        console.error(
          `[BrowserSession][provider] launch missing browserRunSessionId rawKeys=${Object.keys(raw).join(",") || "(none)"}`
        );
        throw new Error("Browser session provider launch did not return browserRunSessionId");
      }

      if (!chosenTarget?.devtoolsFrontendUrl) {
        throw new Error(
          `Browser session provider launch did not return a devtoolsFrontendUrl for session ${browserRunSessionId}`
        );
      }

      return normalizeProviderResult(raw);
    },

    async step(input: BrowserSessionProviderStepInput): Promise<BrowserSessionProviderResult> {
      const { browserRunSessionId } = input;

      const targets = await apiClient.listSessionTargets(browserRunSessionId);
      const target = targets.find((t) => t.webSocketDebuggerUrl) ?? targets[0];
      if (!target?.webSocketDebuggerUrl) {
        throw new Error(
          `[BrowserSession][provider-step] No WebSocket debugger URL for session ${browserRunSessionId}. ` +
            `Available targets: ${targets.length}`
        );
      }

      console.info(
        `[BrowserSession][provider-step] session=${browserRunSessionId} ` +
          `target=${target.targetId} wsUrl=${target.webSocketDebuggerUrl.slice(0, 80)}... ` +
          `actionsCount=${input.actions?.length ?? 0} cdpScriptLen=${input.cdpScript?.length ?? 0}`
      );

      // ── Executor selection ────────────────────────────────────────────────────
      // Per-step input.executorStrategy takes priority over the construction-time
      // config.stepExecutor. Defaults to "cdp" (current production path).
      // To switch globally: set stepExecutor in CloudflareBrowserRunApiConfig.
      // To switch per-turn: set executorStrategy in BrowserSessionProviderStepInput.
      const useExecutor = input.executorStrategy ?? config.stepExecutor ?? "cdp";
      console.info(`[BrowserSession][provider-step] executor=${useExecutor}`);

      let scriptResult: unknown;
      if (input.actions && input.actions.length > 0) {
        if (useExecutor === "puppeteer") {
          scriptResult = await executePuppeteerActions(
            target.webSocketDebuggerUrl,
            input.actions
          );
        } else {
          scriptResult = await executeCdpActionsViaWebSocket(
            target.webSocketDebuggerUrl,
            config.apiToken,
            input.actions
          );
        }
      } else {
        // Raw cdpScript fallback always uses CDP.
        scriptResult = await evaluateScriptViaWebSocket(
          target.webSocketDebuggerUrl,
          config.apiToken,
          input.cdpScript
        );
      }

      // Extract screenshot data from action results if any screenshot action was executed.
      const actionResults = Array.isArray(scriptResult)
        ? (scriptResult as Array<Record<string, unknown>>)
        : [];
      const screenshotEntry = actionResults.find(
        (r) => r.type === "screenshot" && typeof r.screenshotData === "string"
      );
      const screenshotDataUrl = screenshotEntry?.screenshotData
        ? `data:image/jpeg;base64,${screenshotEntry.screenshotData as string}`
        : undefined;

      if (screenshotDataUrl) {
        console.info(
          `[BrowserSession][provider-step] screenshot captured screenshotBytes=${
            (screenshotEntry!.screenshotData as string).length
          }`
        );
      }

      // Refresh target metadata after execution so the result shows the current URL.
      let currentUrl = target.url;
      let title = target.title;
      let currentTargetId = target.targetId;
      try {
        const freshTargets = await apiClient.listSessionTargets(browserRunSessionId);
        const freshTarget =
          freshTargets.find((t) => t.targetId === target.targetId) ?? freshTargets[0];
        if (freshTarget) {
          currentUrl = freshTarget.url ?? currentUrl;
          title = freshTarget.title ?? title;
          currentTargetId = freshTarget.targetId;
        }
      } catch (_) {
        // Non-fatal — keep the pre-execution values
      }

      console.info(
        `[BrowserSession][provider-step] done session=${browserRunSessionId} ` +
          `currentUrl=${currentUrl ?? "?"} hasScreenshot=${Boolean(screenshotDataUrl)}`
      );

      return normalizeProviderResult({
        browserRunSessionId,
        reusableSessionId: browserRunSessionId,
        currentTargetId,
        currentUrl,
        title,
        devtoolsFrontendUrl: target.devtoolsFrontendUrl,
        liveViewUrl: target.devtoolsFrontendUrl,
        // screenshotDataUrl is read by normalizeProviderResult from the top-level raw object.
        screenshotDataUrl,
        metadata: {
          browserRunSessionId,
          reusableSessionId: browserRunSessionId,
          devtoolsFrontendUrl: target.devtoolsFrontendUrl,
          liveViewUrl: target.devtoolsFrontendUrl,
          scriptResult,
        },
      });
    },

    async status(input: { browserRunSessionId: string }): Promise<BrowserSessionProviderResult> {
      const listedTargets = await apiClient.listSessionTargets(input.browserRunSessionId);
      const chosenTarget = listedTargets.find((target) => Boolean(target.devtoolsFrontendUrl));
      if (!chosenTarget) {
        throw new Error(`SESSION_REUSE_FAILED: no active target found for ${input.browserRunSessionId}`);
      }

      return normalizeProviderResult({
        browserRunSessionId: input.browserRunSessionId,
        reusableSessionId: input.browserRunSessionId,
        reusedSession: true,
        currentTargetId: chosenTarget.targetId,
        currentUrl: chosenTarget.url,
        title: chosenTarget.title,
        devtoolsFrontendUrl: chosenTarget.devtoolsFrontendUrl,
        liveViewUrl: chosenTarget.devtoolsFrontendUrl,
        metadata: {
          browserRunSessionId: input.browserRunSessionId,
          reusableSessionId: input.browserRunSessionId,
          devtoolsFrontendUrl: chosenTarget.devtoolsFrontendUrl,
          liveViewUrl: chosenTarget.devtoolsFrontendUrl,
        },
      });
    },
  };
}

// ─── CDP WebSocket helpers ────────────────────────────────────────────────────

interface CdpMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message: string; code?: number };
  params?: Record<string, unknown>;
}

/**
 * Minimal CDP-over-WebSocket session for a single target.
 * Uses the Cloudflare Workers fetch-with-upgrade pattern for outbound WebSocket connections.
 */
class CdpSession {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly eventHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    // Cloudflare Workers outbound WebSocket must call accept() before use.
    (ws as unknown as { accept?: () => void }).accept?.();

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as CdpMessage;
        if (msg.id !== undefined) {
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(msg.error.message ?? "CDP error"));
            } else {
              handler.resolve(msg.result ?? {});
            }
          }
        } else if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) {
            for (const h of [...handlers]) h(msg.params ?? {});
          }
        }
      } catch (_) {
        // Ignore parse errors for non-JSON frames (e.g. browser keep-alive pings)
      }
    });

    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, handler] of this.pending) {
        handler.reject(new Error("CDP WebSocket closed unexpectedly"));
      }
      this.pending.clear();
    });

    ws.addEventListener("error", () => {
      this.closed = true;
      for (const [, handler] of this.pending) {
        handler.reject(new Error("CDP WebSocket error"));
      }
      this.pending.clear();
    });
  }

  send<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("CDP WebSocket is closed"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method)!.push(handler);
    return () => {
      const list = this.eventHandlers.get(method);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  waitForEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      const cleanup = this.on(method, (params) => {
        clearTimeout(timer);
        cleanup();
        resolve(params);
      });
    });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      try {
        this.ws.close();
      } catch (_) {
        // ignore
      }
    }
  }
}

/** Open an outbound WebSocket connection using Cloudflare Workers fetch-upgrade pattern. */
async function openCdpWebSocket(wsUrl: string, apiToken: string): Promise<CdpSession> {
  // Cloudflare Workers: fetch() cannot load wss:// or ws:// URLs directly.
  // Convert to https:// / http:// and use the Upgrade header instead.
  const fetchUrl = wsUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

  console.info(`[BrowserSession][cdp-ws-connect] fetching ${fetchUrl.slice(0, 120)}...`);

  // The URL already embeds a JWT query param — include the Bearer header as well for defense-in-depth.
  const response = await fetch(fetchUrl, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Authorization: `Bearer ${apiToken}`,
    },
  });

  const ws = (response as unknown as { webSocket?: WebSocket | null }).webSocket;
  if (!ws) {
    throw new Error(
      `CDP WebSocket upgrade failed (HTTP ${response.status}). ` +
        `Ensure the Browser Run session is still alive. URL: ${fetchUrl.slice(0, 120)}`
    );
  }
  return new CdpSession(ws);
}

/** Normalize a URL for equality checks (strip trailing slash, lowercase scheme+host). */
function normalizeUrlForCompare(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch (_) {
    return url.replace(/\/$/, "").toLowerCase();
  }
}

/**
 * Execute an array of structured browser actions via per-action CDP commands.
 *
 * - `navigate`  → Page.navigate + wait for Page.loadEventFired (skipped if already at URL)
 * - `click`     → Runtime.evaluate + optional Page.loadEventFired wait if navigation detected
 * - `type` / `wait` / `screenshot` → Runtime.evaluate
 *
 * Actions are executed sequentially. A single action failure is recorded but does not abort
 * remaining actions (consistent with the existing IIFE approach).
 */
async function executeCdpActionsViaWebSocket(
  wsUrl: string,
  apiToken: string,
  actions: BrowserAction[],
  totalTimeoutMs = 90_000
): Promise<Array<Record<string, unknown>>> {
  const cdp = await openCdpWebSocket(wsUrl, apiToken);
  const results: Array<Record<string, unknown>> = [];

  const overallTimer = setTimeout(() => {
    cdp.close();
  }, totalTimeoutMs);

  try {
    // Enable Page domain events so we can listen for navigation.
    await cdp.send("Page.enable");

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.info(`[BrowserSession][cdp-action] i=${i} type=${action.type}`);

      try {
        if (action.type === "navigate") {
          // Check current URL to avoid redundant reload when browser was already opened there.
          const evalRes = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
            expression: "window.location.href",
            returnByValue: true,
          });
          const currentUrl = evalRes.result?.value ?? "";

          if (normalizeUrlForCompare(currentUrl) === normalizeUrlForCompare(action.url)) {
            console.info(`[BrowserSession][cdp-action] navigate i=${i} already at ${action.url}, skipping`);
            results.push({ action: i, type: "navigate", success: true, url: action.url, alreadyThere: true });
          } else {
            console.info(`[BrowserSession][cdp-action] navigate i=${i} from ${currentUrl} to ${action.url}`);
            const loadPromise = cdp.waitForEvent("Page.loadEventFired", 15_000);
            await cdp.send("Page.navigate", { url: action.url });
            await loadPromise;
            results.push({ action: i, type: "navigate", success: true, url: action.url });
          }
        } else if (action.type === "click") {
          const fragment = actionToCdpScript(action);
          // Listen for navigation BEFORE clicking.
          let navigationOccurred = false;
          const navCleanup = cdp.on("Page.frameNavigated", () => {
            navigationOccurred = true;
          });

          const evalRes = await cdp.send<{ result?: { value?: Record<string, unknown> }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            {
              expression: `(async () => { ${fragment} })()`,
              awaitPromise: true,
              returnByValue: true,
            }
          );
          navCleanup();

          if (evalRes.exceptionDetails) {
            throw new Error(`Script exception in click action ${i}`);
          }
          const clickResult = evalRes.result?.value ?? { type: "click", success: false };

          // If a navigation was triggered by the click, wait for the new page to fully load.
          if (navigationOccurred) {
            console.info(`[BrowserSession][cdp-action] click i=${i} triggered navigation, waiting for load`);
            await cdp.waitForEvent("Page.loadEventFired", 15_000).catch(() => {
              console.warn(`[BrowserSession][cdp-action] click i=${i} navigation load timeout`);
            });
            // Extra stabilization: some sites (e.g. Amazon) fire a second redirect after the
            // initial load event. Wait briefly for any follow-on navigation to begin+settle.
            await new Promise((r) => setTimeout(r, 800));
          }
          results.push({ action: i, ...clickResult });
        } else if (action.type === "wait") {
          // Poll for selector via repeated short Runtime.evaluate calls rather than a single
          // long-running IIFE. Short calls survive page navigation gracefully — if the page
          // redirects mid-wait the call fails quickly and we retry instead of getting killed.
          const selector = action.selector;
          const timeoutMs = action.timeoutMs ?? 10_000;
          const pollIntervalMs = 250;

          if (!selector) {
            // Pure timeout wait — no DOM query needed.
            await new Promise((r) => setTimeout(r, timeoutMs));
            results.push({ action: i, type: "wait", success: true, waited_ms: timeoutMs });
          } else {
            const start = Date.now();
            let found = false;
            console.info(`[BrowserSession][cdp-action] wait i=${i} polling for "${selector}" up to ${timeoutMs}ms`);

            while (Date.now() - start < timeoutMs) {
              try {
                const pollRes = await cdp.send<{ result?: { value?: boolean } }>("Runtime.evaluate", {
                  expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
                  returnByValue: true,
                });
                if (pollRes.result?.value === true) {
                  found = true;
                  break;
                }
              } catch (_) {
                // Page is navigating — wait a moment and retry.
              }
              await new Promise((r) => setTimeout(r, pollIntervalMs));
            }

            const elapsed = Date.now() - start;
            console.info(`[BrowserSession][cdp-action] wait i=${i} found=${found} elapsed=${elapsed}ms`);
            results.push({ action: i, type: "wait", success: found, selector, elapsed_ms: elapsed });
          }
        } else if (action.type === "screenshot") {
          // Use CDP Page.captureScreenshot. JPEG at quality 70 is ~6x smaller
          // than PNG (typically 25-40KB vs 140-200KB) which keeps the base64
          // payload out of the LLM context window.
          const captureRes = await cdp.send<{ data?: string }>("Page.captureScreenshot", {
            format: "jpeg",
            quality: 70,
            captureBeyondViewport: Boolean(action.fullPage),
          });
          console.info(
            `[BrowserSession][cdp-action] screenshot i=${i} captured=${Boolean(captureRes.data)} ` +
              `bytes=${captureRes.data?.length ?? 0}`
          );
          results.push({
            action: i,
            type: "screenshot",
            success: Boolean(captureRes.data),
            screenshotData: captureRes.data ?? null,
            fullPage: Boolean(action.fullPage),
          });
        } else {
          // type (and any future non-navigating, non-screenshot actions)
          const fragment = actionToCdpScript(action);

          const evalRes = await cdp.send<{ result?: { value?: Record<string, unknown> }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            {
              expression: `(async () => { ${fragment} })()`,
              awaitPromise: true,
              returnByValue: true,
              timeout: 15_000,
            }
          );

          if (evalRes.exceptionDetails) {
            const exc = evalRes.exceptionDetails as Record<string, unknown>;
            throw new Error(String(exc.text ?? `Script exception in ${action.type} action ${i}`));
          }

          const val = evalRes.result?.value ?? { type: action.type, success: false };
          results.push({ action: i, ...val });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[BrowserSession][cdp-action] action i=${i} type=${action.type} failed: ${msg}`);
        results.push({ action: i, type: action.type, success: false, error: msg });
        // Continue with remaining actions — a failed wait/screenshot should not abort the session.
      }
    }
  } finally {
    clearTimeout(overallTimer);
    cdp.close();
  }

  return results;
}

/**
 * Evaluate a compiled CDP/page-executable script in the target via a single Runtime.evaluate call.
 * Used as the fallback when raw cdpScript is provided instead of structured actions.
 */
async function evaluateScriptViaWebSocket(
  wsUrl: string,
  apiToken: string,
  script: string,
  timeoutMs = 30_000
): Promise<unknown> {
  const cdp = await openCdpWebSocket(wsUrl, apiToken);
  try {
    const evalRes = await cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: Record<string, unknown>;
    }>("Runtime.evaluate", {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    });

    if (evalRes.exceptionDetails) {
      throw new Error(
        String(evalRes.exceptionDetails.text ?? "CDP script exception")
      );
    }
    return evalRes.result?.value;
  } finally {
    cdp.close();
  }
}

// ─── Puppeteer executor (alternative backend) ─────────────────────────────────

/**
 * Derive the browser-level WebSocket URL from a page/target-level WS URL.
 *
 * Cloudflare Browser Run target URLs follow the pattern:
 *   wss://live.browser.run/api/devtools/browser/{sessionId}/page/{targetId}?jwt=...
 *
 * puppeteer.connect() needs the browser-level URL:
 *   wss://live.browser.run/api/devtools/browser/{sessionId}?jwt=...
 */
function toBrowserWebSocketUrl(targetWsUrl: string): string {
  try {
    // Work in https:// so URL parsing is reliable, then convert back to wss://.
    const parsed = new URL(targetWsUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://"));
    // Strip /page/{targetId} segment from the path.
    parsed.pathname = parsed.pathname.replace(/\/page\/[^/?]+$/, "");
    return parsed.toString().replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  } catch (_) {
    return targetWsUrl;
  }
}

/**
 * Execute browser actions using @cloudflare/puppeteer connected to an existing
 * Cloudflare Browser Run session.
 *
 * Switch to this backend by setting `stepExecutor: "puppeteer"` in
 * CloudflareBrowserRunApiConfig. The default remains "cdp".
 *
 * Advantages over CDP WebSocket:
 *  - page.goto() handles navigation + wait-for-load natively
 *  - page.waitForSelector() is reliable across redirects
 *  - page.screenshot() returns raw bytes, no CDP framing needed
 *  - click / type handle selector waits automatically
 */
async function executePuppeteerActions(
  targetWsUrl: string,
  actions: BrowserAction[]
): Promise<Array<Record<string, unknown>>> {
  const browserWsUrl = toBrowserWebSocketUrl(targetWsUrl);
  console.info(
    `[BrowserSession][puppeteer] connecting browserWsUrl=${browserWsUrl.slice(0, 100)}...`
  );

  // Dynamic import keeps the module out of the bundle when using CDP (the default).
  // It only pays the load cost on the first Puppeteer request.
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.connect({ browserWSEndpoint: browserWsUrl });
  const results: Array<Record<string, unknown>> = [];

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    page.setDefaultNavigationTimeout(20_000);
    page.setDefaultTimeout(15_000);

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.info(`[BrowserSession][puppeteer-action] i=${i} type=${action.type}`);

      try {
        switch (action.type) {
          case "navigate": {
            const normUrl = (u: string) => u.replace(/\/$/, "").toLowerCase();
            if (normUrl(page.url()) !== normUrl(action.url)) {
              await page.goto(action.url, { waitUntil: "domcontentloaded" });
            }
            results.push({ action: i, type: "navigate", success: true, url: action.url });
            break;
          }
          case "type": {
            await page.waitForSelector(action.selector);
            if (action.clearFirst) await page.click(action.selector, { clickCount: 3 });
            await page.type(action.selector, action.value, { delay: action.delayMs ?? 50 });
            results.push({ action: i, type: "type", success: true, selector: action.selector });
            break;
          }
          case "click": {
            await page.waitForSelector(action.selector);
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => undefined),
              page.click(action.selector),
            ]);
            results.push({ action: i, type: "click", success: true, selector: action.selector });
            break;
          }
          case "wait": {
            if (action.selector) {
              await page.waitForSelector(action.selector, {
                timeout: action.timeoutMs ?? 10_000,
              });
              results.push({ action: i, type: "wait", success: true, selector: action.selector });
            } else {
              await new Promise<void>((r) => setTimeout(r, action.timeoutMs ?? 1_000));
              results.push({ action: i, type: "wait", success: true });
            }
            break;
          }
          case "screenshot": {
            const binary = await page.screenshot({
              type: "jpeg",
              quality: 70,
              fullPage: action.fullPage ?? false,
            });
            const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary as ArrayBuffer);
            const base64 = Buffer.from(bytes).toString("base64");
            console.info(
              `[BrowserSession][puppeteer-action] screenshot i=${i} bytes=${bytes.byteLength}`
            );
            results.push({
              action: i,
              type: "screenshot",
              success: true,
              screenshotData: base64,
              fullPage: action.fullPage ?? false,
            });
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[BrowserSession][puppeteer-action] action i=${i} type=${action.type} failed: ${msg}`);
        results.push({ action: i, type: action.type, success: false, error: msg });
      }
    }
  } finally {
    // Disconnect without closing the remote session so it stays alive for reconnect.
    browser.disconnect();
  }

  return results;
}
