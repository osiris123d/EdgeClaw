/**
 * Browser Session Types
 *
 * Schema for persistent browser sessions distinct from one-shot browser_execute calls.
 * These sessions survive LLM turns, support recording, HITL pauses, and reconnect.
 */

export type BrowserSessionStatus =
  | "pending"          // session requested, not yet launched
  | "launching"        // CDP target being created
  | "active"           // browser running, tool calls in flight
  | "awaiting_human"   // HITL pause — do not retry or restart
  | "disconnected"     // temporarily disconnected; will reconnect on next turn
  | "completed"        // task finished; session closed
  | "abandoned";       // explicitly abandoned; session closed

export type LiveViewUnavailableReason =
  | "missing_provider_session_id"
  | "refresh_failed"
  | "invalid_provider_session_id"
  | "target_missing_devtools_url";

export interface BrowserSessionState {
  /** Opaque session ID (UUID generated at launch). */
  sessionId: string;

  /** Current lifecycle status. */
  status: BrowserSessionStatus;

  /** Whether recording is enabled for this session (CDP tracing). */
  recordingEnabled: boolean;

  /** Chrome DevTools frontend URL for live inspection (captured immediately after target creation). */
  devtoolsFrontendUrl?: string;

  /** Live view URL if the session exposes a readable stream / screenshot feed. */
  liveViewUrl?: string;

  /** Unix ms timestamp when liveViewUrl was last refreshed from Cloudflare API. */
  liveViewUrlFetchedAt?: number;

  /** CDP targetId for the current page/tab. */
  currentTargetId?: string;

  /** Most recently known page URL (updated by browser_execute results). */
  currentUrl?: string;

  /** Most recent page title if available from Browser Run targets. */
  title?: string;

  /** Optional Browser Run recording URL when finalized by provider. */
  sessionRecordingUrl?: string;

  /** Stable reusable Browser Run session identifier surfaced to UI/agents. */
  reusableSessionId?: string;

  /** True when the current session launch/attach reused an existing warm provider session. */
  reusedSession?: boolean;

  /** Browser Run recording identifier when recording is enabled. */
  recordingId?: string;

  /** Recording readiness flag; false while the session remains open/reusable. */
  recordingReady?: boolean;

  /** Optional recording retrieval URL when the provider/runtime exposes it. */
  recordingUrl?: string;

  /** True when the session is intentionally paused for human action. */
  needsHumanIntervention?: boolean;

  /** Machine-readable reason or operator-facing explanation for HITL pause. */
  humanInterventionReason?: string;

  /** Resumable session descriptor for UI/runtime reconnect flows. */
  resumableSession?: {
    sessionId: string;
    liveViewUrl?: string;
    expiresAt?: string;
  };

  /** Machine-readable reason when Live View URL cannot be provided. */
  liveViewUnavailableReason?: LiveViewUnavailableReason;

  /** Provider-side Browser Run session identifier, if available. */
  browserRunSessionId?: string;

  /** Unix ms timestamp when the session was first created. */
  createdAt: number;

  /** Unix ms timestamp of the last state transition. */
  updatedAt: number;

  /** If status is awaiting_human, this describes what the user must do. */
  humanInstructions?: string;

  /** Whether this session should pause when a real blocker is detected from observed page state. */
  pauseForHumanOnBlocker?: boolean;

  /** Accumulated log lines from the session (non-screenshot metadata). */
  logLines: string[];

  /** Unix ms timestamp when the last CDP step began executing (set pre-flight, cleared on completion). */
  lastStepAt?: number;

  /** If status is completed/abandoned, the final summary sent to the LLM. */
  finalSummary?: string;
}

/**
 * Schema for the structured result returned by the browser_session tool.
 *
 * This is emitted as the tool output and carried through the activity step
 * into the assistant timeline card.
 */
export interface BrowserSessionResult {
  schema: "edgeclaw.browser-session-result";
  schemaVersion: 1;
  sessionId: string;
  status: BrowserSessionStatus;
  recordingEnabled: boolean;
  browserRunSessionId?: string;
  reusableSessionId?: string;
  reusedSession?: boolean;
  devtoolsFrontendUrl?: string;
  liveViewUrl?: string;
  liveViewUrlFetchedAt?: number;
  currentUrl?: string;
  title?: string;
  currentTargetId?: string;
  sessionRecordingUrl?: string;
  recordingId?: string;
  recordingReady?: boolean;
  recordingUrl?: string;
  browserRunSessionIdPresent?: boolean;
  needsHumanIntervention?: boolean;
  humanInterventionReason?: string;
  resumableSession?: {
    sessionId: string;
    liveViewUrl?: string;
    expiresAt?: string;
  };
  liveViewUnavailableReason?: LiveViewUnavailableReason;
  summary?: string;
  logLines?: string[];
  /** UI-only rendering hint: canonical live view URL alias for chat cards. */
  _liveViewUrl?: string;
  /** UI-only rendering hint: whether the session currently needs human input. */
  _needsHumanIntervention?: boolean;
  /** UI-only rendering hint for reconnecting an existing browser_session record. */
  _resumeBrowserAction?: {
    operation: "resume_browser_session";
    sessionId: string;
  };
  /** UI-only rendering hint: screenshot data URL captured at end of session step. */
  _screenshotDataUrl?: string;
}

export function makeBrowserSessionResult(
  session: BrowserSessionState,
  opts: { summary?: string; screenshotDataUrl?: string } = {}
): BrowserSessionResult {
  return {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: session.sessionId,
    status: session.status,
    recordingEnabled: session.recordingEnabled,
    browserRunSessionId: session.browserRunSessionId,
    reusableSessionId: session.reusableSessionId,
    reusedSession: session.reusedSession,
    devtoolsFrontendUrl: session.devtoolsFrontendUrl,
    liveViewUrl: session.liveViewUrl,
    liveViewUrlFetchedAt: session.liveViewUrlFetchedAt,
    currentUrl: session.currentUrl,
    title: session.title,
    currentTargetId: session.currentTargetId,
    sessionRecordingUrl: session.sessionRecordingUrl,
    recordingId: session.recordingId,
    recordingReady: session.recordingReady,
    recordingUrl: session.recordingUrl,
    browserRunSessionIdPresent: typeof session.browserRunSessionId === "string",
    needsHumanIntervention: session.needsHumanIntervention,
    humanInterventionReason: session.humanInterventionReason,
    resumableSession: session.resumableSession,
    liveViewUnavailableReason: session.liveViewUnavailableReason,
    summary: opts.summary ?? session.finalSummary,
    logLines: session.logLines.length > 0 ? [...session.logLines] : undefined,
    _liveViewUrl: session.liveViewUrl,
    _needsHumanIntervention: session.needsHumanIntervention,
    _resumeBrowserAction:
      session.browserRunSessionId || session.reusableSessionId || session.status === "awaiting_human"
        ? {
            operation: "resume_browser_session",
            sessionId: session.sessionId,
          }
        : undefined,
    _screenshotDataUrl: opts.screenshotDataUrl,
  };
}

export function isBrowserSessionResult(value: unknown): value is BrowserSessionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.schema === "edgeclaw.browser-session-result" &&
    r.schemaVersion === 1 &&
    typeof r.sessionId === "string"
  );
}
