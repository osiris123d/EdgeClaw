import { useState } from "react";
import type { ActivityStep } from "../../types";
import { isBrowserSessionResult } from "../../types";

interface BrowserSessionInlineSectionProps {
  steps: ActivityStep[];
  onResumeBrowserSession?: (sessionId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  launching: "Launching…",
  active: "Active",
  awaiting_human: "Awaiting your input",
  disconnected: "Disconnected",
  completed: "Completed",
  abandoned: "Abandoned",
};

const STATUS_CLASSES: Record<string, string> = {
  pending: "status-pending",
  launching: "status-launching",
  active: "status-active",
  awaiting_human: "status-awaiting",
  disconnected: "status-disconnected",
  completed: "status-completed",
  abandoned: "status-abandoned",
};

export function BrowserSessionInlineSection({
  steps,
  onResumeBrowserSession,
}: BrowserSessionInlineSectionProps) {
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);

  // Collect activity steps that carry a browser_session result
  const sessionSteps = steps.filter(
    (step) =>
      step.toolName === "browser_session" &&
      step.sessionResult &&
      isBrowserSessionResult(step.sessionResult)
  );

  if (sessionSteps.length === 0) return null;

  return (
    <section className="browser-session-section" aria-label="Browser session">
      {sessionSteps.map((step) => {
        const result = step.sessionResult!;
        const statusLabel = STATUS_LABELS[result.status] ?? result.status;
        const statusClass = STATUS_CLASSES[result.status] ?? "";

        return (
          <article
            key={step.id}
            className={`browser-session-card ${statusClass}`}
            aria-label="Browser session status"
          >
            {/* Header row */}
            <div className="browser-session-header">
              <span className={`browser-session-status-badge ${statusClass}`}>{statusLabel}</span>
              {result.recordingEnabled && (
                <span className="browser-session-recording-badge" aria-label="Recording enabled">
                  ● REC
                </span>
              )}
              {(result._liveViewUrl ?? result.liveViewUrl) && (
                <a
                  href={result._liveViewUrl ?? result.liveViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="browser-session-live-view-link"
                  aria-label="Open Live View"
                >
                  Open Live View
                </a>
              )}
              {!result.liveViewUrl && result.devtoolsFrontendUrl && (
                <a
                  href={result.devtoolsFrontendUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="browser-session-devtools-link"
                  aria-label="Open DevTools"
                >
                  DevTools ↗
                </a>
              )}
            </div>

            {/* Screenshot inline (reuses existing .browser-artifact-preview-wrap style) */}
            {result._screenshotDataUrl && (
              <div className="browser-artifact-preview-wrap">
                <img
                  src={result._screenshotDataUrl}
                  alt={result.currentUrl ? `Screenshot of ${result.currentUrl}` : "Session screenshot"}
                  className="browser-artifact-preview"
                />
              </div>
            )}

            {/* Session metadata */}
            <div className="browser-session-meta">
              {result.title && <p>Page: {result.title}</p>}
              {result.currentUrl && <p>URL: {result.currentUrl}</p>}
              {result.reusedSession && <p>Session reused successfully.</p>}
              {result.recordingEnabled && !result.recordingReady && (
                <p>Recording is enabled and will be finalized when the session closes.</p>
              )}
              {result.recordingEnabled && result.recordingReady && !result.recordingUrl && (
                <p>Recording is ready, but this runtime does not expose a downloadable recording URL yet.</p>
              )}
              {result.recordingUrl && (
                <p>
                  <a href={result.recordingUrl} target="_blank" rel="noopener noreferrer">
                    Open recording
                  </a>
                </p>
              )}
              {result.summary && <p>{result.summary}</p>}
            </div>

            {/* HITL prompt */}
            {(result._needsHumanIntervention || result.needsHumanIntervention || result.status === "awaiting_human") && (
              <div className="browser-session-hitl-prompt" role="alert">
                <strong>Human action needed:</strong>{" "}
                {result.summary && result.summary !== `Browser session ${result.status}.`
                  ? result.summary
                  : "Please review and continue when ready."}
                {result._resumeBrowserAction?.sessionId && onResumeBrowserSession && (
                  <div className="browser-session-actions">
                    <button
                      type="button"
                      className="browser-session-secondary-action"
                      onClick={() => onResumeBrowserSession(result._resumeBrowserAction!.sessionId)}
                    >
                      Resume session
                    </button>
                  </div>
                )}
              </div>
            )}

            {(result.reusableSessionId || result.resumableSession?.sessionId) && (
              <div className="browser-session-reusable-panel">
                <div className="browser-session-reusable-header">Reusable Session</div>
                <div className="browser-session-reusable-row">
                  <code className="browser-session-reusable-id">
                    {result.reusableSessionId ?? result.resumableSession?.sessionId}
                  </code>
                  <button
                    type="button"
                    className="browser-session-secondary-action"
                    onClick={async () => {
                      const value = result.reusableSessionId ?? result.resumableSession?.sessionId;
                      if (!value || !navigator.clipboard) return;
                      await navigator.clipboard.writeText(value);
                      setCopiedSessionId(value);
                    }}
                  >
                    {copiedSessionId === (result.reusableSessionId ?? result.resumableSession?.sessionId)
                      ? "Copied"
                      : "Copy session ID"}
                  </button>
                  {result._resumeBrowserAction?.sessionId && onResumeBrowserSession && (
                    <button
                      type="button"
                      className="browser-session-secondary-action"
                      onClick={() => onResumeBrowserSession(result._resumeBrowserAction!.sessionId)}
                    >
                      Resume session
                    </button>
                  )}
                </div>
                {result.resumableSession?.expiresAt && (
                  <p className="browser-session-reusable-meta">
                    Expires: {new Date(result.resumableSession.expiresAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            {/* Log lines — collapsible */}
            {result.logLines && result.logLines.length > 0 && (
              <details className="browser-artifact-debug">
                <summary>Session log ({result.logLines.length} lines)</summary>
                <pre>{result.logLines.join("\n")}</pre>
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}
