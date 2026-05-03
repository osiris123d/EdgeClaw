import type { WorkflowDefinition, WorkflowRun } from "../../types/workflows";

interface WorkflowStatsBarProps {
  definitions: WorkflowDefinition[];
  runs: WorkflowRun[];
  loadingDefs: boolean;
  loadingRuns: boolean;
}

interface StatItem {
  label: string;
  value: number;
  mod?: "danger" | "info" | "success";
}

export function WorkflowStatsBar({
  definitions,
  runs,
  loadingDefs,
  loadingRuns,
}: WorkflowStatsBarProps) {
  const totalDefs    = definitions.length;
  const enabledDefs  = definitions.filter((d) => d.enabled).length;
  const activeRuns   = runs.filter((r) => r.status === "running" || r.status === "waiting").length;
  const completedRuns = runs.filter((r) => r.status === "complete").length;
  const erroredRuns  = runs.filter((r) => r.status === "errored").length;

  const loading = loadingDefs || loadingRuns;

  const stats: StatItem[] = [
    { label: "Definitions", value: totalDefs },
    { label: "Enabled",     value: enabledDefs,     mod: enabledDefs > 0  ? "success" : undefined },
    { label: "Active runs", value: activeRuns,       mod: activeRuns > 0   ? "info"    : undefined },
    { label: "Completed",   value: completedRuns },
    ...(erroredRuns > 0
      ? [{ label: "Errored", value: erroredRuns, mod: "danger" as const }]
      : []),
  ];

  return (
    <div className="tasks-stats-bar" aria-label="Workflow overview">
      {stats.map((s) => (
        <div
          key={s.label}
          className={`tasks-stat-card${s.mod ? ` is-${s.mod}` : ""}`}
        >
          <span className={`tasks-stat-value${loading ? " is-skeleton" : ""}`}>
            {loading ? "—" : s.value}
          </span>
          <span className="tasks-stat-label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
