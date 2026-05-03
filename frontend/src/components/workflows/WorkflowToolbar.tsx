import type {
  WorkflowTriggerMode,
  WorkflowApprovalMode,
  WorkflowDefinitionStatus,
} from "../../types/workflows";
import {
  TRIGGER_MODE_OPTIONS,
  APPROVAL_MODE_OPTIONS,
  DEFINITION_STATUS_OPTIONS,
} from "../../types/workflows";

// ── Types exported for WorkflowsPage ──────────────────────────────────────────

export type DefSortKey =
  | "createdAt"
  | "updatedAt"
  | "name"
  | "runCount"
  | "lastRunAt"
  | "status";

export interface DefToolbarState {
  search:        string;
  enabledFilter: "all" | "enabled" | "disabled";
  triggerMode:   "all" | WorkflowTriggerMode;
  approvalMode:  "all" | WorkflowApprovalMode;
  statusFilter:  "all" | WorkflowDefinitionStatus;
  sort:          DefSortKey;
}

// ── Empty / default state — exported so WorkflowsPage can reset easily ─────

export const DEF_TOOLBAR_DEFAULT: DefToolbarState = {
  search:        "",
  enabledFilter: "all",
  triggerMode:   "all",
  approvalMode:  "all",
  statusFilter:  "all",
  sort:          "createdAt",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowToolbarProps extends DefToolbarState {
  totalVisible: number;
  totalAll:     number;
  onChange: <K extends keyof DefToolbarState>(key: K, value: DefToolbarState[K]) => void;
  onClear: () => void;
}

// ── Option lists ──────────────────────────────────────────────────────────────

const ENABLED_OPTS: ReadonlyArray<{ value: DefToolbarState["enabledFilter"]; label: string }> = [
  { value: "all",      label: "All"      },
  { value: "enabled",  label: "Enabled"  },
  { value: "disabled", label: "Disabled" },
];

const SORT_OPTS: ReadonlyArray<{ value: DefSortKey; label: string }> = [
  { value: "createdAt", label: "Newest first"   },
  { value: "updatedAt", label: "Recently edited" },
  { value: "name",      label: "Name A–Z"       },
  { value: "runCount",  label: "Most runs"       },
  { value: "lastRunAt", label: "Last run"        },
  { value: "status",    label: "Status"          },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkflowToolbar({
  search, enabledFilter, triggerMode, approvalMode, statusFilter, sort,
  totalVisible, totalAll,
  onChange, onClear,
}: WorkflowToolbarProps) {
  const hasFilters =
    search !== "" ||
    enabledFilter !== "all" ||
    triggerMode   !== "all" ||
    approvalMode  !== "all" ||
    statusFilter  !== "all";

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
          placeholder="Search definitions…"
          aria-label="Search workflow definitions"
        />
      </div>

      {/* Enabled filter */}
      <select
        className="memory-filter-select"
        value={enabledFilter}
        onChange={(e) => onChange("enabledFilter", e.target.value as DefToolbarState["enabledFilter"])}
        aria-label="Filter by enabled state"
      >
        {ENABLED_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Trigger mode filter */}
      <select
        className="memory-filter-select"
        value={triggerMode}
        onChange={(e) => onChange("triggerMode", e.target.value as DefToolbarState["triggerMode"])}
        aria-label="Filter by trigger mode"
      >
        <option value="all">All triggers</option>
        {TRIGGER_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Approval mode filter */}
      <select
        className="memory-filter-select"
        value={approvalMode}
        onChange={(e) => onChange("approvalMode", e.target.value as DefToolbarState["approvalMode"])}
        aria-label="Filter by approval mode"
      >
        <option value="all">All approvals</option>
        {APPROVAL_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Definition status filter */}
      <select
        className="memory-filter-select"
        value={statusFilter}
        onChange={(e) => onChange("statusFilter", e.target.value as DefToolbarState["statusFilter"])}
        aria-label="Filter by definition status"
      >
        <option value="all">All statuses</option>
        {DEFINITION_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Sort */}
      <select
        className="memory-filter-select"
        value={sort}
        onChange={(e) => onChange("sort", e.target.value as DefSortKey)}
        aria-label="Sort definitions"
      >
        {SORT_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Result count + clear */}
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
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>

    </div>
  );
}
