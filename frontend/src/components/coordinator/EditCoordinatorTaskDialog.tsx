import { useCallback, useEffect, useState } from "react";
import { patchCoordinatorTask } from "../../lib/coordinatorControlPlaneApi";
import type {
  CoordinatorTask,
  CoordinatorTaskRole,
  CoordinatorTaskStatus,
} from "../../types/coordinatorControlPlane";

export interface EditCoordinatorTaskDialogProps {
  open: boolean;
  task: CoordinatorTask | null;
  storageAvailable: boolean;
  onClose: () => void;
  onSaved: () => void;
  flash: (message: string, kind?: "success" | "error") => void;
}

const ROLES: CoordinatorTaskRole[] = ["coordinator", "coder", "tester"];
const STATUSES: CoordinatorTaskStatus[] = ["todo", "in_progress", "blocked", "review", "done"];

export function EditCoordinatorTaskDialog({
  open,
  task,
  storageAvailable,
  onClose,
  onSaved,
  flash,
}: EditCoordinatorTaskDialogProps) {
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [assignedRole, setAssignedRole] = useState<CoordinatorTaskRole>("coordinator");
  const [status, setStatus] = useState<CoordinatorTaskStatus>("todo");

  useEffect(() => {
    if (!open || !task) return;
    setTitle(task.title);
    setDescription(task.description);
    setAcceptanceCriteria(task.acceptanceCriteria);
    setAssignedRole(task.assignedRole);
    setStatus(task.status);
  }, [open, task]);

  const save = useCallback(async () => {
    if (!task || !storageAvailable) return;
    const t = title.trim();
    if (!t) {
      flash("Title is required.", "error");
      return;
    }
    setBusy(true);
    try {
      await patchCoordinatorTask(task.taskId, {
        title: t,
        description: description.trim(),
        acceptanceCriteria: acceptanceCriteria.trim(),
        assignedRole,
        status,
      });
      flash("Task updated.");
      onSaved();
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setBusy(false);
    }
  }, [
    task,
    storageAvailable,
    title,
    description,
    acceptanceCriteria,
    assignedRole,
    status,
    flash,
    onSaved,
    onClose,
  ]);

  if (!open || !task) return null;

  return (
    <div className="coord-blueprint-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="coord-blueprint-dialog coord-task-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coord-task-edit-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="coord-blueprint-head">
          <h3 id="coord-task-edit-title">Edit task</h3>
          <button type="button" className="btn-text" onClick={onClose} aria-label="Close" disabled={busy}>
            ✕
          </button>
        </div>

        {!storageAvailable ? (
          <p className="muted">Control-plane KV is not bound.</p>
        ) : (
          <>
            <p className="muted coord-task-edit-id">
              <code>{task.taskId}</code>
            </p>
            <div className="coord-blueprint-meta">
              <label className="coord-field coord-field-wide">
                <span>Title</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
              </label>
              <label className="coord-field coord-field-wide">
                <span>Description</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} rows={4} />
              </label>
              <label className="coord-field coord-field-wide">
                <span>Acceptance criteria</span>
                <textarea
                  value={acceptanceCriteria}
                  onChange={(e) => setAcceptanceCriteria(e.target.value)}
                  disabled={busy}
                  rows={3}
                />
              </label>
              <label className="coord-field">
                <span>Assigned role</span>
                <select value={assignedRole} onChange={(e) => setAssignedRole(e.target.value as CoordinatorTaskRole)} disabled={busy}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="coord-field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value as CoordinatorTaskStatus)} disabled={busy}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="coord-task-edit-actions">
              <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn-header-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
