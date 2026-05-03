import type { WorkflowTriggerMode } from "../../types/workflows";
import { TRIGGER_MODE_OPTIONS } from "../../types/workflows";

const META: Record<WorkflowTriggerMode, { cls: string }> = {
  manual:    { cls: "wf-trigger-manual"    },
  scheduled: { cls: "wf-trigger-scheduled" },
  event:     { cls: "wf-trigger-event"     },
};

interface TriggerModeTagProps {
  mode: WorkflowTriggerMode;
}

export function TriggerModeTag({ mode }: TriggerModeTagProps) {
  const { cls } = META[mode] ?? META.manual;
  const hint = TRIGGER_MODE_OPTIONS.find((o) => o.value === mode)?.hint;
  return (
    <span className={`wf-trigger-tag ${cls}`} title={hint}>
      {mode.charAt(0).toUpperCase() + mode.slice(1)}
    </span>
  );
}
