import type { TaskStatus, ScheduleType } from "../../types/tasks";
import { TASK_STATUS_LABELS, SCHEDULE_TYPE_LABELS } from "../../types/tasks";

// ── Types exported for use in TasksPage ──────────────────────────────────────

export type SortKey = "createdAt" | "title" | "nextRunAt" | "lastRunAt" | "status";

export interface ToolbarState {
  search:         string;
  statusFilter:   "all" | TaskStatus;
  scheduleFilter: "all" | ScheduleType;
  sort:           SortKey;
}

interface TaskToolbarProps extends ToolbarState {
  totalVisible: number;
  totalAll:     number;
  onChange: <K extends keyof ToolbarState>(key: K, value: ToolbarState[K]) => void;
}

// ── Option lists ──────────────────────────────────────────────────────────────

const STATUS_OPTS: ReadonlyArray<{ value: "all" | TaskStatus; label: string }> = [
  { value: "all",    label: "All statuses" },
  { value: "active", label: TASK_STATUS_LABELS.active },
  { value: "paused", label: TASK_STATUS_LABELS.paused },
  { value: "draft",  label: TASK_STATUS_LABELS.draft },
  { value: "error",  label: TASK_STATUS_LABELS.error },
];

const SCHEDULE_OPTS: ReadonlyArray<{ value: "all" | ScheduleType; label: string }> = [
  { value: "all",      label: "All schedules" },
  { value: "once",     label: SCHEDULE_TYPE_LABELS.once },
  { value: "interval", label: SCHEDULE_TYPE_LABELS.interval },
  { value: "cron",     label: SCHEDULE_TYPE_LABELS.cron },
];

const SORT_OPTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "createdAt", label: "Newest first" },
  { value: "nextRunAt", label: "Next run" },
  { value: "lastRunAt", label: "Last run" },
  { value: "title",     label: "Title A–Z" },
  { value: "status",    label: "Status" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskToolbar({
  search, statusFilter, scheduleFilter, sort,
  totalVisible, totalAll,
  onChange,
}: TaskToolbarProps) {
  const hasFilters = search !== "" || statusFilter !== "all" || scheduleFilter !== "all";
  const isFiltered = totalVisible !== totalAll;

  return (
    <div className="tasks-toolbar">

      {/* Search */}
      <div className="tasks-toolbar-search-wrap">
        <svg
          className="tasks-toolbar-search-icon"
          width="13" height="13"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M229.66,218.34l-50.07-50.06a88.21,88.21,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" />
        </svg>
        <input
          type="search"
          className="tasks-toolbar-search"
          value={search}
          onChange={(e) => onChange("search", e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search tasks"
        />
      </div>

      {/* Status filter */}
      <select
        className="memory-filter-select"
        value={statusFilter}
        onChange={(e) => onChange("statusFilter", e.target.value as ToolbarState["statusFilter"])}
        aria-label="Filter by status"
      >
        {STATUS_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Schedule filter */}
      <select
        className="memory-filter-select"
        value={scheduleFilter}
        onChange={(e) => onChange("scheduleFilter", e.target.value as ToolbarState["scheduleFilter"])}
        aria-label="Filter by schedule type"
      >
        {SCHEDULE_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Sort */}
      <select
        className="memory-filter-select"
        value={sort}
        onChange={(e) => onChange("sort", e.target.value as SortKey)}
        aria-label="Sort tasks"
      >
        {SORT_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Results + clear */}
      <div className="tasks-toolbar-meta">
        {isFiltered && (
          <span className="tasks-toolbar-count muted">
            {totalVisible} of {totalAll}
          </span>
        )}
        {hasFilters && (
          <button
            type="button"
            className="tasks-toolbar-clear"
            onClick={() => {
              onChange("search",         "");
              onChange("statusFilter",   "all");
              onChange("scheduleFilter", "all");
            }}
          >
            Clear
          </button>
        )}
      </div>

    </div>
  );
}
