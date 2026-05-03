import type { WorkflowRun, WorkflowRunStatus } from "../../types/workflows";
import { WorkflowRunStatusBadge } from "./WorkflowRunStatusBadge";
import { WorkflowProgressBar }   from "./WorkflowProgressBar";
import { fmtRelative, fmtRunDuration } from "../../lib/workflowFormatters";

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowRunRowProps {
  run:        WorkflowRun;
  isSelected: boolean;
  busy:       boolean;
  onView:       (run: WorkflowRun) => void;
  onApprove:    (runId: string) => void;
  onReject:     (runId: string) => void;
  onResume:     (runId: string) => void;
  onRestart:    (runId: string) => void;
  onTerminate:  (runId: string) => void;
}

// ── Action state derivation ───────────────────────────────────────────────────

const ACTIVE_STATUSES: ReadonlySet<WorkflowRunStatus>   = new Set(["running", "waiting", "paused"]);
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["complete", "errored", "terminated"]);

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkflowRunRow({
  run, isSelected, busy,
  onView, onApprove, onReject, onResume, onRestart, onTerminate,
}: WorkflowRunRowProps) {
  const isActive   = ACTIVE_STATUSES.has(run.status);
  const isTerminal = TERMINAL_STATUSES.has(run.status);
  const canApprove = !!run.waitingForApproval;
  const canResume  = run.status === "paused";

  return (
    <tr
      className={[
        "tasks-row",
        isSelected ? "is-selected" : "",
      ].filter(Boolean).join(" ")}
    >

      {/* ── Workflow name + truncated run ID + error hint ── */}
      <td className="tasks-td tasks-td-title">
        <button
          type="button"
          className="tasks-row-title-btn"
          onClick={() => onView(run)}
        >
          <span className="tasks-row-title">{run.workflowName}</span>
          <span className="wf-run-id">{run.id}</span>
        </button>
        {run.status === "errored" && run.errorMessage && (
          <span
            className="wf-run-error-hint"
            title={run.errorMessage}
            role="note"
          >
            <span className="wf-run-error-icon" aria-hidden="true">✕</span>
            <span className="wf-run-error-text">{run.errorMessage}</span>
          </span>
        )}
      </td>

      {/* ── Status badge (with approval dot) ── */}
      <td className="tasks-td tasks-td-status">
        <WorkflowRunStatusBadge
          status={run.status}
          waitingForApproval={run.waitingForApproval}
        />
      </td>

      {/* ── Progress bar + current step ── */}
      <td className="tasks-td tasks-td-progress tasks-td-collapsible">
        <WorkflowProgressBar
          percent={run.progressPercent}
          status={run.status}
          currentStep={run.currentStep}
        />
      </td>

      {/* ── Started ── */}
      <td
        className="tasks-td tasks-td-date tasks-td-collapsible"
        title={run.startedAt ? new Date(run.startedAt).toLocaleString() : undefined}
      >
        {fmtRelative(run.startedAt)}
      </td>

      {/* ── Duration (elapsed for active, final for terminal) ── */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        <span
          className={isActive ? "wf-elapsed" : undefined}
          title={isActive ? "Elapsed since start" : undefined}
        >
          {fmtRunDuration(run.startedAt, run.completedAt, run.status)}
        </span>
      </td>

      {/* ── Updated ── */}
      <td
        className="tasks-td tasks-td-date tasks-td-collapsible"
        title={run.updatedAt ? new Date(run.updatedAt).toLocaleString() : undefined}
      >
        {fmtRelative(run.updatedAt)}
      </td>

      {/* ── Context-sensitive actions ── */}
      <td className="tasks-td tasks-td-actions">
        {/* View — always available */}
        <button
          type="button"
          className="btn-header-secondary"
          onClick={() => onView(run)}
          disabled={busy}
        >
          View
        </button>

        {/* Approve / Reject — only when waiting for human approval */}
        {canApprove && (
          <>
            <button
              type="button"
              className="btn-header-secondary btn-tint-approve"
              onClick={() => onApprove(run.id)}
              disabled={busy}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-header-secondary tasks-action-delete"
              onClick={() => onReject(run.id)}
              disabled={busy}
            >
              Reject
            </button>
          </>
        )}

        {/* Resume — only for paused runs */}
        {canResume && (
          <button
            type="button"
            className="btn-header-secondary"
            onClick={() => onResume(run.id)}
            disabled={busy}
          >
            Resume
          </button>
        )}

        {/* Restart — only for terminal runs */}
        {isTerminal && (
          <button
            type="button"
            className="btn-header-secondary"
            onClick={() => onRestart(run.id)}
            disabled={busy}
          >
            Restart
          </button>
        )}

        {/* Terminate — only for active runs */}
        {isActive && (
          <button
            type="button"
            className="btn-header-secondary tasks-action-delete"
            onClick={() => onTerminate(run.id)}
            disabled={busy}
          >
            Terminate
          </button>
        )}
      </td>

    </tr>
  );
}
