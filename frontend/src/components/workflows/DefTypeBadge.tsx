import type { WorkflowDefinition } from "../../types/workflows";
import { WORKFLOW_TYPE_OPTIONS } from "../../types/workflows";

// Per-type color tokens.  Keys match WORKFLOW_TYPE_OPTIONS values.
const TYPE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  "ai-agent":      { bg: "#f3e8fc", color: "#7a28a8", border: "#d8b0f0" },
  "data-pipeline": { bg: "#e4eefb", color: "#1450a0", border: "#aac8f0" },
  "report":        { bg: "#ede8fb", color: "#5030b0", border: "#c0aef0" },
  "approval":      { bg: "#fef3db", color: "#8a5a00", border: "#f0d898" },
  "notification":  { bg: "#e4f7f0", color: "#186048", border: "#9ad8c0" },
  "maintenance":   { bg: "#f0f0ee", color: "#606060", border: "#d0d0cc" },
  "custom":        { bg: "var(--surface-2)", color: "var(--muted)", border: "var(--border-soft)" },
};

const FALLBACK = TYPE_COLORS["custom"];

interface DefTypeBadgeProps {
  /** Value matching one of the WORKFLOW_TYPE_OPTIONS entries, e.g. "report". */
  type: WorkflowDefinition["workflowType"];
}

export function DefTypeBadge({ type }: DefTypeBadgeProps) {
  if (!type) return null;

  const label = WORKFLOW_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
  const colors = TYPE_COLORS[type] ?? FALLBACK;

  return (
    <span
      className="wf-type-badge"
      style={{
        background:   colors.bg,
        color:        colors.color,
        borderColor:  colors.border,
      }}
    >
      {label}
    </span>
  );
}
