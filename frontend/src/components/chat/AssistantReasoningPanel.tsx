import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { ActivityStepStatus, AssistantTurn, AssistantTurnStatus, ReasoningItem } from "../../types";
import { McpReauthCallout } from "./McpReauthCallout";

const COMBINED_WARMUP_MS = 700;

function reasoningStatusLabel(status: AssistantTurnStatus, isStreaming: boolean): string {
  if (status === "failed") return "Failed";
  if (status === "done") return "Complete";
  if (status === "awaiting_approval") return "Approval needed";
  if (isStreaming || status === "thinking" || status === "using_tools" || status === "finalizing") {
    return "Thinking…";
  }
  return "Complete";
}

function getStepLabel(status: ActivityStepStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return "Pending";
  }
}

function renderDetailLine(line: string, index: number): ReactElement {
  const trimmed = line.trim();
  const urlMatch = trimmed.match(/https?:\/\/\S+/i);

  if (/^title\s*:/i.test(trimmed)) {
    return (
      <p key={`detail-${index}`} className="activity-detail-kv">
        <span className="activity-detail-key">Title</span>
        <span className="activity-detail-value">{trimmed.replace(/^title\s*:/i, "").trim()}</span>
      </p>
    );
  }

  if (/^(first\s+)?h1\s*:/i.test(trimmed)) {
    return (
      <p key={`detail-${index}`} className="activity-detail-kv">
        <span className="activity-detail-key">First H1</span>
        <span className="activity-detail-value">{trimmed.replace(/^(first\s+)?h1\s*:/i, "").trim()}</span>
      </p>
    );
  }

  if (urlMatch) {
    const url = urlMatch[0];
    return (
      <p key={`detail-${index}`} className="activity-detail-kv">
        <span className="activity-detail-key">URL</span>
        <span className="activity-detail-value url">{url}</span>
      </p>
    );
  }

  return <p key={`detail-${index}`}>{line}</p>;
}

function BrainGlyph() {
  return (
    <svg
      className="reasoning-brain-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

export interface AssistantReasoningPanelProps {
  turn: AssistantTurn;
  /** Open when either legacy reasoning or activity flag is true (kept in sync by ChatPage). */
  expanded: boolean;
  onToggle: () => void;
  enableMcp?: boolean;
  onOpenMcpSettings?: () => void;
  onRetryMcpLastUser?: () => void;
}

/**
 * Single collapsible for model reasoning + tool/activity steps (agents-starter–style header:
 * "Reasoning" + status pill "Thinking…" / "Complete" / etc.).
 */
export function AssistantReasoningPanel({
  turn,
  expanded,
  onToggle,
  enableMcp = false,
  onOpenMcpSettings,
  onRetryMcpLastUser,
}: AssistantReasoningPanelProps) {
  const openSettings = onOpenMcpSettings ?? (() => {});
  const retryLast = onRetryMcpLastUser ?? (() => {});

  const items: ReasoningItem[] = turn.reasoningSummary;
  const steps = turn.activitySteps;
  const isActive = turn.status !== "done" && turn.status !== "failed";

  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive || items.length > 0 || steps.length > 0) return;
    const timer = setTimeout(() => setNow(Date.now()), COMBINED_WARMUP_MS);
    return () => clearTimeout(timer);
  }, [isActive, items.length, steps.length]);

  const stepsWithDuration = useMemo(
    () =>
      steps.map((step) => {
        const durationMs =
          step.durationMs ??
          (step.startedAt && step.completedAt ? Math.max(0, step.completedAt - step.startedAt) : undefined);
        return { ...step, durationMs };
      }),
    [steps]
  );

  const hasReasoning = items.length > 0;
  const hasSteps = stepsWithDuration.length > 0;
  const warmup =
    isActive &&
    !hasReasoning &&
    !hasSteps &&
    turn.startedAt &&
    now - turn.startedAt < COMBINED_WARMUP_MS;

  const statusLabel = reasoningStatusLabel(turn.status, Boolean(turn.isStreaming));
  const panelId = `reasoning-unified-panel-${turn.id}`;
  const toggleId = `reasoning-unified-toggle-${turn.id}`;

  return (
    <section className="turn-collapsible-card reasoning-unified-card" aria-label="Reasoning">
      <button
        type="button"
        className="turn-collapsible-toggle reasoning-unified-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        id={toggleId}
      >
        <span className="reasoning-unified-head-left">
          <BrainGlyph />
          <span className="turn-collapsible-title">Reasoning</span>
        </span>
        <span className="reasoning-unified-head-right">
          <span
            className={`reasoning-status-pill status-${turn.status}${Boolean(turn.isStreaming) ? " is-streaming" : ""}`}
          >
            {statusLabel}
          </span>
          <span className={`turn-caret${expanded ? " is-open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </span>
      </button>

      <div
        id={panelId}
        className={`turn-collapsible-body${expanded ? " is-open" : ""}`}
        role="region"
        aria-labelledby={toggleId}
      >
        <div className="turn-collapsible-content reasoning-unified-body">
          {hasReasoning ? (
            <ul className="reasoning-list">
              {items.map((item) => (
                <li key={item.id} className={`reasoning-item${item.status === "active" ? " is-active" : ""}`}>
                  <span className="reasoning-bullet" aria-hidden="true" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {hasSteps ? (
            <ol className="activity-rail reasoning-unified-activity" aria-label="Tool and activity steps">
              {stepsWithDuration.map((step) => {
                const detailsExpanded = expandedStepIds[step.id] ?? false;
                const hasDetails = Boolean(step.detailLines?.length);
                const detailsPanelId = `activity-step-${turn.id}-${step.id}`;
                const detailsToggleId = `activity-step-toggle-${turn.id}-${step.id}`;
                return (
                  <li key={step.id} className={`activity-step status-${step.status}`}>
                    <div className="activity-marker" aria-hidden="true" />
                    <div className="activity-main">
                      <div className="activity-head">
                        <span className="activity-label">{step.label}</span>
                        <span className={`activity-state status-${step.status}`}>{getStepLabel(step.status)}</span>
                      </div>
                      <div className="activity-meta-row">
                        {step.toolName && <span className="activity-chip">{step.toolName}</span>}
                        {typeof step.durationMs === "number" && (
                          <span className="activity-duration">{(step.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                      {hasDetails && (
                        <div className="activity-details-wrap">
                          <button
                            type="button"
                            className="activity-details-toggle"
                            onClick={() =>
                              setExpandedStepIds((prev) => ({ ...prev, [step.id]: !detailsExpanded }))
                            }
                            aria-expanded={detailsExpanded}
                            aria-controls={detailsPanelId}
                            id={detailsToggleId}
                          >
                            {detailsExpanded ? "Hide details" : "Show details"}
                          </button>
                          <div
                            id={detailsPanelId}
                            className={`activity-details${detailsExpanded ? " is-open" : ""}`}
                            role="region"
                            aria-labelledby={detailsToggleId}
                          >
                            {(step.detailLines ?? []).map((line, index) => renderDetailLine(line, index))}
                          </div>
                        </div>
                      )}
                      {enableMcp && step.status === "failed" && step.mcpReauth && (
                        <McpReauthCallout
                          data={step.mcpReauth}
                          onOpenSettings={openSettings}
                          onRetryLastUser={retryLast}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {!hasReasoning && !hasSteps && warmup ? (
            <div className="turn-loading-state" aria-live="polite">
              <div className="turn-loading-line" />
              <div className="turn-loading-line short" />
              <p>Thinking…</p>
            </div>
          ) : null}

          {!hasReasoning && !hasSteps && !warmup ? (
            <p className="turn-empty">No reasoning or tool activity has been recorded for this turn yet.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
