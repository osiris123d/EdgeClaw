import type { WorkflowRunStatus } from "../../types/workflows";
import { RUN_STATUS_LABELS } from "../../types/workflows";

interface WorkflowRunStatusBadgeProps {
  status:             WorkflowRunStatus;
  /** When true, renders a small pulsing amber dot inside the badge. */
  waitingForApproval?: boolean;
  size?:              "sm" | "md";
}

export function WorkflowRunStatusBadge({
  status,
  waitingForApproval = false,
  size = "md",
}: WorkflowRunStatusBadgeProps) {
  return (
    <span
      className={[
        "wf-status-badge",
        `wf-status-badge-${status}`,
        size === "sm" ? "wf-status-badge-sm" : "",
      ].filter(Boolean).join(" ")}
      aria-label={[
        `Status: ${RUN_STATUS_LABELS[status]}`,
        waitingForApproval ? "— waiting for approval" : "",
      ].filter(Boolean).join(" ")}
    >
      {waitingForApproval && (
        <span className="wf-approval-dot" aria-hidden="true" />
      )}
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}
