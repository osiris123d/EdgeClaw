import { useState } from "react";
import type { WorkflowRun, WorkflowRunStatus } from "../../types/workflows";
import { WorkflowRunStatusBadge } from "./WorkflowRunStatusBadge";
import { WorkflowProgressBar }   from "./WorkflowProgressBar";

// ── Props ─────────────────────────────────────────────────────────────────────

interface RunInspectorDrawerProps {
  /** undefined = closed */
  run:         WorkflowRun | undefined;
  busy:        boolean;
  onTerminate: (runId: string) => void;
  onApprove:   (runId: string) => void;
  onReject:    (runId: string) => void;
  onResume:    (runId: string) => void;
  onRestart:   (runId: string) => void;
  onClose:     () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtDuration(startedAt: string, completedAt?: string | null): string {
  if (!completedAt) return "—";
  try {
    const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return ms < 0 ? "—" : fmtMs(ms);
  } catch {
    return "—";
  }
}

function fmtElapsed(startedAt: string): string {
  try {
    const ms = Date.now() - new Date(startedAt).getTime();
    return ms < 0 ? "—" : `${fmtMs(ms)} elapsed`;
  } catch {
    return "—";
  }
}

// ── State banner ──────────────────────────────────────────────────────────────

const STATE_LABEL: Record<WorkflowRunStatus, string> = {
  running:    "Running — execution in progress",
  waiting:    "Waiting — paused on a step or event",
  paused:     "Paused",
  complete:   "Completed successfully",
  errored:    "Errored — execution failed",
  terminated: "Terminated — run was aborted",
  unknown:    "Unknown state",
};

const ACTIVE_STATUSES: ReadonlySet<WorkflowRunStatus>   = new Set(["running", "waiting", "paused"]);
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["complete", "errored", "terminated"]);

function StateBanner({ run }: { run: WorkflowRun }) {
  const isActive = ACTIVE_STATUSES.has(run.status);
  return (
    <div className={`wf-inspector-state wf-inspector-state-${run.status}`}>
      <WorkflowRunStatusBadge
        status={run.status}
        waitingForApproval={run.waitingForApproval}
        size="sm"
      />
      <span style={{ flex: 1 }}>{STATE_LABEL[run.status]}</span>
      {run.waitingForApproval && (
        <span className="wf-approval-badge">Approval required</span>
      )}
      {isActive && !run.waitingForApproval && (
        <span style={{ fontSize: 12, opacity: 0.75 }}>
          {fmtElapsed(run.startedAt)}
        </span>
      )}
    </div>
  );
}

// ── Collapsible payload section ───────────────────────────────────────────────

function PayloadSection({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const hasData = value && Object.keys(value).length > 0;

  return (
    <>
      <button
        type="button"
        className="wf-payload-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!hasData}
        title={hasData ? undefined : "No data"}
      >
        <span className={`wf-payload-caret${open ? " is-open" : ""}`}>▶</span>
        {label}
        {!hasData && (
          <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.55 }}>— empty</span>
        )}
      </button>
      {open && hasData && (
        <pre className="wf-json-block">{JSON.stringify(value, null, 2)}</pre>
      )}
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RunInspectorDrawer({
  run, busy,
  onTerminate, onApprove, onReject, onResume, onRestart,
  onClose,
}: RunInspectorDrawerProps) {
  if (!run) return null;

  const isActive   = ACTIVE_STATUSES.has(run.status);
  const isTerminal = TERMINAL_STATUSES.has(run.status);
  const canApprove = !!run.waitingForApproval;
  const canResume  = run.status === "paused";

  return (
    <aside className="tasks-drawer" aria-label="Run inspector">

      {/* ── Header ── */}
      <div className="tasks-drawer-header">
        <h3 className="tasks-drawer-title">Run inspector</h3>
        <button
          type="button"
          className="tasks-drawer-close"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ✕
        </button>
      </div>

      {/* ── Body ── */}
      <div className="tasks-drawer-body">

        {/* Execution state banner */}
        <StateBanner run={run} />

        {/* Progress bar — shown whenever there's progress data */}
        {(run.progressPercent != null || run.currentStep) && (
          <div style={{ marginTop: 12, marginBottom: 4 }}>
            <WorkflowProgressBar
              percent={run.progressPercent}
              status={run.status}
              currentStep={run.currentStep}
            />
          </div>
        )}

        {/* Execution identity */}
        <div className="tasks-drawer-section">
          <h4 className="tasks-drawer-section-title">Execution</h4>

          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Workflow</span>
            <span className="tasks-drawer-meta-value">{run.workflowName}</span>
          </div>
          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Run ID</span>
            <span className="tasks-drawer-meta-value wf-run-id-mono">{run.id}</span>
          </div>
          {run.waitingForApproval && (
            <div className="tasks-drawer-meta-row">
              <span className="tasks-drawer-meta-label">Approval</span>
              <span className="tasks-drawer-meta-value" style={{ color: "#8a4000" }}>
                Waiting for reviewer
              </span>
            </div>
          )}
          {run.resultSummary && (
            <div className="tasks-drawer-meta-row">
              <span className="tasks-drawer-meta-label">Result</span>
              <span className="tasks-drawer-meta-value">{run.resultSummary}</span>
            </div>
          )}
        </div>

        {/* Timing */}
        <div className="tasks-drawer-section">
          <h4 className="tasks-drawer-section-title">Timing</h4>

          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Started</span>
            <span className="tasks-drawer-meta-value">{fmtDate(run.startedAt)}</span>
          </div>
          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Updated</span>
            <span className="tasks-drawer-meta-value">{fmtDate(run.updatedAt)}</span>
          </div>
          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Completed</span>
            <span className="tasks-drawer-meta-value">{fmtDate(run.completedAt)}</span>
          </div>
          <div className="tasks-drawer-meta-row">
            <span className="tasks-drawer-meta-label">Duration</span>
            <span className="tasks-drawer-meta-value">
              {isActive
                ? <span className="wf-elapsed">{fmtElapsed(run.startedAt)}</span>
                : fmtDuration(run.startedAt, run.completedAt)
              }
            </span>
          </div>
        </div>

        {/* Error — only shown when errored */}
        {run.errorMessage && (
          <div className="tasks-drawer-section">
            <h4 className="tasks-drawer-section-title" style={{ color: "var(--danger)" }}>
              Error
            </h4>
            <pre className="wf-error-block">{run.errorMessage}</pre>
          </div>
        )}

        {/* Payload — collapsible input / output sections */}
        <div className="tasks-drawer-section">
          <h4 className="tasks-drawer-section-title">Payload</h4>
          <PayloadSection label="Input"  value={run.input} />
          <PayloadSection label="Output" value={run.output} />
        </div>

      </div>

      {/* ── Footer actions ── */}
      <div className="tasks-drawer-footer">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
        >
          Close
        </button>

        {/* Approve — waiting for human approval */}
        {canApprove && (
          <button
            type="button"
            className="btn-header-secondary btn-tint-approve"
            onClick={() => onApprove(run.id)}
            disabled={busy}
            style={{ fontSize: 13, padding: "5px 14px" }}
          >
            {busy ? "…" : "Approve"}
          </button>
        )}

        {/* Reject — waiting for human approval */}
        {canApprove && (
          <button
            type="button"
            className="btn-danger"
            onClick={() => onReject(run.id)}
            disabled={busy}
          >
            {busy ? "…" : "Reject"}
          </button>
        )}

        {/* Resume — paused runs */}
        {canResume && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => onResume(run.id)}
            disabled={busy}
          >
            {busy ? "Resuming…" : "Resume run"}
          </button>
        )}

        {/* Restart — terminal runs */}
        {isTerminal && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => onRestart(run.id)}
            disabled={busy}
          >
            {busy ? "Restarting…" : "Restart run"}
          </button>
        )}

        {/* Terminate — active runs (not already handled by approve/reject) */}
        {isActive && !canApprove && !canResume && (
          <button
            type="button"
            className="btn-danger"
            onClick={() => onTerminate(run.id)}
            disabled={busy}
          >
            {busy ? "Terminating…" : "Terminate run"}
          </button>
        )}
        {(isActive && (canApprove || canResume)) && (
          <button
            type="button"
            className="btn-header-secondary tasks-action-delete"
            onClick={() => onTerminate(run.id)}
            disabled={busy}
            style={{ fontSize: 12, marginLeft: "auto" }}
          >
            Terminate
          </button>
        )}
      </div>

    </aside>
  );
}
