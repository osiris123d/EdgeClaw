import type { WorkflowRunStatus } from "../../types/workflows";
import { RUN_STATUS_OPTIONS } from "../../types/workflows";

// ── Types exported for WorkflowsPage ──────────────────────────────────────────

export type RunsSortKey =
  | "startedAt"
  | "updatedAt"
  | "completedAt"
  | "status"
  | "duration";

export interface RunsToolbarState {
  search:         string;
  status:         "all" | WorkflowRunStatus;
  workflowName:   "all" | string;
  approvalFilter: "all" | "pending";
  sort:           RunsSortKey;
}

export const RUNS_TOOLBAR_DEFAULT: RunsToolbarState = {
  search:         "",
  status:         "all",
  workflowName:   "all",
  approvalFilter: "all",
  sort:           "startedAt",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface RunsToolbarProps extends RunsToolbarState {
  /** Unique workflow names derived from the loaded runs list. */
  workflowOptions: string[];
  totalVisible:    number;
  totalAll:        number;
  onChange: <K extends keyof RunsToolbarState>(key: K, value: RunsToolbarState[K]) => void;
  onClear: () => void;
  onRefresh: () => void;
}

// ── Option lists ──────────────────────────────────────────────────────────────

const SORT_OPTS: ReadonlyArray<{ value: RunsSortKey; label: string }> = [
  { value: "startedAt",   label: "Newest first"    },
  { value: "updatedAt",   label: "Recently updated" },
  { value: "completedAt", label: "Completed"        },
  { value: "duration",    label: "Duration"         },
  { value: "status",      label: "Status"           },
];

const APPROVAL_OPTS: ReadonlyArray<{ value: RunsToolbarState["approvalFilter"]; label: string }> = [
  { value: "all",     label: "All runs"          },
  { value: "pending", label: "Approval pending"  },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function RunsToolbar({
  search, status, workflowName, approvalFilter, sort,
  workflowOptions, totalVisible, totalAll,
  onChange, onClear, onRefresh,
}: RunsToolbarProps) {
  const hasFilters =
    search         !== "" ||
    status         !== "all" ||
    workflowName   !== "all" ||
    approvalFilter !== "all";

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
          placeholder="Search runs…"
          aria-label="Search workflow runs"
        />
      </div>

      {/* Run status filter */}
      <select
        className="memory-filter-select"
        value={status}
        onChange={(e) => onChange("status", e.target.value as RunsToolbarState["status"])}
        aria-label="Filter by run status"
      >
        {RUN_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Linked workflow filter */}
      {workflowOptions.length > 0 && (
        <select
          className="memory-filter-select"
          value={workflowName}
          onChange={(e) => onChange("workflowName", e.target.value)}
          aria-label="Filter by workflow"
        >
          <option value="all">All workflows</option>
          {workflowOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      )}

      {/* Approval filter */}
      <select
        className="memory-filter-select"
        value={approvalFilter}
        onChange={(e) => onChange("approvalFilter", e.target.value as RunsToolbarState["approvalFilter"])}
        aria-label="Filter by approval state"
      >
        {APPROVAL_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Sort */}
      <select
        className="memory-filter-select"
        value={sort}
        onChange={(e) => onChange("sort", e.target.value as RunsSortKey)}
        aria-label="Sort runs"
      >
        {SORT_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Meta: count, clear, refresh */}
      <div className="tasks-toolbar-meta">
        {isFiltered && (
          <span className="tasks-toolbar-count muted">
            {totalVisible} of {totalAll}
          </span>
        )}
        {hasFilters && (
          <button type="button" className="tasks-toolbar-clear" onClick={onClear}>
            Clear
          </button>
        )}
        <button
          type="button"
          className="tasks-toolbar-clear"
          onClick={onRefresh}
          title="Reload run list"
        >
          ↻
        </button>
      </div>

    </div>
  );
}
