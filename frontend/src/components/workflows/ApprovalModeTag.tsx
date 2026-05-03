import type { WorkflowApprovalMode } from "../../types/workflows";
import { APPROVAL_MODE_OPTIONS } from "../../types/workflows";

const META: Record<WorkflowApprovalMode, { label: string; cls: string }> = {
  none:       { label: "No approval", cls: "wf-approval-none"       },
  required:   { label: "Required",    cls: "wf-approval-required"   },
  checkpoint: { label: "Checkpoint",  cls: "wf-approval-checkpoint" },
};

interface ApprovalModeTagProps {
  mode: WorkflowApprovalMode;
}

export function ApprovalModeTag({ mode }: ApprovalModeTagProps) {
  const { label, cls } = META[mode] ?? META.none;
  const hint = APPROVAL_MODE_OPTIONS.find((o) => o.value === mode)?.hint;
  return (
    <span className={`wf-approval-tag ${cls}`} title={hint}>
      {label}
    </span>
  );
}
