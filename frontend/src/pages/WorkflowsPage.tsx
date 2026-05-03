import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type {
  WorkflowDefinition,
  WorkflowRun,
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
} from "../types/workflows";
import {
  getWorkflowDefinitions,
  createWorkflowDefinition,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  toggleWorkflowDefinition,
  launchWorkflow,
  getWorkflowRuns,
  terminateWorkflowRun,
  approveWorkflowRun,
  rejectWorkflowRun,
  resumeWorkflowRun,
  restartWorkflowRun,
} from "../lib/workflowsApi";
import {
  createRunLiveClient,
  createMockRunLiveClient,
} from "../lib/workflowRunUpdates";
import type { LiveConnectionState } from "../lib/workflowRunUpdates";
import { WorkflowStatsBar }         from "../components/workflows/WorkflowStatsBar";
import { WorkflowToolbar }          from "../components/workflows/WorkflowToolbar";
import { DefinitionRow }            from "../components/workflows/DefinitionRow";
import { WorkflowRunRow }           from "../components/workflows/WorkflowRunRow";
import { RunsToolbar }              from "../components/workflows/RunsToolbar";
import { WorkflowDefinitionDrawer } from "../components/workflows/WorkflowDefinitionDrawer";
import { WorkflowRunDrawer }        from "../components/workflows/WorkflowRunDrawer";
import { WorkflowLaunchDrawer }     from "../components/workflows/WorkflowLaunchDrawer";
import { LiveConnectionBadge }      from "../components/workflows/LiveConnectionBadge";
import type { DefToolbarState, DefSortKey } from "../components/workflows/WorkflowToolbar";
import { DEF_TOOLBAR_DEFAULT }      from "../components/workflows/WorkflowToolbar";
import type { RunsToolbarState, RunsSortKey } from "../components/workflows/RunsToolbar";
import { RUNS_TOOLBAR_DEFAULT }     from "../components/workflows/RunsToolbar";

// ── Feature flag: mock mode mirrors workflowsApi.ts ──────────────────────────
//   When true, the live client uses interval polling instead of EventSource.
const USE_MOCK = true;

// ── Types ─────────────────────────────────────────────────────────────────────

type ActiveTab = "definitions" | "runs";

interface Banner {
  kind:    "success" | "error";
  message: string;
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function sortDefinitions(defs: WorkflowDefinition[], sort: DefSortKey): WorkflowDefinition[] {
  return [...defs].sort((a, b) => {
    switch (sort) {
      case "name":      return a.name.localeCompare(b.name);
      case "runCount":  return b.runCount - a.runCount;
      case "lastRunAt": return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
      case "updatedAt": return b.updatedAt.localeCompare(a.updatedAt);
      case "status":    return a.status.localeCompare(b.status);
      case "createdAt":
      default:          return b.createdAt.localeCompare(a.createdAt);
    }
  });
}

function runDurationMs(r: WorkflowRun): number {
  const end = r.completedAt ? new Date(r.completedAt).getTime() : Date.now();
  return end - new Date(r.startedAt).getTime();
}

function sortRuns(runs: WorkflowRun[], sort: RunsSortKey): WorkflowRun[] {
  return [...runs].sort((a, b) => {
    switch (sort) {
      case "updatedAt":   return b.updatedAt.localeCompare(a.updatedAt);
      case "completedAt": return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      case "status":      return a.status.localeCompare(b.status);
      case "duration":    return runDurationMs(b) - runDurationMs(a);
      case "startedAt":
      default:            return b.startedAt.localeCompare(a.startedAt);
    }
  });
}

// ── WorkflowsPage ─────────────────────────────────────────────────────────────

export function WorkflowsPage() {
  // ── Data state ─────────────────────────────────────────────────────────────
  const [definitions,  setDefinitions]  = useState<WorkflowDefinition[]>([]);
  const [runs,         setRuns]         = useState<WorkflowRun[]>([]);
  const [loadingDefs,  setLoadingDefs]  = useState(false);
  const [loadingRuns,  setLoadingRuns]  = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [banner,       setBanner]       = useState<Banner | null>(null);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const [activeTab,    setActiveTab]    = useState<ActiveTab>("definitions");

  // ── Definitions toolbar ────────────────────────────────────────────────────
  const [defToolbar, setDefToolbar] = useState<DefToolbarState>(DEF_TOOLBAR_DEFAULT);

  // ── Runs toolbar ───────────────────────────────────────────────────────────
  const [runsToolbar, setRunsToolbar] = useState<RunsToolbarState>(RUNS_TOOLBAR_DEFAULT);

  // ── Drawer / inspector state ───────────────────────────────────────────────
  const [drawerTarget,    setDrawerTarget]    = useState<WorkflowDefinition | null | undefined>(undefined);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<WorkflowRun | undefined>(undefined);

  // ── Launch drawer state ────────────────────────────────────────────────────
  const [launchTarget,  setLaunchTarget]  = useState<WorkflowDefinition | undefined>(undefined);
  const [launchResult,  setLaunchResult]  = useState<WorkflowRun | undefined>(undefined);
  const [launching,     setLaunching]     = useState(false);

  // ── Live connection state ──────────────────────────────────────────────────
  const [liveState, setLiveState] = useState<LiveConnectionState>("connecting");

  const abortRef    = useRef<AbortController | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Banner helper ──────────────────────────────────────────────────────────

  const flash = useCallback((message: string, kind: Banner["kind"] = "success") => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, message });
    bannerTimer.current = setTimeout(() => setBanner(null), 3_500);
  }, []);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const loadDefinitions = useCallback(async (signal?: AbortSignal) => {
    setLoadingDefs(true);
    try {
      const result = await getWorkflowDefinitions(signal);
      if (!signal?.aborted) setDefinitions(result.definitions);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      flash(err instanceof Error ? err.message : "Failed to load definitions.", "error");
    } finally {
      if (!signal?.aborted) setLoadingDefs(false);
    }
  }, [flash]);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setLoadingRuns(true);
    try {
      const result = await getWorkflowRuns(undefined, signal);
      if (!signal?.aborted) setRuns(result.runs);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      flash(err instanceof Error ? err.message : "Failed to load runs.", "error");
    } finally {
      if (!signal?.aborted) setLoadingRuns(false);
    }
  }, [flash]);

  // Load definitions on mount.
  useEffect(() => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    void loadDefinitions(ctl.signal);
    return () => {
      ctl.abort();
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, [loadDefinitions]);

  // Load runs on mount.
  useEffect(() => {
    const ctl = new AbortController();
    void loadRuns(ctl.signal);
    return () => ctl.abort();
  }, [loadRuns]);

  // ── Live run updates ───────────────────────────────────────────────────────

  useEffect(() => {
    function applyUpdate(updated: WorkflowRun) {
      setRuns((prev) => {
        const exists = prev.some((r) => r.id === updated.id);
        return exists
          ? prev.map((r) => (r.id === updated.id ? updated : r))
          : prev;
      });
      setInspectorTarget((prev) =>
        prev?.id === updated.id ? updated : prev
      );
    }

    let client: ReturnType<typeof createRunLiveClient> | ReturnType<typeof createMockRunLiveClient>;

    if (USE_MOCK) {
      client = createMockRunLiveClient(
        async () => {
          const result = await getWorkflowRuns();
          return result.runs;
        },
        applyUpdate,
        setLiveState,
        10_000,
      );
    } else {
      client = createRunLiveClient({
        url: "/api/workflows/runs/stream",
        onUpdate: applyUpdate,
        onStateChange: setLiveState,
      });
    }

    return () => client.close();
  }, []);

  // ── Mutation handlers ──────────────────────────────────────────────────────

  async function handleSave(
    id: string | null,
    data: CreateWorkflowDefinitionInput | UpdateWorkflowDefinitionInput,
  ) {
    setSaving(true);
    try {
      if (id) {
        const updated = await updateWorkflowDefinition(id, data as UpdateWorkflowDefinitionInput);
        setDefinitions((prev) => prev.map((d) => (d.id === id ? updated : d)));
        flash("Definition updated.");
      } else {
        const created = await createWorkflowDefinition(data as CreateWorkflowDefinitionInput);
        setDefinitions((prev) => [created, ...prev]);
        flash("Definition created.");
      }
      setDrawerTarget(undefined);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save definition.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteConfirmId(null);
    setSaving(true);
    try {
      await deleteWorkflowDefinition(id);
      setDefinitions((prev) => prev.filter((d) => d.id !== id));
      setDrawerTarget((prev) =>
        prev && typeof prev === "object" && prev.id === id ? undefined : prev
      );
      flash("Definition deleted.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to delete definition.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    setSaving(true);
    try {
      const updated = await toggleWorkflowDefinition(id, enabled);
      setDefinitions((prev) => prev.map((d) => (d.id === id ? updated : d)));
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to update definition.", "error");
    } finally {
      setSaving(false);
    }
  }

  // Opens the launch drawer instead of firing immediately.
  function handleOpenLaunch(def: WorkflowDefinition) {
    setLaunchTarget(def);
    setLaunchResult(undefined);
  }

  async function handleLaunchConfirm(definitionId: string, payload?: Record<string, unknown>) {
    setLaunching(true);
    const def = definitions.find((d) => d.id === definitionId);
    try {
      const run = await launchWorkflow(definitionId, payload ? { input: payload } : undefined);
      setDefinitions((prev) =>
        prev.map((d) =>
          d.id === definitionId
            ? { ...d, runCount: d.runCount + 1, lastRunAt: run.startedAt }
            : d
        )
      );
      setRuns((prev) => [run, ...prev]);
      setLaunchResult(run);
      flash(`Launched "${def?.name ?? definitionId}" — run ${run.id.slice(0, 8)}…`);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to launch workflow.", "error");
    } finally {
      setLaunching(false);
    }
  }

  function handleLaunchClose() {
    setLaunchTarget(undefined);
    setLaunchResult(undefined);
  }

  function handleViewRunFromLaunch(run: WorkflowRun) {
    setActiveTab("runs");
    setInspectorTarget(run);
  }

  // ── Definition ↔ Run navigation ────────────────────────────────────────────

  function handleViewRuns(def: WorkflowDefinition) {
    setActiveTab("runs");
    setRunsToolbar((prev) => ({ ...prev, workflowName: def.name }));
  }

  // ── Run lifecycle handlers ──────────────────────────────────────────────────

  function patchRun(updated: WorkflowRun) {
    setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    if (inspectorTarget?.id === updated.id) setInspectorTarget(updated);
  }

  async function handleTerminate(runId: string) {
    setSaving(true);
    try {
      patchRun(await terminateWorkflowRun(runId));
      flash("Run terminated.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to terminate run.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove(runId: string, comment?: string) {
    setSaving(true);
    try {
      patchRun(await approveWorkflowRun(runId, comment ? { comment } : undefined));
      flash("Run approved — continuing execution.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to approve run.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleReject(runId: string, comment?: string) {
    setSaving(true);
    try {
      patchRun(await rejectWorkflowRun(runId, comment ? { comment } : undefined));
      flash("Run rejected and terminated.", "error");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to reject run.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleResume(runId: string) {
    setSaving(true);
    try {
      patchRun(await resumeWorkflowRun(runId));
      flash("Run resumed.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to resume run.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart(runId: string) {
    setSaving(true);
    try {
      patchRun(await restartWorkflowRun(runId));
      flash("Run restarted.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to restart run.", "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Toolbar change handlers ────────────────────────────────────────────────

  function handleDefToolbarChange<K extends keyof DefToolbarState>(
    key: K, value: DefToolbarState[K],
  ) {
    setDefToolbar((prev) => ({ ...prev, [key]: value }));
  }

  function handleRunsToolbarChange<K extends keyof RunsToolbarState>(
    key: K, value: RunsToolbarState[K],
  ) {
    setRunsToolbar((prev) => ({ ...prev, [key]: value }));
  }

  // ── Derived / filtered lists ───────────────────────────────────────────────

  const visibleDefs = useMemo(() => {
    let result = definitions;
    const q = defToolbar.search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          (d.description ?? "").toLowerCase().includes(q) ||
          (d.workflowType ?? "").toLowerCase().includes(q) ||
          d.entrypoint.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    if (defToolbar.enabledFilter === "enabled")  result = result.filter((d) => d.enabled);
    if (defToolbar.enabledFilter === "disabled") result = result.filter((d) => !d.enabled);
    if (defToolbar.triggerMode  !== "all") result = result.filter((d) => d.triggerMode  === defToolbar.triggerMode);
    if (defToolbar.approvalMode !== "all") result = result.filter((d) => d.approvalMode === defToolbar.approvalMode);
    if (defToolbar.statusFilter !== "all") result = result.filter((d) => d.status       === defToolbar.statusFilter);
    return sortDefinitions(result, defToolbar.sort);
  }, [definitions, defToolbar]);

  const workflowNameOptions = useMemo(
    () => [...new Set(runs.map((r) => r.workflowName))].sort(),
    [runs]
  );

  const visibleRuns = useMemo(() => {
    let result = runs;
    const q = runsToolbar.search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          r.workflowName.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q)
      );
    }
    if (runsToolbar.status !== "all") {
      result = result.filter((r) => r.status === runsToolbar.status);
    }
    if (runsToolbar.workflowName !== "all") {
      result = result.filter((r) => r.workflowName === runsToolbar.workflowName);
    }
    if (runsToolbar.approvalFilter === "pending") {
      result = result.filter((r) => r.waitingForApproval === true);
    }
    return sortRuns(result, runsToolbar.sort);
  }, [runs, runsToolbar]);

  const defDrawerOpen      = drawerTarget !== undefined;
  const runInspectorOpen   = inspectorTarget !== undefined;
  const launchDrawerOpen   = launchTarget !== undefined;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="page-shell">

      {/* ── Delete confirm modal ── */}
      {deleteConfirmId && (
        <div
          className="modal-backdrop"
          onClick={() => setDeleteConfirmId(null)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-wf-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-wf-title" style={{ margin: "0 0 8px", fontSize: 16 }}>
              Delete definition?
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
              This removes the definition and all its configuration. Existing run
              history is not affected. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDeleteConfirmId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{ background: "var(--danger)", borderColor: "#6e2020" }}
                onClick={() => void handleDelete(deleteConfirmId)}
              >
                Delete definition
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page header ── */}
      <header className="page-header">
        <div className="page-header-main">
          <h2>Workflows</h2>
          <p className="subhead">
            Durable workflow definitions and execution runs — launch from chat or on demand.
          </p>
        </div>
        <div className="page-header-actions" style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn-header-secondary"
            disabled={loadingDefs || loadingRuns}
            onClick={() => {
              void loadDefinitions();
              void loadRuns();
            }}
          >
            {loadingDefs || loadingRuns ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={() => {
              setActiveTab("definitions");
              setDrawerTarget(null);
            }}
          >
            + New definition
          </button>
        </div>
      </header>

      {/* ── Overview stats ── */}
      <WorkflowStatsBar
        definitions={definitions}
        runs={runs}
        loadingDefs={loadingDefs}
        loadingRuns={loadingRuns}
      />

      {/* ── Banner ── */}
      {banner && (
        <div
          className={`memory-banner memory-banner-${banner.kind === "success" ? "success" : "error"}`}
          role={banner.kind === "error" ? "alert" : "status"}
        >
          {banner.message}
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="memory-tab-bar" role="tablist" aria-label="Workflow views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "definitions"}
          className={`memory-tab-btn${activeTab === "definitions" ? " is-active" : ""}`}
          onClick={() => setActiveTab("definitions")}
        >
          Definitions
          {definitions.length > 0 && (
            <span className="wf-tab-count">{definitions.length}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "runs"}
          className={`memory-tab-btn${activeTab === "runs" ? " is-active" : ""}`}
          onClick={() => setActiveTab("runs")}
        >
          Runs
          {runs.length > 0 && (
            <span className="wf-tab-count">{runs.length}</span>
          )}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          DEFINITIONS TAB
         ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "definitions" && (
        <>
          <WorkflowToolbar
            search={defToolbar.search}
            enabledFilter={defToolbar.enabledFilter}
            triggerMode={defToolbar.triggerMode}
            approvalMode={defToolbar.approvalMode}
            statusFilter={defToolbar.statusFilter}
            sort={defToolbar.sort}
            totalVisible={visibleDefs.length}
            totalAll={definitions.length}
            onChange={handleDefToolbarChange}
            onClear={() => setDefToolbar(DEF_TOOLBAR_DEFAULT)}
          />

          <div
            className={`tasks-main-area wf-main-area${defDrawerOpen || launchDrawerOpen ? " drawer-open" : ""}`}
            onClick={(e) => {
              if ((defDrawerOpen || launchDrawerOpen) && e.target === e.currentTarget) {
                setDrawerTarget(undefined);
                handleLaunchClose();
              }
            }}
          >
            <div className="tasks-table-area">
              {loadingDefs ? (

                /* Skeleton */
                <table className="tasks-table wf-definitions-table" aria-busy="true" aria-label="Definitions loading">
                  <thead>
                    <tr>
                      <th className="tasks-th tasks-th-title">Definition</th>
                      <th className="tasks-th tasks-th-type">Trigger</th>
                      <th className="tasks-th tasks-th-type tasks-td-collapsible">Approval</th>
                      <th className="tasks-th tasks-th-type">Status</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Last run</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Updated</th>
                      <th className="tasks-th tasks-th-toggle">Enabled</th>
                      <th className="tasks-th tasks-th-actions">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3].map((i) => (
                      <tr key={i} className="tasks-row">
                        <td className="tasks-td tasks-td-title">
                          <div className="tasks-skeleton-line" style={{ width: "60%" }} />
                          <div className="tasks-skeleton-line" style={{ width: "40%", marginTop: 5 }} />
                          <div className="tasks-skeleton-pill" style={{ marginTop: 6 }} />
                        </td>
                        <td className="tasks-td tasks-td-type">
                          <div className="tasks-skeleton-pill" />
                        </td>
                        <td className="tasks-td tasks-td-type tasks-td-collapsible">
                          <div className="tasks-skeleton-pill" />
                        </td>
                        <td className="tasks-td tasks-td-type">
                          <div className="tasks-skeleton-pill" />
                        </td>
                        <td className="tasks-td tasks-td-date tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: 56 }} />
                        </td>
                        <td className="tasks-td tasks-td-date tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: 48 }} />
                        </td>
                        <td className="tasks-td tasks-td-toggle" />
                        <td className="tasks-td tasks-td-actions" />
                      </tr>
                    ))}
                  </tbody>
                </table>

              ) : visibleDefs.length === 0 ? (

                /* Empty state */
                <div className="tasks-empty-state">
                  {definitions.length === 0 ? (
                    <>
                      <svg
                        className="tasks-empty-icon"
                        width="40" height="40"
                        viewBox="0 0 256 256"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H216v40H40Zm176,144H40V112H216Z" opacity="0.3"/>
                        <circle cx="80" cy="136" r="10"/>
                        <circle cx="128" cy="136" r="10"/>
                        <circle cx="176" cy="136" r="10"/>
                        <rect x="64" y="164" width="128" height="12" rx="6"/>
                      </svg>
                      <p className="tasks-empty-title">No workflow definitions yet</p>
                      <p className="tasks-empty-desc">
                        Create a definition to make a workflow available<br />for launch from chat or this page.
                      </p>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => setDrawerTarget(null)}
                      >
                        + New definition
                      </button>
                    </>
                  ) : (
                    <>
                      <svg
                        className="tasks-empty-icon"
                        width="36" height="36"
                        viewBox="0 0 256 256"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M229.66,218.34l-50.07-50.06a88.21,88.21,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" opacity="0.35"/>
                      </svg>
                      <p className="tasks-empty-title">No matching definitions</p>
                      <p className="tasks-empty-desc">No definitions match the current search or filters.</p>
                      <button
                        type="button"
                        className="btn-header-secondary"
                        onClick={() => setDefToolbar(DEF_TOOLBAR_DEFAULT)}
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                </div>

              ) : (

                /* Definitions table */
                <table className="tasks-table wf-definitions-table" aria-label="Workflow definitions">
                  <thead>
                    <tr>
                      <th className="tasks-th tasks-th-title">Definition</th>
                      <th className="tasks-th tasks-th-type">Trigger</th>
                      <th className="tasks-th tasks-th-type tasks-td-collapsible">Approval</th>
                      <th className="tasks-th tasks-th-type">Status</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Last run</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Updated</th>
                      <th className="tasks-th tasks-th-toggle">Enabled</th>
                      <th className="tasks-th tasks-th-actions">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDefs.map((def) => (
                      <DefinitionRow
                        key={def.id}
                        definition={def}
                        isSelected={
                          drawerTarget !== null &&
                          drawerTarget !== undefined &&
                          drawerTarget.id === def.id
                        }
                        busy={saving || launching}
                        onEdit={(d) => setDrawerTarget(d)}
                        onDelete={(id) => setDeleteConfirmId(id)}
                        onLaunch={handleOpenLaunch}
                        onToggle={handleToggle}
                        onViewRuns={handleViewRuns}
                      />
                    ))}
                  </tbody>
                </table>

              )}
            </div>

            {/* Slide-over definition editor */}
            <WorkflowDefinitionDrawer
              definition={drawerTarget}
              saving={saving}
              onSave={handleSave}
              onClose={() => setDrawerTarget(undefined)}
            />

            {/* Launch drawer (overlaps the definitions table area) */}
            <WorkflowLaunchDrawer
              definition={launchTarget}
              launching={launching}
              launchResult={launchResult}
              onLaunch={handleLaunchConfirm}
              onViewRun={handleViewRunFromLaunch}
              onClose={handleLaunchClose}
            />

          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          RUNS TAB
         ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "runs" && (
        <>
          {/* Runs toolbar + live badge */}
          <div className="wf-runs-toolbar-row">
            <RunsToolbar
              search={runsToolbar.search}
              status={runsToolbar.status}
              workflowName={runsToolbar.workflowName}
              approvalFilter={runsToolbar.approvalFilter}
              sort={runsToolbar.sort}
              workflowOptions={workflowNameOptions}
              totalVisible={visibleRuns.length}
              totalAll={runs.length}
              onChange={handleRunsToolbarChange}
              onClear={() => setRunsToolbar(RUNS_TOOLBAR_DEFAULT)}
              onRefresh={() => void loadRuns()}
            />
            <LiveConnectionBadge state={liveState} />
          </div>

          <div
            className={`tasks-main-area wf-main-area${runInspectorOpen ? " drawer-open" : ""}`}
            onClick={(e) => {
              if (runInspectorOpen && e.target === e.currentTarget) {
                setInspectorTarget(undefined);
              }
            }}
          >
            <div className="tasks-table-area">
              {loadingRuns ? (

                /* ── Skeleton ── */
                <table className="tasks-table" aria-busy="true" aria-label="Runs loading">
                  <thead>
                    <tr>
                      <th className="tasks-th tasks-th-title">Run</th>
                      <th className="tasks-th tasks-th-status">Status</th>
                      <th className="tasks-th tasks-th-type tasks-td-collapsible">Progress</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Started</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Duration</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Updated</th>
                      <th className="tasks-th tasks-th-actions">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3, 4].map((i) => (
                      <tr key={i} className="tasks-row">
                        <td className="tasks-td tasks-td-title">
                          <div className="tasks-skeleton-line" style={{ width: "55%" }} />
                          <div className="tasks-skeleton-line" style={{ width: "75%", marginTop: 5 }} />
                        </td>
                        <td className="tasks-td tasks-td-status">
                          <div className="tasks-skeleton-pill" />
                        </td>
                        <td className="tasks-td tasks-td-type tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: "80%" }} />
                        </td>
                        <td className="tasks-td tasks-td-date tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: 56 }} />
                        </td>
                        <td className="tasks-td tasks-td-date tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: 40 }} />
                        </td>
                        <td className="tasks-td tasks-td-date tasks-td-collapsible">
                          <div className="tasks-skeleton-line" style={{ width: 48 }} />
                        </td>
                        <td className="tasks-td tasks-td-actions" />
                      </tr>
                    ))}
                  </tbody>
                </table>

              ) : visibleRuns.length === 0 ? (

                /* ── Empty state ── */
                <div className="tasks-empty-state">
                  {runs.length === 0 ? (
                    <>
                      <svg
                        className="tasks-empty-icon"
                        width="40" height="40"
                        viewBox="0 0 256 256"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z" opacity="0.3"/>
                        <polygon points="112 80 160 128 112 176 112 80"/>
                      </svg>
                      <p className="tasks-empty-title">No runs yet</p>
                      <p className="tasks-empty-desc">
                        Launch a workflow definition to create your first run.
                      </p>
                      <button
                        type="button"
                        className="btn-header-secondary"
                        onClick={() => setActiveTab("definitions")}
                      >
                        Go to Definitions
                      </button>
                    </>
                  ) : (
                    <>
                      <svg
                        className="tasks-empty-icon"
                        width="36" height="36"
                        viewBox="0 0 256 256"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M229.66,218.34l-50.07-50.06a88.21,88.21,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" opacity="0.35"/>
                      </svg>
                      <p className="tasks-empty-title">No matching runs</p>
                      <p className="tasks-empty-desc">No runs match the current search or filters.</p>
                      <button
                        type="button"
                        className="btn-header-secondary"
                        onClick={() => setRunsToolbar(RUNS_TOOLBAR_DEFAULT)}
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                </div>

              ) : (

                /* ── Runs table ── */
                <table className="tasks-table" aria-label="Workflow runs">
                  <thead>
                    <tr>
                      <th className="tasks-th tasks-th-title">Run</th>
                      <th className="tasks-th tasks-th-status">Status</th>
                      <th className="tasks-th tasks-th-type tasks-td-collapsible">Progress</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Started</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Duration</th>
                      <th className="tasks-th tasks-th-date tasks-td-collapsible">Updated</th>
                      <th className="tasks-th tasks-th-actions">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRuns.map((run) => (
                      <WorkflowRunRow
                        key={run.id}
                        run={run}
                        isSelected={inspectorTarget?.id === run.id}
                        busy={saving}
                        onView={(r) => setInspectorTarget(r)}
                        onApprove={handleApprove}
                        onReject={handleReject}
                        onResume={handleResume}
                        onRestart={handleRestart}
                        onTerminate={handleTerminate}
                      />
                    ))}
                  </tbody>
                </table>

              )}
            </div>

            {/* Slide-over run inspector */}
            <WorkflowRunDrawer
              run={inspectorTarget}
              busy={saving}
              onTerminate={handleTerminate}
              onApprove={handleApprove}
              onReject={handleReject}
              onResume={handleResume}
              onRestart={handleRestart}
              onClose={() => setInspectorTarget(undefined)}
            />

          </div>
        </>
      )}

    </section>
  );
}
