import type { ToolApprovalRequest } from "../../types";

interface ApprovalInlineCardProps {
  request: ToolApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalInlineCard({ request, onApprove, onDeny }: ApprovalInlineCardProps) {
  return (
    <section className="approval-inline-card" role="group" aria-label="Tool approval required">
      <div className="approval-inline-head">
        <strong>Approval required</strong>
        <span className="approval-inline-tool">{request.toolName}</span>
      </div>
      <p className="approval-inline-reason">{request.reason ?? "This tool call needs your approval."}</p>
      {request.args && (
        <pre className="approval-inline-args">{JSON.stringify(request.args, null, 2)}</pre>
      )}
      <div className="approval-inline-actions">
        <button type="button" className="btn-secondary" onClick={onDeny}>
          Deny
        </button>
        <button type="button" className="btn-primary" onClick={onApprove}>
          Approve and continue
        </button>
      </div>
    </section>
  );
}
