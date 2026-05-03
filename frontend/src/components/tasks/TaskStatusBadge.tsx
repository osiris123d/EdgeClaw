import type { TaskStatus } from "../../types/tasks";
import { TASK_STATUS_LABELS } from "../../types/tasks";

interface TaskStatusBadgeProps {
  status: TaskStatus;
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  return (
    <span className={`task-status-badge task-status-${status}`} aria-label={`Status: ${TASK_STATUS_LABELS[status]}`}>
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}
