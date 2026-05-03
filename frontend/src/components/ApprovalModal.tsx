import type { ToolApprovalRequest } from "../types";

interface ApprovalModalProps {
  request: ToolApprovalRequest | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalModal({ request, onApprove, onDeny }: ApprovalModalProps) {
  if (!request) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Tool approval request">
      <div className="modal-card">
        <h3>Tool Approval Required</h3>
        <p>
          The assistant wants to run <strong>{request.toolName}</strong>.
        </p>
        {request.reason && <p className="muted">Reason: {request.reason}</p>}
        {request.args && (
          <pre className="modal-json">{JSON.stringify(request.args, null, 2)}</pre>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onDeny}>
            Deny
          </button>
          <button type="button" className="btn-primary" onClick={onApprove}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
