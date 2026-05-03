import type { WorkflowRun, WorkflowRunStatus } from "../../types/workflows";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";

interface RunRowProps {
  run:       WorkflowRun;
  isSelected: boolean;
  busy:      boolean;
  onInspect: (run: WorkflowRun) => void;
  onAbort:   (runId: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
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
    return ms < 0 ? "—" : fmtMs(ms);
  } catch {
    return "—";
  }
}

// ── Run state dot ─────────────────────────────────────────────────────────────
//
// Pulsing for active (running/waiting); solid for terminal states.

function RunDot({ status }: { status: WorkflowRunStatus }) {
  return (
    <span
      className={`wf-run-dot wf-run-dot-${status}`}
      aria-hidden="true"
    />
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RunRow({ run, isSelected, busy, onInspect, onAbort }: RunRowProps) {
  const isActive = run.status === "running" || run.status === "waiting";

  return (
    <tr
      className={[
        "tasks-row",
        isSelected ? "is-selected" : "",
      ].filter(Boolean).join(" ")}
    >
      {/* Definition name + truncated run ID */}
      <td className="tasks-td tasks-td-title">
        <button
          type="button"
          className="tasks-row-title-btn"
          onClick={() => onInspect(run)}
        >
          <span className="tasks-row-title">
            <RunDot status={run.status} />
            {run.workflowName}
          </span>
          <span className="wf-run-id">{run.id}</span>
        </button>
      </td>

      {/* Status badge */}
      <td className="tasks-td tasks-td-status">
        <WorkflowStatusBadge status={run.status} />
      </td>

      {/* Started */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        {fmtDate(run.startedAt)}
      </td>

      {/* Completed — shows "—" while running */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        {fmtDate(run.completedAt)}
      </td>

      {/* Duration — shows elapsed for active runs */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        {isActive ? (
          <span className="wf-elapsed">{fmtElapsed(run.startedAt)}</span>
        ) : (
          fmtDuration(run.startedAt, run.completedAt)
        )}
      </td>

      {/* Actions */}
      <td className="tasks-td tasks-td-actions">
        <button
          type="button"
          className="btn-header-secondary"
          onClick={() => onInspect(run)}
        >
          Inspect
        </button>
        {isActive && (
          <button
            type="button"
            className="btn-header-secondary tasks-action-delete"
            onClick={() => onAbort(run.id)}
            disabled={busy}
          >
            Abort
          </button>
        )}
      </td>
    </tr>
  );
}
