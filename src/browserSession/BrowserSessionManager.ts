/**
 * BrowserSessionManager
 *
 * Manages the lifecycle of persistent browser sessions:
 * - launch: creates a new session record and starts the browser (provider-backed when configured)
 * - resume: reconnects to an existing active/disconnected session
 * - pause: transitions to awaiting_human without closing the browser
 * - complete: finalizes the session and closes the browser target
 * - abandon: immediately closes and marks the session abandoned
 *
 * Design decisions:
 * - Sessions persist across LLM turns via Durable Object storage.
 * - Recording is always enabled at launch (browser tracing for audit/replay).
 * - The devtoolsFrontendUrl is captured immediately after target creation and stored.
 * - HITL (awaiting_human) is an explicit state; the manager never retries or restarts
 *   the browser while in this state.
 * - Close (complete/abandon) is the only path that shuts down the CDP target.
 * - browser_execute remains the fallback CDP invocation primitive.
 */

import type { ToolSet } from "ai";
import type {
  BrowserSessionState,
  BrowserSessionResult,
} from "./types";
import type { BrowserAction } from "./browserActions";
import { actionsToCdpScript, BrowserActionSchema } from "./browserActions";
import { makeBrowserSessionResult } from "./types";
import { BrowserSessionRepository } from "./BrowserSessionRepository";
import {
  CloudflareBrowserRunApi,
  type CloudflareBrowserRunApiConfig,
  type CloudflareBrowserRunTarget,
} from "./cloudflareBrowserRunApi";
import {
  type BrowserSessionProvider,
} from "./providerAdapter";

export interface SessionLaunchOptions {
  /** Initial URL or task description. */
  task: string;
  /** Whether to enable CDP trace recording (default: true). */
  recordingEnabled?: boolean;
  /** Explicit reusable-session mode. */
  sessionMode?: "ephemeral" | "reusable";
  /** Provider keep-alive window for reusable sessions. */
  keepAliveMs?: number;
  /** Reattach to an existing provider-backed Browser Run session. */
  reuseSessionId?: string;
  /** Explicitly pause after launch for human review/login. */
  pauseForHuman?: boolean;
  /** Pause only when a blocker/login wall is expected. */
  pauseForHumanOnBlocker?: boolean;
  /** Structured actions to execute after launch (navigate, click, type, wait, screenshot). */
  actions?: BrowserAction[];
  /**
   * Optional: the URL the first `navigate` action will open.
   * When set, the provider opens this URL in the initial tab instead of `about:blank`,
   * so the page starts loading before action execution begins.
   */
  firstNavigateUrl?: string;
  /**
   * Which browser automation backend to use for this session's actions.
   * "cdp" (default) — raw CDP over WebSocket (current production path).
   * "puppeteer"     — @cloudflare/puppeteer.
   * Overrides the construction-time provider config on a per-turn basis.
   */
  executorStrategy?: "cdp" | "puppeteer";
}

export interface SessionStepOptions {
  /** CDP JavaScript to evaluate via browser_execute. */
  cdpScript?: string;
  /** Structured actions to execute (navigate, click, type, wait, screenshot). */
  actions?: BrowserAction[];
  /** Human instructions if this step requires user action. */
  humanInstructions?: string;
  /**
   * Which browser automation backend to use for this step.
   * "cdp" (default) — raw CDP over WebSocket (current production path).
   * "puppeteer"     — @cloudflare/puppeteer.
   * Overrides the construction-time provider config on a per-turn basis.
   */
  executorStrategy?: "cdp" | "puppeteer";
}

export interface BrowserSessionManagerOptions {
  storage: DurableObjectStorage;
  /** The agent's available tool set (must include browser_execute). */
  tools: ToolSet;
  /** Optional provider-backed browser session adapter (preferred path). */
  browserSessionProvider?: BrowserSessionProvider;
  /** Optional Cloudflare Browser Run API config for refreshing Live View URLs. */
  cloudflareBrowserRunApi?: CloudflareBrowserRunApiConfig;
  /** Optional API client override for tests. */
  browserRunApiClient?: Pick<CloudflareBrowserRunApi, "listSessionTargets">;
}

const LIVE_VIEW_CACHE_TTL_MS = 4 * 60 * 1000;

interface ObservedPageState {
  title?: string;
  currentUrl?: string;
  textSnippet?: string;
}

interface BlockerDetectionResult {
  detected: boolean;
  reason?: string;
}

// CDP script templates
const STEP_SCRIPT = (cdpScript: string) => cdpScript;

const CLOSE_SCRIPT = `
(async () => {
  try {
    await chrome.Page.disable();
  } catch (_) {}
  return { closed: true };
})()
`;

export class BrowserSessionManager {
  private readonly repo: BrowserSessionRepository;
  private readonly tools: ToolSet;
  private readonly browserRunApi?: Pick<CloudflareBrowserRunApi, "listSessionTargets">;
  private readonly activeMode: "provider_adapter" | "browser_execute_fallback";
  private readonly browserSessionProvider?: BrowserSessionManagerOptions["browserSessionProvider"];

  constructor(options: BrowserSessionManagerOptions) {
    this.repo = new BrowserSessionRepository(options.storage);
    this.tools = options.tools;
    this.browserSessionProvider = options.browserSessionProvider;
    this.activeMode = this.browserSessionProvider ? "provider_adapter" : "browser_execute_fallback";
    this.browserRunApi =
      (options.browserRunApiClient
        ? {
            listSessionTargets:
              options.browserRunApiClient.listSessionTargets.bind(options.browserRunApiClient),
          }
        : undefined) ??
      (options.cloudflareBrowserRunApi
        ? new CloudflareBrowserRunApi(options.cloudflareBrowserRunApi)
        : undefined);

    console.info(
      `[BrowserSession] constructor browserSessionProviderReceived=${this.browserSessionProvider ? "yes" : "no"}`
    );

    if (!this.browserSessionProvider) {
      console.warn(
        "[BrowserSession] browserSessionProvider is not configured in this workspace; using browser_execute fallback for now."
      );
    }

    console.info(`[BrowserSession] Startup mode=${this.activeMode}`);
  }

  /**
   * Create and launch a new persistent browser session.
   * Records the devtoolsFrontendUrl immediately after target creation.
   */
  async launch(options: SessionLaunchOptions): Promise<BrowserSessionResult> {
    if (options.reuseSessionId) {
      const existing = await this.findSessionByBrowserRunSessionId(options.reuseSessionId);
      if (existing) {
        const refreshed = await this.ensureFreshLiveViewUrl(existing);
        this.logStructuredEvent("browser.session.reused", {
          sessionId: existing.sessionId,
          browserRunSessionId: existing.browserRunSessionId,
          source: "existing_local_session",
        });
        return makeBrowserSessionResult(refreshed, {
          summary: `Reused existing browser session ${existing.sessionId}.`,
        });
      }
    }

    const sessionId = crypto.randomUUID();
    const recordingEnabled = options.recordingEnabled ?? true;
    const now = Date.now();

    const initialState: BrowserSessionState = {
      sessionId,
      status: "launching",
      recordingEnabled,
      pauseForHumanOnBlocker: options.pauseForHumanOnBlocker === true,
      createdAt: now,
      updatedAt: now,
      logLines: [],
    };

    await this.repo.save(initialState);

    // Derive the best initial tab URL from actions (first navigate) or task text.
    const firstNavigateAction = options.actions?.find((a) => a.type === "navigate") as
      | { type: "navigate"; url: string }
      | undefined;
    const firstNavigateUrl = firstNavigateAction?.url;
    if (firstNavigateUrl) {
      options = { ...options, firstNavigateUrl };
    }

    console.info(`[BrowserSession] Launching session ${sessionId}`);
    console.info(`[BrowserSession] launch path=${this.activeMode}`);
    console.info(
      `[BrowserSession][launch-diag] task=${JSON.stringify(options.task)} ` +
        `actionsCount=${options.actions?.length ?? 0} ` +
        `firstNavigateUrl=${firstNavigateUrl ?? "(none - will use task URL)"} ` +
        `sessionMode=${options.sessionMode ?? "ephemeral"} keepAliveMs=${options.keepAliveMs ?? "default"}`
    );

    let screenshotDataUrl: string | undefined;
    let launchResult: Record<string, unknown> = {};

    try {
      const launchAdapterResult = await this.executeLaunch(options, recordingEnabled);
      launchResult = launchAdapterResult.raw ?? {};
      screenshotDataUrl =
        launchAdapterResult.screenshotDataUrl ?? this.extractScreenshot(launchResult);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BrowserSession] Launch CDP error: ${errMsg}`);
      if (options.reuseSessionId && /SESSION_REUSE_FAILED/i.test(errMsg)) {
        this.logStructuredEvent("browser.session_reuse_fallback", {
          sessionId,
          requestedReuseSessionId: options.reuseSessionId,
          success: false,
          errorMessage: errMsg,
        });
      }
      await this.repo.patch(sessionId, {
        status: "abandoned",
        logLines: [`Launch error: ${errMsg}`],
      });
      const failed = await this.repo.get(sessionId);
      return makeBrowserSessionResult(failed!, {
        summary: `Session launch failed: ${errMsg}`,
      });
    }

    const launchMetadata = this.extractBrowserRunMetadata(launchResult);
    console.info(
      `[BrowserSession] Launch metadata localSessionId=${sessionId} ` +
        `browserRunSessionId=${launchMetadata.browserRunSessionId ?? "(missing)"} ` +
        `hasLaunchDevtoolsFrontendUrl=${launchMetadata.devtoolsFrontendUrl ? "yes" : "no"} ` +
        `hasLaunchLiveViewUrl=${launchMetadata.liveViewUrl ? "yes" : "no"}`
    );

    if (!launchMetadata.browserRunSessionId) {
      console.warn("provider launch did not return a provider session id; Live View cannot be refreshed");
      console.warn(`[BrowserSession] Session ${sessionId} no_live_view_available`);
    }

    const launchStatus = launchMetadata.needsHumanIntervention ? "awaiting_human" : "active";

    const updatedState = await this.repo.patch(sessionId, {
      status: launchStatus,
      currentTargetId: launchMetadata.currentTargetId,
      currentUrl: launchMetadata.currentUrl,
      devtoolsFrontendUrl: launchMetadata.devtoolsFrontendUrl,
      liveViewUrl: launchMetadata.liveViewUrl,
      liveViewUrlFetchedAt: launchMetadata.liveViewUrl ? Date.now() : undefined,
      title: launchMetadata.title,
      browserRunSessionId: launchMetadata.browserRunSessionId,
      reusableSessionId: launchMetadata.reusableSessionId,
      reusedSession: launchMetadata.reusedSession,
      sessionRecordingUrl: launchMetadata.sessionRecordingUrl,
      recordingId: launchMetadata.recordingId,
      recordingReady: launchMetadata.recordingReady,
      recordingUrl: launchMetadata.recordingUrl,
      needsHumanIntervention: launchMetadata.needsHumanIntervention,
      humanInterventionReason: launchMetadata.humanInterventionReason,
      resumableSession: launchMetadata.resumableSession,
      humanInstructions:
        launchMetadata.humanInterventionReason ??
        (options.pauseForHuman
          ? "Open Live View, complete the manual step, then resume the session."
          : undefined),
      liveViewUnavailableReason:
        launchMetadata.liveViewUrl || launchMetadata.devtoolsFrontendUrl
          ? undefined
          : launchMetadata.browserRunSessionId
            ? "target_missing_devtools_url"
            : "missing_provider_session_id",
      logLines: [`Session launched for task: ${options.task}`],
    });

    const refreshedState = updatedState
      ? await this.ensureFreshLiveViewUrl(updatedState)
      : updatedState;

    if (launchMetadata.reusedSession) {
      this.logStructuredEvent("browser.session.reused", {
        sessionId,
        browserRunSessionId: launchMetadata.browserRunSessionId,
        reusableSessionId: launchMetadata.reusableSessionId,
      });
    } else {
      this.logStructuredEvent("browser.session.created", {
        sessionId,
        browserRunSessionId: launchMetadata.browserRunSessionId,
        reusableSessionId: launchMetadata.reusableSessionId,
      });
    }

    if (refreshedState?.liveViewUrl || refreshedState?.devtoolsFrontendUrl) {
      this.logStructuredEvent("browser.live_view.available", {
        sessionId,
        browserRunSessionId: refreshedState.browserRunSessionId,
      });
    }

    if (recordingEnabled) {
      this.logStructuredEvent("browser.recording.enabled", {
        sessionId,
        browserRunSessionId: refreshedState?.browserRunSessionId,
        recordingId: refreshedState?.recordingId,
      });
    }

    if (refreshedState?.needsHumanIntervention) {
      this.logStructuredEvent("browser.human_intervention.requested", {
        sessionId,
        browserRunSessionId: refreshedState.browserRunSessionId,
        humanInterventionReason: refreshedState.humanInterventionReason,
      });
      this.logStructuredEvent("browser.human_intervention.ready", {
        sessionId,
        browserRunSessionId: refreshedState.browserRunSessionId,
        liveViewUrl: refreshedState.liveViewUrl,
      });
    }

    console.info(`[BrowserSession] Session ${sessionId} ${launchStatus}`);

    if (refreshedState && refreshedState.pauseForHumanOnBlocker) {
      const blockerPause = await this.maybePauseForDetectedBlocker(
        refreshedState,
        launchResult,
        `Browser session launched. Task: ${options.task}`
      );
      if (blockerPause) {
        return blockerPause;
      }
    }

    // Execute actions after launch if provided and session is active (not paused for human)
    let finalResult = makeBrowserSessionResult(refreshedState!, {
      summary: launchMetadata.needsHumanIntervention
        ? launchMetadata.humanInterventionReason ?? "Browser session paused for human input."
        : `Browser session launched. Task: ${options.task}`,
      screenshotDataUrl,
    });

    console.info(
      `[BrowserSession] launch actionsPresent=${options.actions && options.actions.length > 0 ? "yes" : "no"} ` +
        `actionsCount=${options.actions?.length ?? 0}`
    );

    if (options.actions && options.actions.length > 0 && refreshedState?.status === "active") {
      try {
        console.info(
          `[BrowserSession][pre-action-execute] session=${sessionId} ` +
            `actionsCount=${options.actions.length} ` +
            `currentUrl=${refreshedState.currentUrl ?? "about:blank"} ` +
            `actions=${JSON.stringify(options.actions.map((a) => ({ type: a.type, ...(a.type === "navigate" ? { url: (a as { url: string }).url } : {}) })))}`
        );
        const stepResult = await this.executeStep(refreshedState, {
          actions: options.actions,
          executorStrategy: options.executorStrategy,
        });
        
        // Update session with new state from actions
        const latestScreenshot = stepResult.raw ? this.extractScreenshot(stepResult.raw) : undefined;
        const actionsUpdated = await this.repo.patch(sessionId, {
          currentTargetId: stepResult.currentTargetId,
          currentUrl: stepResult.currentUrl,
          title: stepResult.title,
        });

        finalResult = makeBrowserSessionResult(actionsUpdated ?? refreshedState, {
          summary: `Session launched. Executed ${options.actions.length} actions successfully.`,
          screenshotDataUrl: latestScreenshot,
        });

        // Check for blockers after actions
        if (refreshedState.pauseForHumanOnBlocker && actionsUpdated) {
          const blockerPause = await this.maybePauseForDetectedBlocker(
            actionsUpdated,
            stepResult.raw ?? {},
            `Actions executed. Task: ${options.task}`
          );
          if (blockerPause) {
            return blockerPause;
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[BrowserSession] Error executing launch actions for ${sessionId}: ${errMsg}`);
        
        // Return error summary but keep session active for retry
        finalResult = makeBrowserSessionResult(refreshedState, {
          summary: `Session launched but action execution failed: ${errMsg}`,
          screenshotDataUrl,
        });
      }
    }

    return finalResult;
  }

  async reconnect(sessionId: string): Promise<BrowserSessionResult> {
    const session = await this.repo.get(sessionId);
    if (!session) {
      return this.unknownSessionResult(sessionId);
    }

    const refreshed = await this.ensureFreshLiveViewUrl(session);
    if (!refreshed.browserRunSessionId || refreshed.liveViewUnavailableReason === "invalid_provider_session_id") {
      const updated = await this.repo.patch(sessionId, {
        status: "disconnected",
        needsHumanIntervention: false,
        humanInterventionReason: "SESSION_REUSE_FAILED",
      });
      return makeBrowserSessionResult(updated ?? refreshed, {
        summary: "SESSION_REUSE_FAILED: the provider-backed browser session is no longer available.",
      });
    }

    const updated = await this.repo.patch(sessionId, {
      status: "active",
      needsHumanIntervention: false,
      humanInterventionReason: undefined,
      humanInstructions: undefined,
    });

    this.logStructuredEvent("browser.session.reused", {
      sessionId,
      browserRunSessionId: refreshed.browserRunSessionId,
      source: "reconnect",
    });

    return makeBrowserSessionResult(updated ?? refreshed, {
      summary: `Resumed browser session ${sessionId}.`,
    });
  }

  /**
   * Resume/reconnect an existing session and execute a CDP step.
   * Only permitted when status is active or disconnected.
   */
  async resume(
    sessionId: string,
    stepOptions: SessionStepOptions
  ): Promise<BrowserSessionResult> {
    const persistedSession = await this.repo.get(sessionId);
    if (!persistedSession) {
      return this.unknownSessionResult(sessionId);
    }

    let session = persistedSession;

    if (session.status === "awaiting_human" && !stepOptions.cdpScript) {
      console.info(`[BrowserSession] Session ${sessionId} is awaiting human input; not resuming`);
      const withFreshLiveView = await this.ensureFreshLiveViewUrl(session);
      return makeBrowserSessionResult(withFreshLiveView, {
        summary: `Session is awaiting human input: ${session.humanInstructions ?? ""}`,
      });
    }

    if (session.status === "completed" || session.status === "abandoned") {
      return makeBrowserSessionResult(session, {
        summary: `Session ${sessionId} is already ${session.status}.`,
      });
    }

    // Double-execute guard: if a step was dispatched very recently (within 3 s) and the
    // session is still active, return the current persisted state without re-running CDP.
    // This protects against the LLM issuing a duplicate tool call before the first one
    // has completed or before the updated state has been flushed to the client.
    const STEP_DEBOUNCE_MS = 3_000;
    if (
      session.status === "active" &&
      session.lastStepAt !== undefined &&
      Date.now() - session.lastStepAt < STEP_DEBOUNCE_MS
    ) {
      console.warn(
        `[BrowserSession] Duplicate step detected for session ${sessionId} ` +
          `(lastStepAt=${session.lastStepAt}, delta=${Date.now() - session.lastStepAt}ms); ` +
          `returning cached state.`
      );
      return makeBrowserSessionResult(session, {
        summary: `[deduplicated] ${session.logLines.at(-1) ?? "Step already in progress."}`,
      });
    }

    // Transition disconnected/awaiting_human → active on reconnect
    if (session.status === "disconnected" || session.status === "awaiting_human") {
      await this.repo.transition(sessionId, "active");
      console.info(`[BrowserSession] Session ${sessionId} reconnected`);
      if (session.status === "awaiting_human") {
        this.logStructuredEvent("browser.human_intervention.ready", {
          sessionId,
          browserRunSessionId: session.browserRunSessionId,
          liveViewUrl: session.liveViewUrl,
        });
      }

      const refreshed = await this.ensureFreshLiveViewUrl({
        ...session,
        status: "active",
        needsHumanIntervention: false,
        humanInterventionReason: undefined,
        humanInstructions: undefined,
      });
      const latestSession = await this.repo.get(sessionId);
      session = latestSession ?? refreshed;
    }

    // Mark pre-flight timestamp so concurrent/duplicate calls can be detected.
    await this.repo.patch(sessionId, { lastStepAt: Date.now() });

    let screenshotDataUrl: string | undefined;
    let stepResult: Record<string, unknown> = {};

    try {
      const stepAdapterResult = await this.executeStep(session, stepOptions);
      stepResult = stepAdapterResult.raw ?? {};
      screenshotDataUrl = this.extractScreenshot(stepResult);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BrowserSession] Step CDP error for ${sessionId}: ${errMsg}`);

      const lostProviderSession = /Session with given id not found/i.test(errMsg);
      const errorLog = lostProviderSession
        ? `Step error: ${errMsg} | Target/session state was lost and must be refreshed before next step.`
        : `Step error: ${errMsg}`;

      const updated = await this.repo.patch(sessionId, {
        status: "disconnected",
        lastStepAt: undefined, // Clear so reconnect is not blocked by debounce
        logLines: [...session.logLines, errorLog],
      });
      return makeBrowserSessionResult(updated!, {
        summary: `Step failed: ${errMsg}. Session is disconnected; will reconnect on next turn.`,
      });
    }

    const stepMetadata = this.extractBrowserRunMetadata(stepResult);
    if (!stepMetadata.browserRunSessionId) {
      console.warn(`[BrowserSession] Session ${sessionId} no_live_view_available`);
    }

    // Update URL if available
    const newUrl = stepMetadata.currentUrl ?? session.currentUrl;
    const logLine =
      typeof stepResult.description === "string"
        ? stepResult.description
        : `Step executed on ${newUrl ?? session.currentUrl ?? "unknown"}`;

    const nextTargetId = stepMetadata.currentTargetId ?? session.currentTargetId;

    // Clear lastStepAt on success — next sequential step must not be debounced.
    const updatedSession = await this.repo.patch(sessionId, {
      currentTargetId: nextTargetId,
      currentUrl: newUrl,
      title: stepMetadata.title ?? session.title,
      browserRunSessionId: stepMetadata.browserRunSessionId ?? session.browserRunSessionId,
      liveViewUrl: stepMetadata.liveViewUrl ?? session.liveViewUrl,
      devtoolsFrontendUrl: stepMetadata.devtoolsFrontendUrl ?? session.devtoolsFrontendUrl,
      sessionRecordingUrl: stepMetadata.sessionRecordingUrl ?? session.sessionRecordingUrl,
      reusableSessionId: stepMetadata.reusableSessionId ?? session.reusableSessionId,
      reusedSession: stepMetadata.reusedSession ?? session.reusedSession,
      recordingId: stepMetadata.recordingId ?? session.recordingId,
      recordingReady: stepMetadata.recordingReady ?? session.recordingReady,
      recordingUrl: stepMetadata.recordingUrl ?? session.recordingUrl,
      needsHumanIntervention: false,
      humanInterventionReason: undefined,
      resumableSession: stepMetadata.resumableSession ?? session.resumableSession,
      liveViewUnavailableReason:
        stepMetadata.liveViewUrl || stepMetadata.devtoolsFrontendUrl
          ? undefined
          : (stepMetadata.browserRunSessionId ?? session.browserRunSessionId)
            ? session.liveViewUnavailableReason
            : "missing_provider_session_id",
      lastStepAt: undefined,
      logLines: [...session.logLines, logLine],
    });

    // Check if the step requested a human pause
    if (stepOptions.humanInstructions) {
      await this.repo.transition(sessionId, "awaiting_human");
      const paused = await this.repo.patch(sessionId, {
        humanInstructions: stepOptions.humanInstructions,
        status: "awaiting_human",
        needsHumanIntervention: true,
        humanInterventionReason: stepOptions.humanInstructions,
      });
      const pausedWithFreshLiveView = paused
        ? await this.ensureFreshLiveViewUrl(paused)
        : paused;
      this.logStructuredEvent("browser.human_intervention.requested", {
        sessionId,
        browserRunSessionId: pausedWithFreshLiveView?.browserRunSessionId,
        humanInterventionReason: stepOptions.humanInstructions,
      });
      return makeBrowserSessionResult(pausedWithFreshLiveView!, {
        summary: `Session paused awaiting human input: ${stepOptions.humanInstructions}`,
        screenshotDataUrl,
      });
    }

    const sessionWithFreshLiveView = updatedSession
      ? await this.ensureFreshLiveViewUrl(updatedSession)
      : updatedSession;

    if (sessionWithFreshLiveView?.pauseForHumanOnBlocker) {
      const blockerPause = await this.maybePauseForDetectedBlocker(
        sessionWithFreshLiveView,
        stepResult,
        logLine
      );
      if (blockerPause) {
        return blockerPause;
      }
    }

    return makeBrowserSessionResult(sessionWithFreshLiveView!, {
      summary: logLine,
      screenshotDataUrl,
    });
  }

  /**
   * Pause a session, transitioning to awaiting_human.
   * The browser process is left running — do not close it.
   */
  async pause(sessionId: string, humanInstructions: string): Promise<BrowserSessionResult> {
    const session = await this.repo.get(sessionId);
    if (!session) {
      return this.unknownSessionResult(sessionId);
    }

    const updated = await this.repo.patch(sessionId, {
      status: "awaiting_human",
      humanInstructions,
      needsHumanIntervention: true,
      humanInterventionReason: humanInstructions,
    });

    const withFreshLiveView = updated
      ? await this.ensureFreshLiveViewUrl(updated)
      : updated;

    console.info(`[BrowserSession] Session ${sessionId} paused for human`);
    this.logStructuredEvent("browser.human_intervention.requested", {
      sessionId,
      browserRunSessionId: withFreshLiveView?.browserRunSessionId,
      humanInterventionReason: humanInstructions,
    });
    return makeBrowserSessionResult(withFreshLiveView!, {
      summary: `Session paused. ${humanInstructions}`,
    });
  }

  /**
   * Complete a session: run final CDP cleanup, mark completed, and close the target.
   */
  async complete(sessionId: string, summary: string): Promise<BrowserSessionResult> {
    const session = await this.repo.get(sessionId);
    if (!session) {
      return this.unknownSessionResult(sessionId);
    }

    try {
      await this.executeCdp(CLOSE_SCRIPT);
    } catch (_) {
      // Best-effort close
    }

    const updated = await this.repo.patch(sessionId, {
      status: "completed",
      finalSummary: summary,
    });

    console.info(`[BrowserSession] Session ${sessionId} completed`);
    return makeBrowserSessionResult(updated!, { summary });
  }

  /**
   * Abandon a session immediately and close the CDP target.
   */
  async abandon(sessionId: string): Promise<BrowserSessionResult> {
    const session = await this.repo.get(sessionId);
    if (!session) {
      return this.unknownSessionResult(sessionId);
    }

    try {
      await this.executeCdp(CLOSE_SCRIPT);
    } catch (_) {
      // Best-effort close
    }

    const updated = await this.repo.patch(sessionId, {
      status: "abandoned",
      finalSummary: "Session abandoned.",
    });

    console.info(`[BrowserSession] Session ${sessionId} abandoned`);
    return makeBrowserSessionResult(updated!, { summary: "Session abandoned." });
  }

  /**
   * Look up an existing session by ID (for reconnect/recovery).
   */
  async get(sessionId: string): Promise<BrowserSessionState | undefined> {
    return this.repo.get(sessionId);
  }

  /**
   * Read a session as a result payload, refreshing Live View lease when stale.
   */
  async status(sessionId: string): Promise<BrowserSessionResult> {
    const session = await this.repo.get(sessionId);
    if (!session) return this.unknownSessionResult(sessionId);

    const withFreshLiveView = await this.ensureFreshLiveViewUrl(session);
    return makeBrowserSessionResult(withFreshLiveView);
  }

  /**
   * List all open/active sessions.
   */
  async listActive(): Promise<BrowserSessionState[]> {
    return this.repo.listActive();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async executeCdp(script: string): Promise<unknown> {
    const browserExecute = this.tools["browser_execute"];
    if (!browserExecute) {
      throw new Error("browser_execute tool is not available");
    }
    // The tool execute signature may vary; attempt to call it in the shape
    // expected by the Think tool interface.
    const toolFn = browserExecute as { execute?: (args: unknown) => Promise<unknown> };
    if (typeof toolFn.execute === "function") {
      console.debug(
        `[BrowserSession] executeCdp start scriptChars=${script.length}`
      );
      const result = await toolFn.execute({ code: script });
      console.debug("[BrowserSession] executeCdp success");
      return result;
    }
    throw new Error("browser_execute does not expose an execute() function");
  }

  private async executeLaunch(
    options: SessionLaunchOptions,
    recordingEnabled: boolean
  ): Promise<{
    browserRunSessionId?: string;
    liveViewUrl?: string;
    devtoolsFrontendUrl?: string;
    currentTargetId?: string;
    currentUrl?: string;
    title?: string;
    reusableSessionId?: string;
    reusedSession?: boolean;
    recordingId?: string;
    recordingReady?: boolean;
    recordingUrl?: string;
    needsHumanIntervention?: boolean;
    humanInterventionReason?: string;
    resumableSession?: {
      sessionId: string;
      liveViewUrl?: string;
      expiresAt?: string;
    };
    raw?: Record<string, unknown>;
    screenshotDataUrl?: string;
  }> {
    if (this.browserSessionProvider) {
      console.info(
        `[BrowserSession][executeLaunch] Calling provider.launch task=${JSON.stringify(options.task)} ` +
          `firstNavigateUrl=${options.firstNavigateUrl ?? "(will extract from task)"}`
      );
      const providerResult = await this.browserSessionProvider.launch({
        task: options.task,
        recordingEnabled,
        keepAliveMs: options.keepAliveMs,
        sessionMode: options.sessionMode,
        reuseSessionId: options.reuseSessionId,
        pauseForHuman: options.pauseForHuman,
        pauseForHumanOnBlocker: options.pauseForHumanOnBlocker,
        firstNavigateUrl: options.firstNavigateUrl,
      });
      if (!providerResult.browserRunSessionId) {
        const rawKeys = providerResult.raw ? Object.keys(providerResult.raw).join(",") : "(none)";
        console.error(
          `[BrowserSession] provider launch returned without browserRunSessionId rawKeys=${rawKeys}`
        );
      }
      return {
        browserRunSessionId: providerResult.browserRunSessionId,
        liveViewUrl: providerResult.liveViewUrl,
        devtoolsFrontendUrl: providerResult.devtoolsFrontendUrl,
        currentTargetId: providerResult.currentTargetId,
        currentUrl: providerResult.currentUrl,
        title: providerResult.title,
        reusableSessionId: providerResult.reusableSessionId,
        reusedSession: providerResult.reusedSession,
        recordingId: providerResult.recordingId,
        recordingReady: providerResult.recordingReady,
        recordingUrl: providerResult.recordingUrl,
        needsHumanIntervention: providerResult.needsHumanIntervention,
        humanInterventionReason: providerResult.humanInterventionReason,
        resumableSession: providerResult.resumableSession,
        screenshotDataUrl: providerResult.screenshotDataUrl,
        raw: providerResult.raw,
      };
    }

    if (this.activeMode === "provider_adapter") {
      console.error(
        "[BrowserSession] invariant violated: provider_adapter launch fell through to browser_execute fallback"
      );
      throw new Error(
        "BrowserSessionManager.launch reached browser_execute fallback while provider mode was selected"
      );
    }

    // Fallback mode: low-level local launch only. No provider identity implied.
    const output = await this.executeCdp(this.buildFallbackLaunchScript(options.task, recordingEnabled));
    const raw = this.asRecord(output) ?? {};
    return {
      currentTargetId: this.firstString(raw.currentTargetId),
      currentUrl: this.firstString(raw.currentUrl),
      title: this.firstString(raw.title),
      screenshotDataUrl: this.extractScreenshot(raw),
      raw,
    };
  }

  private async executeStep(
    session: BrowserSessionState,
    options: SessionStepOptions
  ): Promise<{
    browserRunSessionId?: string;
    liveViewUrl?: string;
    devtoolsFrontendUrl?: string;
    currentTargetId?: string;
    currentUrl?: string;
    title?: string;
    reusableSessionId?: string;
    reusedSession?: boolean;
    recordingId?: string;
    recordingReady?: boolean;
    recordingUrl?: string;
    needsHumanIntervention?: boolean;
    humanInterventionReason?: string;
    resumableSession?: {
      sessionId: string;
      liveViewUrl?: string;
      expiresAt?: string;
    };
    raw?: Record<string, unknown>;
    screenshotDataUrl?: string;
  }> {
    // Validate structured actions if present.
    if (options.actions && options.actions.length > 0) {
      for (const action of options.actions) {
        try {
          BrowserActionSchema.parse(action);
        } catch (err) {
          throw new Error(`Invalid browser action: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // When a provider step is available and we have actions, delegate directly to the provider.
    // The provider (Cloudflare Browser Run) executes each action individually via CDP WebSocket,
    // which correctly handles page navigation between actions (e.g. click → search results page).
    if (this.browserSessionProvider?.step && session.browserRunSessionId) {
      if (!options.actions?.length && !options.cdpScript) {
        throw new Error("Browser session step requires either cdpScript or actions");
      }

      // For the non-provider fallback we still need a compiled cdpScript, but for the
      // provider we can pass actions directly so it can use per-action CDP execution.
      let fallbackCdpScript = options.cdpScript ?? "";
      if (!fallbackCdpScript && options.actions && options.actions.length > 0) {
        // Build a compiled script only as a fallback string (provider may ignore it).
        fallbackCdpScript = actionsToCdpScript(options.actions);
        console.info(
          `[BrowserSession][actions-transpile] Compiled ${options.actions.length} actions into fallback script ` +
            `(${fallbackCdpScript.length} chars). Types: ${options.actions.map((a) => a.type).join(", ")}`
        );
      }

      console.info(
        `[BrowserSession][step-execute] session=${session.sessionId} ` +
          `actionsCount=${options.actions?.length ?? 0} scriptLen=${fallbackCdpScript.length} ` +
          `provider=${this.activeMode} browserRunId=${session.browserRunSessionId}`
      );

      const providerResult = await this.browserSessionProvider.step({
        browserRunSessionId: session.browserRunSessionId,
        cdpScript: fallbackCdpScript,
        actions: options.actions,
        executorStrategy: options.executorStrategy,
      });
      return {
        browserRunSessionId: providerResult.browserRunSessionId,
        liveViewUrl: providerResult.liveViewUrl,
        devtoolsFrontendUrl: providerResult.devtoolsFrontendUrl,
        recordingUrl: providerResult.recordingUrl,
        currentTargetId: providerResult.currentTargetId,
        currentUrl: providerResult.currentUrl,
        title: providerResult.title,
        reusableSessionId: providerResult.reusableSessionId,
        reusedSession: providerResult.reusedSession,
        recordingId: providerResult.recordingId,
        recordingReady: providerResult.recordingReady,
        needsHumanIntervention: providerResult.needsHumanIntervention,
        humanInterventionReason: providerResult.humanInterventionReason,
        resumableSession: providerResult.resumableSession,
        screenshotDataUrl: providerResult.screenshotDataUrl,
        raw: providerResult.raw,
      };
    }

    // Fallback low-level path: no provider, or provider present but no browserRunSessionId.
    // Build the compiled script now (we only reach here when there's no provider step).
    let finalCdpScript = options.cdpScript ?? "";
    if (options.actions && options.actions.length > 0) {
      const actionsScript = actionsToCdpScript(options.actions);
      finalCdpScript = options.cdpScript
        ? `(async () => { const a = await (${actionsScript}); const c = await (${options.cdpScript}); return { actions: a, cdp: c }; })()`
        : actionsScript;
    }
    if (!finalCdpScript) {
      throw new Error("Browser session step requires either cdpScript or actions");
    }
    if (this.browserSessionProvider && !session.browserRunSessionId) {
      throw new Error("Provider-backed step requires a valid browserRunSessionId");
    }
    const output = await this.executeCdp(STEP_SCRIPT(finalCdpScript));
    const raw = this.asRecord(output) ?? {};
    return {
      browserRunSessionId: this.firstString(raw.browserRunSessionId),
      liveViewUrl: this.firstString(raw.liveViewUrl),
      devtoolsFrontendUrl: this.firstString(raw.devtoolsFrontendUrl),
      recordingUrl: this.firstString(raw.recordingUrl),
      currentTargetId: this.firstString(raw.currentTargetId),
      currentUrl: this.firstString(raw.currentUrl),
      title: this.firstString(raw.title),
      reusableSessionId: this.firstString(raw.reusableSessionId),
      reusedSession: this.firstBoolean(raw.reusedSession),
      recordingId: this.firstString(raw.recordingId),
      recordingReady: this.firstBoolean(raw.recordingReady),
      needsHumanIntervention: this.firstBoolean(raw.needsHumanIntervention),
      humanInterventionReason: this.firstString(raw.humanInterventionReason),
      resumableSession: this.asResumableSession(raw.resumableSession),
      screenshotDataUrl: this.extractScreenshot(raw),
      raw,
    };
  }

  private buildFallbackLaunchScript(task: string, recordingEnabled: boolean): string {
    return `
(async () => {
  const result = { task: ${JSON.stringify(task)}, recordingEnabled: ${recordingEnabled} };

  try {
    const targetInfo = await chrome.Target.getTargetInfo({});
    result.currentTargetId = targetInfo?.targetInfo?.targetId;
  } catch (_) {}

  try {
    const nav = await chrome.Page.getNavigationHistory();
    const entry = nav?.entries?.[nav.currentIndex];
    if (entry?.url) result.currentUrl = entry.url;
  } catch (_) {}

  return result;
})()
`;
  }

  private async ensureFreshLiveViewUrl(session: BrowserSessionState): Promise<BrowserSessionState> {
    if (!session.sessionId) return session;

    const now = Date.now();
    const fetchedAt = session.liveViewUrlFetchedAt ?? 0;
    if (session.liveViewUrl && now - fetchedAt < LIVE_VIEW_CACHE_TTL_MS) {
      return session;
    }

    if (!this.browserRunApi) {
      // Live View URLs are sourced from Browser Run target metadata only.
      return session;
    }

    if (!session.browserRunSessionId) {
      console.info("[BrowserSession] Skipping Live View refresh: missing browserRunSessionId");
      const patched = await this.repo.patch(session.sessionId, {
        liveViewUnavailableReason: "missing_provider_session_id",
      });
      return patched ?? session;
    }

    const providerSessionId = session.browserRunSessionId;

    try {
      const targets = await this.browserRunApi.listSessionTargets(providerSessionId);
      console.debug(
        `[BrowserSession] Live View refresh browserRunSessionId=${providerSessionId} targetCount=${targets.length}`
      );
      if (!targets || targets.length === 0) return session;

      const chosen = this.selectTargetForLiveView(targets, session.currentTargetId);
      if (!chosen) return session;

      console.info(
        `[BrowserSession] Live View refresh sessionId=${session.sessionId} ` +
          `providerSessionId=${providerSessionId} ` +
          `chosenTargetId=${chosen.targetId ?? "(none)"} ` +
          `chosenUrl=${chosen.url ?? "(none)"} ` +
          `hasDevtoolsFrontendUrl=${chosen.devtoolsFrontendUrl ? "yes" : "no"}`
      );

      if (!chosen.devtoolsFrontendUrl) {
        const patched = await this.repo.patch(session.sessionId, {
          liveViewUnavailableReason: "target_missing_devtools_url",
        });
        return patched ?? session;
      }

      const patched = await this.repo.patch(session.sessionId, {
        liveViewUrl: chosen.devtoolsFrontendUrl,
        devtoolsFrontendUrl: chosen.devtoolsFrontendUrl,
        liveViewUrlFetchedAt: now,
        currentTargetId: chosen.targetId ?? session.currentTargetId,
        currentUrl: chosen.url ?? session.currentUrl,
        title: chosen.title ?? session.title,
        liveViewUnavailableReason: undefined,
      });

      return patched ?? session;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isInvalidProviderSession = /\bstatus\s*404\b/i.test(errMsg);

      if (isInvalidProviderSession) {
        console.warn(
          `[BrowserSession] Live View refresh failed for session ${session.sessionId}: provider session id is invalid or stale`
        );
        const patched = await this.repo.patch(session.sessionId, {
          browserRunSessionId: undefined,
          liveViewUnavailableReason: "invalid_provider_session_id",
        });
        return patched ?? session;
      }

      console.warn(
        `[BrowserSession] Live View refresh failed for session ${session.sessionId}: ${errMsg}`
      );
      const patched = await this.repo.patch(session.sessionId, {
        liveViewUnavailableReason: "refresh_failed",
      });
      return patched ?? session;
    }
  }

  private selectTargetForLiveView(
    targets: CloudflareBrowserRunTarget[],
    currentTargetId?: string
  ): CloudflareBrowserRunTarget | undefined {
    if (currentTargetId) {
      const exact = targets.find((t) => t.targetId === currentTargetId && t.devtoolsFrontendUrl);
      if (exact) return exact;
    }

    const pageTarget = targets.find(
      (t) => (t.type === "page" || t.type === undefined) && t.devtoolsFrontendUrl
    );
    if (pageTarget) return pageTarget;

    return targets.find((t) => Boolean(t.devtoolsFrontendUrl));
  }

  private extractScreenshot(output: Record<string, unknown>): string | undefined {
    // Look for the same fields as the existing screenshot normalization pipeline
    const candidates = [
      output._screenshotDataUrl,
      output.screenshotDataUrl,
      output.screenshotData,
      output.screenshotBase64,
      output.screenshot,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        if (candidate.startsWith("data:")) return candidate;
        // Raw base64 — promote to data URL
        return `data:image/png;base64,${candidate}`;
      }
    }
    return undefined;
  }

  private extractObservedPageState(
    result: Record<string, unknown>,
    session?: BrowserSessionState
  ): ObservedPageState {
    const metadata = this.asRecord(result.metadata);
    const title = this.firstString(result.title, metadata?.title, session?.title);
    const currentUrl = this.firstString(
      result.currentUrl,
      result.pageUrl,
      metadata?.currentUrl,
      metadata?.url,
      session?.currentUrl
    );
    const textSnippet = this.firstString(
      metadata?.text,
      metadata?.html,
      metadata?.bodyText,
      metadata?.message,
      result.rawOutputText,
      result.description
    );

    return {
      title,
      currentUrl,
      textSnippet: typeof textSnippet === "string" ? textSnippet.slice(0, 4000) : undefined,
    };
  }

  private detectBlocker(observed: ObservedPageState): BlockerDetectionResult {
    const title = (observed.title ?? "").toLowerCase();
    const currentUrl = (observed.currentUrl ?? "").toLowerCase();
    const text = (observed.textSnippet ?? "").toLowerCase();
    const combined = `${title} ${currentUrl} ${text}`;

    const explicitCaptcha =
      /\b(captcha|recaptcha|hcaptcha|turnstile)\b/.test(combined) ||
      /verify you are human|security check|challenge required|unusual traffic|one more step/i.test(
        combined
      );

    if (explicitCaptcha) {
      return {
        detected: true,
        reason:
          "Blocked on CAPTCHA or verification page. Open Live View and resume when the challenge is cleared.",
      };
    }

    const loginUrlSignal =
      /\/login\b|\/signin\b|\/sign-in\b|\/auth\b|\/authenticate\b|\/checkpoint\b/.test(
        currentUrl
      );
    const loginTitleSignal =
      /\bsign in\b|\bsign-in\b|\blog in\b|\blogin\b|authentication required|verify your identity/.test(
        title
      );
    const loginTextSignal =
      /\bsign in\b|\blog in\b|password|email address|continue with|enter your password|two-factor/i.test(
        text
      );

    const loginSignalCount = [loginUrlSignal, loginTitleSignal, loginTextSignal].filter(Boolean)
      .length;
    if (loginSignalCount >= 2) {
      return {
        detected: true,
        reason:
          "Blocked on a login or identity verification page. Open Live View and resume when the required sign-in step is complete.",
      };
    }

    return { detected: false };
  }

  private async maybePauseForDetectedBlocker(
    session: BrowserSessionState,
    result: Record<string, unknown>,
    fallbackSummary: string
  ): Promise<BrowserSessionResult | undefined> {
    const observed = this.extractObservedPageState(result, session);
    const blocker = this.detectBlocker(observed);
    if (!blocker.detected) {
      return undefined;
    }

    const resumableSession =
      session.resumableSession ??
      (session.reusableSessionId || session.browserRunSessionId
        ? {
            sessionId: session.reusableSessionId ?? session.browserRunSessionId ?? session.sessionId,
            liveViewUrl: session.liveViewUrl,
            expiresAt: undefined,
          }
        : undefined);

    const paused = await this.repo.patch(session.sessionId, {
      status: "awaiting_human",
      needsHumanIntervention: true,
      humanInterventionReason: blocker.reason,
      humanInstructions: blocker.reason,
      resumableSession,
      logLines: [...session.logLines, `Blocker detected: ${blocker.reason}`],
    });

    const withFreshLiveView = paused ? await this.ensureFreshLiveViewUrl(paused) : paused;
    this.logStructuredEvent("browser.human_intervention.requested", {
      sessionId: session.sessionId,
      browserRunSessionId: withFreshLiveView?.browserRunSessionId,
      humanInterventionReason: blocker.reason,
      blockerDetectedFrom: {
        title: observed.title,
        currentUrl: observed.currentUrl,
      },
    });

    return makeBrowserSessionResult(withFreshLiveView!, {
      summary: blocker.reason ?? fallbackSummary,
    });
  }

  private extractBrowserRunSessionId(result: Record<string, unknown>): string | undefined {
    const metadata = this.asRecord(result.metadata);

    // Boundary: only trust fields explicitly designated as provider-side Browser Run
    // session identities. Never infer provider identity from generic local fields
    // such as result.sessionId/currentTargetId/cfSessionId.
    const sessionIdCandidates = [
      metadata?.sessionId,
      metadata?.providerSessionId,
      metadata?.reusableSessionId,
      metadata?.resumableSessionId,
      metadata?.browserRunSessionId,
      result.reusableSessionId,
      result.resumableSessionId,
      result.browserRunSessionId,
      result.providerSessionId,
    ];

    for (const candidate of sessionIdCandidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private extractBrowserRunMetadata(result: Record<string, unknown>): {
    browserRunSessionId?: string;
    reusableSessionId?: string;
    reusedSession?: boolean;
    liveViewUrl?: string;
    devtoolsFrontendUrl?: string;
    sessionRecordingUrl?: string;
    recordingId?: string;
    recordingReady?: boolean;
    recordingUrl?: string;
    needsHumanIntervention?: boolean;
    humanInterventionReason?: string;
    resumableSession?: {
      sessionId: string;
      liveViewUrl?: string;
      expiresAt?: string;
    };
    currentTargetId?: string;
    currentUrl?: string;
    title?: string;
  } {
    const metadata = this.asRecord(result.metadata);

    const browserRunSessionId = this.extractBrowserRunSessionId(result);
    const reusableSessionId = this.firstString(
      result.reusableSessionId,
      metadata?.reusableSessionId,
      browserRunSessionId
    );
    const liveViewUrl = this.firstString(
      result.liveViewUrl,
      result._liveViewUrl,
      metadata?.liveViewUrl
    );
    const devtoolsFrontendUrl = this.firstString(
      result.devtoolsFrontendUrl,
      result._devtoolsFrontendUrl,
      metadata?.devtoolsFrontendUrl
    );
    const sessionRecordingUrl = this.firstString(
      result.recordingUrl,
      result._recordingUrl,
      result.sessionRecordingUrl,
      metadata?.recordingUrl,
      metadata?.sessionRecordingUrl
    );
    const recordingId = this.firstString(result.recordingId, metadata?.recordingId);
    const recordingReady = this.firstBoolean(result.recordingReady, metadata?.recordingReady);
    const recordingUrl = this.firstString(result.recordingUrl, metadata?.recordingUrl);
    const needsHumanIntervention = this.firstBoolean(
      result.needsHumanIntervention,
      metadata?.needsHumanIntervention
    );
    const humanInterventionReason = this.firstString(
      result.humanInterventionReason,
      metadata?.humanInterventionReason
    );
    const resumableSession =
      this.asResumableSession(result.resumableSession) ?? this.asResumableSession(metadata?.resumableSession);
    const currentTargetId = this.firstString(
      result.currentTargetId,
      metadata?.targetId,
      metadata?.currentTargetId
    );
    const currentUrl = this.firstString(result.currentUrl, metadata?.url, metadata?.currentUrl);
    const title = this.firstString(result.title, metadata?.title);

    return {
      browserRunSessionId,
      reusableSessionId,
      reusedSession: this.firstBoolean(result.reusedSession, metadata?.reusedSession),
      liveViewUrl,
      devtoolsFrontendUrl,
      sessionRecordingUrl,
      recordingId,
      recordingReady,
      recordingUrl,
      needsHumanIntervention,
      humanInterventionReason,
      resumableSession,
      currentTargetId,
      currentUrl,
      title,
    };
  }

  private asResumableSession(value: unknown):
    | { sessionId: string; liveViewUrl?: string; expiresAt?: string }
    | undefined {
    const record = this.asRecord(value);
    if (!record) return undefined;
    const sessionId = this.firstString(record.sessionId);
    if (!sessionId) return undefined;
    return {
      sessionId,
      liveViewUrl: this.firstString(record.liveViewUrl),
      expiresAt: this.firstString(record.expiresAt),
    };
  }

  private async findSessionByBrowserRunSessionId(
    browserRunSessionId: string
  ): Promise<BrowserSessionState | undefined> {
    const activeSessions = await this.repo.listActive();
    return activeSessions.find((session) => session.browserRunSessionId === browserRunSessionId);
  }

  private logStructuredEvent(event: string, payload: Record<string, unknown>): void {
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event,
        ...payload,
      })
    );
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
  }

  private firstBoolean(...values: unknown[]): boolean | undefined {
    for (const value of values) {
      if (typeof value === "boolean") return value;
    }
    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private unknownSessionResult(sessionId: string): BrowserSessionResult {
    return {
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId,
      status: "abandoned",
      recordingEnabled: false,
      summary: `Session ${sessionId} not found.`,
    };
  }
}
