import { useState } from "react";
import type { WorkflowRun, WorkflowRunStatus } from "../../types/workflows";
import { WorkflowRunStatusBadge } from "./WorkflowRunStatusBadge";
import { WorkflowProgressBar }   from "./WorkflowProgressBar";
import { WorkflowTimeline }      from "./WorkflowTimeline";
import {
  fmtRelative,
  fmtAbsolute,
  fmtElapsed,
  fmtCompletedDuration,
} from "../../lib/workflowFormatters";

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowRunDrawerProps {
  /** undefined = drawer closed */
  run:         WorkflowRun | undefined;
  busy:        boolean;
  onTerminate: (runId: string) => void;
  onApprove:   (runId: string, comment?: string) => void;
  onReject:    (runId: string, comment?: string) => void;
  onResume:    (runId: string) => void;
  onRestart:   (runId: string) => void;
  onClose:     () => void;
}

// ── Status classification helpers ─────────────────────────────────────────────

const ACTIVE_STATUSES:   ReadonlySet<WorkflowRunStatus> = new Set(["running", "waiting", "paused"]);
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["complete", "errored", "terminated"]);

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="wf-copy-btn"
      aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      title={`Copy ${label ?? "value"}`}
    >
      {copied ? "Copied!" : `Copy ${label ?? ""}`}
    </button>
  );
}

// ── Overview timing grid ──────────────────────────────────────────────────────

function RunOverviewGrid({ run }: { run: WorkflowRun }) {
  const isActive = ACTIVE_STATUSES.has(run.status);

  return (
    <div className="wf-run-overview">
      <div className="wf-run-overview-item">
        <span className="wf-run-overview-key">Started</span>
        <span className="wf-run-overview-val" title={run.startedAt}>
          {fmtRelative(run.startedAt)}
        </span>
        <span className="wf-run-overview-sub">{fmtAbsolute(run.startedAt)}</span>
      </div>

      <div className="wf-run-overview-item">
        <span className="wf-run-overview-key">Duration</span>
        <span className="wf-run-overview-val">
          {isActive
            ? <span className="wf-elapsed">{fmtElapsed(run.startedAt)}</span>
            : fmtCompletedDuration(run.startedAt, run.completedAt)}
        </span>
      </div>

      <div className="wf-run-overview-item">
        <span className="wf-run-overview-key">Last updated</span>
        <span className="wf-run-overview-val">{fmtRelative(run.updatedAt)}</span>
        <span className="wf-run-overview-sub">{fmtAbsolute(run.updatedAt)}</span>
      </div>

      <div className="wf-run-overview-item">
        <span className="wf-run-overview-key">Completed</span>
        <span className="wf-run-overview-val">
          {run.completedAt ? fmtRelative(run.completedAt) : "—"}
        </span>
        {run.completedAt && (
          <span className="wf-run-overview-sub">{fmtAbsolute(run.completedAt)}</span>
        )}
      </div>
    </div>
  );
}

// ── Approval callout (waiting for reviewer) ───────────────────────────────────

function ApprovalCallout({
  runId, busy, onApprove, onReject,
}: {
  runId:     string;
  busy:      boolean;
  onApprove: (id: string, comment?: string) => void;
  onReject:  (id: string, comment?: string) => void;
}) {
  const [comment, setComment] = useState("");

  return (
    <section className="wf-approval-callout" aria-label="Approval required">
      <div className="wf-approval-callout-header">
        <svg
          width="15" height="15"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z" />
        </svg>
        <span>Awaiting your approval</span>
      </div>

      <p className="wf-approval-callout-desc">
        This run is paused and requires a reviewer decision before it can
        continue executing.
      </p>

      <div className="wf-approval-comment-section">
        <label className="tasks-field-label" htmlFor={`wf-approval-comment-${runId}`}>
          Comment
          <span className="tasks-field-optional"> (optional)</span>
        </label>
        <textarea
          id={`wf-approval-comment-${runId}`}
          className="tasks-textarea wf-approval-comment-textarea"
          placeholder="Add a note for the audit record…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={busy}
          rows={3}
        />
      </div>

      <div className="wf-approval-callout-actions">
        <button
          type="button"
          className="btn-header-secondary btn-tint-approve"
          onClick={() => onApprove(runId, comment.trim() || undefined)}
          disabled={busy}
          style={{ fontSize: 13, padding: "5px 16px" }}
        >
          {busy ? "…" : "Approve run"}
        </button>
        <button
          type="button"
          className="btn-header-secondary tasks-action-delete"
          onClick={() => onReject(runId, comment.trim() || undefined)}
          disabled={busy}
          style={{ fontSize: 13, padding: "5px 16px" }}
        >
          {busy ? "…" : "Reject run"}
        </button>
      </div>
    </section>
  );
}

// ── Approval audit record (past decision) ────────────────────────────────────

function ApprovalAudit({ run }: { run: WorkflowRun }) {
  if (!run.approvalAction) return null;

  const approved = run.approvalAction === "approved";
  const label    = approved ? "✓ Approved" : "✕ Rejected";

  return (
    <aside
      className={`wf-approval-audit wf-approval-audit--${approved ? "approved" : "rejected"}`}
      aria-label={`Approval decision: ${label}`}
    >
      <span className="wf-approval-audit-label">{label}</span>
      {run.approvedBy && (
        <span className="wf-approval-audit-by">by {run.approvedBy}</span>
      )}
      {run.approvalActionAt && (
        <span
          className="wf-approval-audit-time"
          title={fmtAbsolute(run.approvalActionAt)}
        >
          {fmtRelative(run.approvalActionAt)}
        </span>
      )}
      {run.approvalComment && (
        <blockquote className="wf-approval-audit-comment">
          {run.approvalComment}
        </blockquote>
      )}
    </aside>
  );
}

// ── Result summary ────────────────────────────────────────────────────────────

function ResultSummary({ summary }: { summary: string }) {
  return (
    <div className="wf-result-callout">
      <svg
        width="13" height="13"
        viewBox="0 0 256 256"
        fill="currentColor"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        <path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z" />
      </svg>
      <span>{summary}</span>
    </div>
  );
}

// ── Error section ─────────────────────────────────────────────────────────────

function ErrorSection({ run }: { run: WorkflowRun }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!run.errorMessage && !run.errorCode && !run.errorDetails) return null;

  return (
    <section className="wf-drawer-section" aria-label="Run error">
      <p className="wf-drawer-section-title wf-error-section-title">
        <svg
          width="13" height="13"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z" />
        </svg>
        Error
        {run.errorCode && (
          <code className="wf-error-code">{run.errorCode}</code>
        )}
      </p>

      {run.errorMessage && (
        <pre className="wf-error-block">{run.errorMessage}</pre>
      )}

      {run.errorDetails && (
        <>
          <button
            type="button"
            className="wf-payload-toggle wf-error-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            <span className={`wf-payload-caret${detailsOpen ? " is-open" : ""}`} aria-hidden="true">▶</span>
            Error details
          </button>
          {detailsOpen && (
            <pre className="wf-json-block">{JSON.stringify(run.errorDetails, null, 2)}</pre>
          )}
        </>
      )}
    </section>
  );
}

// ── Collapsible payload block ─────────────────────────────────────────────────

function PayloadBlock({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const hasData = !!value && Object.keys(value).length > 0;

  return (
    <>
      <button
        type="button"
        className="wf-payload-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={!hasData}
      >
        <span className={`wf-payload-caret${open ? " is-open" : ""}`} aria-hidden="true">▶</span>
        {label}
        {!hasData && (
          <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.5 }}>— empty</span>
        )}
      </button>
      {open && hasData && (
        <pre className="wf-json-block">{JSON.stringify(value, null, 2)}</pre>
      )}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function WorkflowRunDrawer({
  run, busy,
  onTerminate, onApprove, onReject, onResume, onRestart,
  onClose,
}: WorkflowRunDrawerProps) {
  if (!run) return null;

  const isActive    = ACTIVE_STATUSES.has(run.status);
  const isTerminal  = TERMINAL_STATUSES.has(run.status);
  const canApprove  = !!run.waitingForApproval;
  const canResume   = run.status === "paused";
  const hasProgress = run.progressPercent != null || !!run.currentStep;

  return (
    <aside className="tasks-drawer" aria-label="Run inspector">

      {/* ── Sticky header ── */}
      <div className="tasks-drawer-header wf-run-drawer-header">
        <div className="wf-run-drawer-header-body">
          <h3 className="wf-run-drawer-title" title={run.workflowName}>
            {run.workflowName}
          </h3>
          <div className="wf-run-drawer-subtitle">
            <WorkflowRunStatusBadge
              status={run.status}
              waitingForApproval={run.waitingForApproval}
              size="sm"
            />
            <span className="wf-run-drawer-id">{run.id}</span>
            <CopyButton value={run.id} label="ID" />
          </div>
        </div>
        <button
          type="button"
          className="tasks-drawer-close"
          onClick={onClose}
          aria-label="Close run inspector"
        >
          ✕
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div className="tasks-drawer-body">

        {hasProgress && (
          <div style={{ marginBottom: 12 }}>
            <WorkflowProgressBar
              percent={run.progressPercent}
              status={run.status}
              currentStep={run.currentStep}
            />
          </div>
        )}

        <RunOverviewGrid run={run} />

        {run.resultSummary && <ResultSummary summary={run.resultSummary} />}

        <ErrorSection run={run} />

        {canApprove && (
          <ApprovalCallout
            runId={run.id}
            busy={busy}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}

        <ApprovalAudit run={run} />

        {run.steps && run.steps.length > 0 && (
          <WorkflowTimeline steps={run.steps} />
        )}

        <div className="wf-drawer-section">
          <p className="wf-drawer-section-title">Payload</p>
          <PayloadBlock label="Input"  value={run.input}  />
          <PayloadBlock label="Output" value={run.output} />
        </div>

      </div>

      {/* ── Sticky footer ── */}
      <div className="tasks-drawer-footer">

        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>

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

        {isActive && (
          <button
            type="button"
            className="btn-header-secondary tasks-action-delete"
            onClick={() => onTerminate(run.id)}
            disabled={busy}
            style={{ marginLeft: "auto", fontSize: 12 }}
          >
            Terminate
          </button>
        )}

      </div>

    </aside>
  );
}
