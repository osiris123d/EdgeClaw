import type { ScheduledTask } from "../../types/tasks";
import { TASK_TYPE_LABELS, SCHEDULE_TYPE_LABELS } from "../../types/tasks";
import { TaskStatusBadge } from "./TaskStatusBadge";

// ── Props ─────────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task:       ScheduledTask;
  isSelected: boolean;
  busy:       boolean;
  onEdit:     (task: ScheduledTask) => void;
  onDelete:   (id: string) => void;
  onToggle:   (id: string, enabled: boolean) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DUE_SOON_MS = 24 * 60 * 60 * 1000;

function isDueSoon(nextRunAt?: string | null): boolean {
  if (!nextRunAt) return false;
  const ms = new Date(nextRunAt).getTime() - Date.now();
  return ms > 0 && ms <= DUE_SOON_MS;
}

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

function scheduleLabel(task: ScheduledTask): string {
  const typeLabel = SCHEDULE_TYPE_LABELS[task.scheduleType];
  return `${typeLabel} · ${task.scheduleExpression}`;
}

// ── Run status dot ────────────────────────────────────────────────────────────

interface RunDotProps {
  status?: "success" | "failed" | null;
  hasRun:  boolean;
  error?:  string | null;
}

function RunDot({ status, hasRun, error }: RunDotProps) {
  if (status === "success") {
    return (
      <span
        className="task-run-dot is-success"
        title="Last run succeeded"
        aria-label="Last run succeeded"
      />
    );
  }
  if (status === "failed") {
    const tip = error ? `Last run failed: ${error}` : "Last run failed";
    return (
      <span
        className="task-run-dot is-failed"
        title={tip}
        aria-label="Last run failed"
      />
    );
  }
  if (!hasRun) {
    return (
      <span
        className="task-run-dot is-never"
        title="Never run"
        aria-label="Never run"
      />
    );
  }
  // lastRunStatus is null but task has run (e.g. pre-migration records).
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskRow({ task, isSelected, busy, onEdit, onDelete, onToggle }: TaskRowProps) {
  const dueSoon = isDueSoon(task.nextRunAt) && task.enabled;

  return (
    <tr
      className={[
        "tasks-row",
        isSelected    ? "is-selected" : "",
        !task.enabled ? "is-disabled"  : "",
      ].filter(Boolean).join(" ")}
    >
      {/* ── Title + description ── */}
      <td className="tasks-td tasks-td-title">
        <button
          type="button"
          className="tasks-row-title-btn"
          onClick={() => onEdit(task)}
        >
          <span className="tasks-row-title">{task.title}</span>
          {task.description && (
            <span className="tasks-row-desc">{task.description}</span>
          )}
        </button>
      </td>

      {/* ── Task type badge ── */}
      <td className="tasks-td tasks-td-type">
        <span className="task-type-badge">{TASK_TYPE_LABELS[task.taskType]}</span>
      </td>

      {/* ── Schedule ── */}
      <td className="tasks-td tasks-td-schedule">
        <span className="tasks-row-schedule">{scheduleLabel(task)}</span>
        {task.timezone && (
          <span className="tasks-row-tz">{task.timezone}</span>
        )}
      </td>

      {/* ── Status badge ── */}
      <td className="tasks-td tasks-td-status">
        <TaskStatusBadge status={task.status} />
      </td>

      {/* ── Next run ── */}
      <td className={`tasks-td tasks-td-date tasks-td-collapsible${dueSoon ? " is-due-soon" : ""}`}>
        <span className="tasks-td-date-row">
          <span className="tasks-td-date-val">
            {task.nextRunAt
              ? fmtDate(task.nextRunAt)
              : task.enabled && task.scheduleType === "cron"
                ? <span className="tasks-td-at-runtime">At runtime</span>
                : "—"}
          </span>
          {dueSoon && (
            <span className="task-due-soon-badge" aria-label="Due within 24 hours">
              Due soon
            </span>
          )}
        </span>
      </td>

      {/* ── Last run ── */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        <span className="tasks-td-date-row">
          <RunDot
            status={task.lastRunStatus}
            hasRun={!!task.lastRunAt}
            error={task.lastRunError}
          />
          <span className="tasks-td-date-val">{fmtDate(task.lastRunAt)}</span>
        </span>
      </td>

      {/* ── Enable / pause toggle ── */}
      <td className="tasks-td tasks-td-toggle">
        <button
          type="button"
          className={`task-toggle-btn${task.enabled ? " is-enabled" : ""}`}
          onClick={() => onToggle(task.id, !task.enabled)}
          disabled={busy}
          aria-pressed={task.enabled}
          title={task.enabled ? "Click to pause" : "Click to activate"}
        >
          <span className="task-toggle-dot" aria-hidden="true" />
          <span className="tasks-toggle-label">{task.enabled ? "Enabled" : "Paused"}</span>
        </button>
      </td>

      {/* ── Row actions ── */}
      <td className="tasks-td tasks-td-actions">
        <button
          type="button"
          className="btn-header-secondary"
          onClick={() => onEdit(task)}
          disabled={busy}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn-header-secondary tasks-action-delete"
          onClick={() => onDelete(task.id)}
          disabled={busy}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}
