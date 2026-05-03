import type { AssistantTurnStatus } from "../../types";

interface TurnStatusHeaderProps {
  status: AssistantTurnStatus;
  isStreaming?: boolean;
  isApprovalPending?: boolean;
  turnId: string;
}

function getStatusLabel(status: AssistantTurnStatus): string {
  switch (status) {
    case "thinking":
      return "Thinking";
    case "using_tools":
      return "Running tools";
    case "finalizing":
      return "Finalizing answer";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "awaiting_approval":
      return "Needs approval";
    default:
      return "Working";
  }
}

export function TurnStatusHeader({ status, isStreaming, isApprovalPending, turnId }: TurnStatusHeaderProps) {
  const active = status !== "done" && status !== "failed";
  const label = isApprovalPending ? "Needs approval" : getStatusLabel(status);
  const statusId = `turn-status-${turnId}`;

  return (
    <header className="turn-status-header" role="status" aria-live="polite" aria-atomic="true" id={statusId}>
      <div className="turn-status-left">
        <span className={`turn-status-icon status-${status}`} aria-hidden="true" />
        <span className={`turn-status-dot status-${status}${active ? " is-active" : ""}`} aria-hidden="true" />
        <strong className="turn-status-actor">Assistant</strong>
        <span className="turn-status-divider" aria-hidden="true">
          ·
        </span>
        <span className={`turn-status-label status-${status}`}>{label}</span>
        <span className="sr-only">Assistant status: {label}</span>
      </div>
      {isStreaming && <span className="turn-status-streaming">Live</span>}
    </header>
  );
}
