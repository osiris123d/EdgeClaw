interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 id="confirm-dialog-title" style={{ margin: "0 0 8px", fontSize: 16 }}>
          {title}
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {message}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn-primary"
            style={danger ? { background: "var(--danger)", borderColor: "#6e2020" } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
