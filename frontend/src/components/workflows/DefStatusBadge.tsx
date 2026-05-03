import type { WorkflowDefinitionStatus } from "../../types/workflows";

const META: Record<WorkflowDefinitionStatus, { label: string; cls: string }> = {
  draft:    { label: "Draft",    cls: "wf-def-status-draft"    },
  active:   { label: "Active",   cls: "wf-def-status-active"   },
  archived: { label: "Archived", cls: "wf-def-status-archived" },
};

interface DefStatusBadgeProps {
  status: WorkflowDefinitionStatus;
}

export function DefStatusBadge({ status }: DefStatusBadgeProps) {
  const { label, cls } = META[status] ?? META.active;
  return (
    <span className={`wf-def-status-badge ${cls}`}>
      {label}
    </span>
  );
}
