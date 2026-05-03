import type { ScheduledTask } from "../../types/tasks";

interface TaskStatsBarProps {
  tasks: ScheduledTask[];
  loading: boolean;
}

const DUE_SOON_MS = 24 * 60 * 60 * 1000;

interface StatItem {
  label: string;
  value: number;
  mod?: "danger" | "info" | "success";
}

export function TaskStatsBar({ tasks, loading }: TaskStatsBarProps) {
  const total   = tasks.length;
  const active  = tasks.filter((t) => t.status === "active").length;
  const paused  = tasks.filter((t) => t.status === "paused").length;
  const errored = tasks.filter((t) => t.status === "error").length;
  const dueSoon = tasks.filter((t) => {
    if (!t.nextRunAt || !t.enabled) return false;
    const ms = new Date(t.nextRunAt).getTime() - Date.now();
    return ms > 0 && ms <= DUE_SOON_MS;
  }).length;

  const stats: StatItem[] = [
    { label: "Total",    value: total },
    { label: "Active",   value: active,  mod: active > 0 ? "success" : undefined },
    { label: "Paused",   value: paused },
    ...(errored > 0 ? [{ label: "Error", value: errored, mod: "danger" as const }] : []),
    { label: "Due soon", value: dueSoon, mod: dueSoon > 0 ? "info" : undefined },
  ];

  return (
    <div className="tasks-stats-bar" aria-label="Task overview">
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
