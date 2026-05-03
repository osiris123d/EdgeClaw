import type { WorkflowDefinition } from "../../types/workflows";
import { DefTypeBadge }    from "./DefTypeBadge";
import { DefStatusBadge }  from "./DefStatusBadge";
import { TriggerModeTag }  from "./TriggerModeTag";
import { ApprovalModeTag } from "./ApprovalModeTag";
import { fmtRelative }     from "../../lib/workflowFormatters";

// ── Props ─────────────────────────────────────────────────────────────────────

interface DefinitionRowProps {
  definition:  WorkflowDefinition;
  isSelected:  boolean;
  busy:        boolean;
  onEdit:      (def: WorkflowDefinition) => void;
  onDelete:    (id: string) => void;
  onLaunch:    (def: WorkflowDefinition) => void;
  onToggle:    (id: string, enabled: boolean) => void;
  onViewRuns:  (def: WorkflowDefinition) => void;
}

// ── Launch icon ───────────────────────────────────────────────────────────────

function LaunchIcon() {
  return (
    <svg
      width="10" height="10"
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M224,128a96,96,0,1,1-96-96A96.11,96.11,0,0,1,224,128Zm-96,80a80,80,0,1,0-80-80A80.09,80.09,0,0,0,128,208Zm-20-112,56,32-56,32Z"/>
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DefinitionRow({
  definition: def, isSelected, busy, onEdit, onDelete, onLaunch, onToggle, onViewRuns,
}: DefinitionRowProps) {
  const canLaunch = def.enabled && def.status === "active";
  const latestFailed =
    def.latestRunStatus === "errored" || def.latestRunStatus === "terminated";

  return (
    <tr
      className={[
        "tasks-row",
        isSelected    ? "is-selected" : "",
        !def.enabled  ? "is-disabled"  : "",
      ].filter(Boolean).join(" ")}
    >

      {/* ── Name + description + type badge ── */}
      <td className="tasks-td tasks-td-title">
        <button
          type="button"
          className="tasks-row-title-btn"
          onClick={() => onEdit(def)}
        >
          <span className="tasks-row-title">{def.name}</span>
          {def.description && (
            <span className="tasks-row-desc">{def.description}</span>
          )}
          {def.workflowType && (
            <span className="wf-def-row-type">
              <DefTypeBadge type={def.workflowType} />
            </span>
          )}
        </button>
      </td>

      {/* ── Trigger mode ── */}
      <td className="tasks-td tasks-td-type">
        <TriggerModeTag mode={def.triggerMode} />
      </td>

      {/* ── Approval mode ── */}
      <td className="tasks-td tasks-td-type tasks-td-collapsible">
        <ApprovalModeTag mode={def.approvalMode} />
      </td>

      {/* ── Definition lifecycle status ── */}
      <td className="tasks-td tasks-td-type">
        <DefStatusBadge status={def.status} />
      </td>

      {/* ── Last run ── */}
      <td className="tasks-td tasks-td-date tasks-td-collapsible">
        <span
          className={def.lastRunAt ? undefined : "muted"}
          title={def.lastRunAt ? new Date(def.lastRunAt).toLocaleString() : undefined}
        >
          {fmtRelative(def.lastRunAt)}
        </span>
        {latestFailed && (
          <span className="wf-def-failure-hint" title="Latest run failed or was terminated">
            ✕ failed
          </span>
        )}
        {def.runCount > 0 && (
          <button
            type="button"
            className="wf-run-count-btn"
            onClick={() => onViewRuns(def)}
            title="View all runs for this definition"
            disabled={busy}
          >
            {def.runCount} {def.runCount === 1 ? "run" : "runs"}
          </button>
        )}
      </td>

      {/* ── Updated ── */}
      <td
        className="tasks-td tasks-td-date tasks-td-collapsible"
        title={new Date(def.updatedAt).toLocaleString()}
      >
        {fmtRelative(def.updatedAt)}
      </td>

      {/* ── Enable / disable toggle ── */}
      <td className="tasks-td tasks-td-toggle">
        <button
          type="button"
          className={`task-toggle-btn${def.enabled ? " is-enabled" : ""}`}
          onClick={() => onToggle(def.id, !def.enabled)}
          disabled={busy}
          aria-pressed={def.enabled}
          title={def.enabled ? "Click to disable" : "Click to enable"}
        >
          <span className="task-toggle-dot" aria-hidden="true" />
          <span className="tasks-toggle-label">
            {def.enabled ? "Enabled" : "Disabled"}
          </span>
        </button>
      </td>

      {/* ── Row actions ── */}
      <td className="tasks-td tasks-td-actions">
        <button
          type="button"
          className="btn-launch"
          onClick={() => onLaunch(def)}
          disabled={busy || !canLaunch}
          title={
            !def.enabled     ? "Enable this definition to launch it"
            : def.status !== "active" ? `Definition is "${def.status}" — set to Active to launch`
            : "Launch a new run"
          }
        >
          <LaunchIcon />
          Launch
        </button>
        <button
          type="button"
          className="btn-header-secondary"
          onClick={() => onViewRuns(def)}
          disabled={busy}
          title="View runs for this definition"
        >
          Runs
        </button>
        <button
          type="button"
          className="btn-header-secondary"
          onClick={() => onEdit(def)}
          disabled={busy}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn-header-secondary tasks-action-delete"
          onClick={() => onDelete(def.id)}
          disabled={busy}
        >
          Delete
        </button>
      </td>

    </tr>
  );
}
