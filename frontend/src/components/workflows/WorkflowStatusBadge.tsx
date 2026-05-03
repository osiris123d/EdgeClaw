import type { WorkflowRunStatus } from "../../types/workflows";
import { RUN_STATUS_LABELS } from "../../types/workflows";

interface WorkflowStatusBadgeProps {
  status: WorkflowRunStatus;
}

export function WorkflowStatusBadge({ status }: WorkflowStatusBadgeProps) {
  return (
    <span
      className={`wf-status-badge wf-status-badge-${status}`}
      aria-label={`Status: ${RUN_STATUS_LABELS[status]}`}
    >
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}
