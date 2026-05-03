import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type {
  ScheduledTask,
  TaskStatus,
  ScheduleType,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from "../types/tasks";
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  toggleTask,
} from "../lib/tasksApi";
import { TaskStatsBar }  from "../components/tasks/TaskStatsBar";
import { TaskToolbar }   from "../components/tasks/TaskToolbar";
import { TaskRow }       from "../components/tasks/TaskRow";
import { TaskDrawer }    from "../components/tasks/TaskDrawer";
import type { ToolbarState, SortKey } from "../components/tasks/TaskToolbar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Banner {
  kind:    "success" | "error";
  message: string;
}

// ── Sort helper ───────────────────────────────────────────────────────────────

function sortTasks(tasks: ScheduledTask[], sort: SortKey): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case "title":
        return a.title.localeCompare(b.title);
      case "nextRunAt":
        return (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "");
      case "lastRunAt":
        return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
      case "status":
        return a.status.localeCompare(b.status);
      case "createdAt":
      default:
        return b.createdAt.localeCompare(a.createdAt);
    }
  });
}

// ── TasksPage ─────────────────────────────────────────────────────────────────

export function TasksPage() {
  // ── Core data state ────────────────────────────────────────────────────────
  const [tasks,   setTasks]   = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [banner,  setBanner]  = useState<Banner | null>(null);

  // ── Toolbar / filter state ─────────────────────────────────────────────────
  const [toolbar, setToolbar] = useState<ToolbarState>({
    search:         "",
    statusFilter:   "all",
    scheduleFilter: "all",
    sort:           "createdAt",
  });

  // drawerTarget: undefined = closed; null = create; ScheduledTask = edit
  const [drawerTarget,    setDrawerTarget]    = useState<ScheduledTask | null | undefined>(undefined);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const abortRef    = useRef<AbortController | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Banner helper ──────────────────────────────────────────────────────────

  const flash = useCallback((message: string, kind: Banner["kind"] = "success") => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, message });
    bannerTimer.current = setTimeout(() => setBanner(null), 3_500);
  }, []);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await getTasks(signal);
      if (!signal?.aborted) setTasks(result.tasks);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      flash(err instanceof Error ? err.message : "Failed to load tasks.", "error");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    void load(ctl.signal);
    return () => {
      ctl.abort();
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, [load]);

  // ── Mutation handlers ──────────────────────────────────────────────────────

  async function handleSave(
    id: string | null,
    data: CreateScheduledTaskInput | UpdateScheduledTaskInput,
  ) {
    setSaving(true);
    try {
      if (id) {
        const updated = await updateTask(id, data as UpdateScheduledTaskInput);
        setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
        flash("Task updated.");
      } else {
        const created = await createTask(data as CreateScheduledTaskInput);
        setTasks((prev) => [...prev, created]);
        flash("Task created.");
      }
      setDrawerTarget(undefined);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save task.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteConfirmId(null);
    setSaving(true);
    try {
      await deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      // If deleting the task currently open in the drawer, close it.
      setDrawerTarget((prev) =>
        prev && typeof prev === "object" && prev.id === id ? undefined : prev,
      );
      flash("Task deleted.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to delete task.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    setSaving(true);
    try {
      const updated = await toggleTask(id, enabled);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to update task.", "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Toolbar change handler ─────────────────────────────────────────────────

  function handleToolbarChange<K extends keyof ToolbarState>(
    key: K,
    value: ToolbarState[K],
  ) {
    setToolbar((prev) => ({ ...prev, [key]: value }));
  }

  // ── Derived / filtered tasks ───────────────────────────────────────────────

  const visible = useMemo(() => {
    let result = tasks;
    const q = toolbar.search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q) ||
          t.instructions.toLowerCase().includes(q),
      );
    }
    if (toolbar.statusFilter !== "all") {
      result = result.filter((t) => t.status === (toolbar.statusFilter as TaskStatus));
    }
    if (toolbar.scheduleFilter !== "all") {
      result = result.filter((t) => t.scheduleType === (toolbar.scheduleFilter as ScheduleType));
    }
    return sortTasks(result, toolbar.sort);
  }, [tasks, toolbar]);

  const drawerOpen = drawerTarget !== undefined;

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
            aria-labelledby="delete-task-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-task-title" style={{ margin: "0 0 8px", fontSize: 16 }}>
              Delete task?
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
              This permanently removes the task and all its configuration. This cannot be undone.
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
                Delete task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page header ── */}
      <header className="page-header">
        <div className="page-header-main">
          <h2>Tasks</h2>
          <p className="subhead">
            Scheduled tasks — reminders, workflows, and follow-ups that run automatically.
          </p>
        </div>
        <div className="page-header-actions" style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn-header-secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={() => setDrawerTarget(null)}
          >
            + New task
          </button>
        </div>
      </header>

      {/* ── Overview stats ── */}
      <TaskStatsBar tasks={tasks} loading={loading} />

      {/* ── Banner ── */}
      {banner && (
        <div
          className={`memory-banner memory-banner-${banner.kind === "success" ? "success" : "error"}`}
          role={banner.kind === "error" ? "alert" : "status"}
        >
          {banner.message}
        </div>
      )}

      {/* ── Toolbar ── */}
      <TaskToolbar
        search={toolbar.search}
        statusFilter={toolbar.statusFilter}
        scheduleFilter={toolbar.scheduleFilter}
        sort={toolbar.sort}
        totalVisible={visible.length}
        totalAll={tasks.length}
        onChange={handleToolbarChange}
      />

      {/* ── Main content area: table + slide-over drawer ── */}
      {/* The ::before backdrop on .drawer-open closes the drawer when clicked on mobile. */}
      <div
        className={`tasks-main-area${drawerOpen ? " drawer-open" : ""}`}
        onClick={(e) => {
          // Close drawer when the backdrop pseudo-element is clicked on mobile.
          // The backdrop covers the table area; clicks on the drawer itself are
          // stopped by the drawer's own elements (buttons, inputs, etc.).
          if (drawerOpen && e.target === e.currentTarget) {
            setDrawerTarget(undefined);
          }
        }}
      >

        {/* ── Scrollable table area ── */}
        <div className="tasks-table-area">
          {loading ? (

            /* ── Skeleton rows ── */
            <table className="tasks-table" aria-busy="true" aria-label="Tasks loading">
              <thead>
                <tr>
                  <th className="tasks-th tasks-th-title">Task</th>
                  <th className="tasks-th tasks-th-type">Type</th>
                  <th className="tasks-th tasks-th-schedule">Schedule</th>
                  <th className="tasks-th tasks-th-status">Status</th>
                  <th className="tasks-th tasks-th-date tasks-td-collapsible">Next run</th>
                  <th className="tasks-th tasks-th-date tasks-td-collapsible">Last run</th>
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
                      <div className="tasks-skeleton-line" style={{ width: "65%" }} />
                      <div className="tasks-skeleton-line" style={{ width: "45%", marginTop: 5 }} />
                    </td>
                    <td className="tasks-td tasks-td-type">
                      <div className="tasks-skeleton-pill" />
                    </td>
                    <td className="tasks-td tasks-td-schedule">
                      <div className="tasks-skeleton-line" style={{ width: "80%" }} />
                    </td>
                    <td className="tasks-td tasks-td-status">
                      <div className="tasks-skeleton-pill" />
                    </td>
                    <td className="tasks-td tasks-td-date tasks-td-collapsible">
                      <div className="tasks-skeleton-line" style={{ width: 72 }} />
                    </td>
                    <td className="tasks-td tasks-td-date tasks-td-collapsible">
                      <div className="tasks-skeleton-line" style={{ width: 72 }} />
                    </td>
                    <td className="tasks-td tasks-td-toggle" />
                    <td className="tasks-td tasks-td-actions" />
                  </tr>
                ))}
              </tbody>
            </table>

          ) : visible.length === 0 ? (

            /* ── Empty / no-results state ── */
            <div className="tasks-empty-state">
              {tasks.length === 0 ? (
                <>
                  <svg
                    className="tasks-empty-icon"
                    width="40" height="40"
                    viewBox="0 0 256 256"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM32,64H224V96H32ZM224,192H32V112H224Z" opacity="0.3"/>
                    <rect x="48" y="128" width="40" height="12" rx="6"/>
                    <rect x="48" y="152" width="64" height="12" rx="6"/>
                  </svg>
                  <p className="tasks-empty-title">No tasks yet</p>
                  <p className="tasks-empty-desc">
                    Create a scheduled task to automate reminders,<br />workflows, and follow-ups.
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => setDrawerTarget(null)}
                  >
                    + New task
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
                  <p className="tasks-empty-title">No matching tasks</p>
                  <p className="tasks-empty-desc">
                    No tasks match the current search or filters.
                  </p>
                  <button
                    type="button"
                    className="btn-header-secondary"
                    onClick={() => setToolbar((prev) => ({
                      ...prev,
                      search: "", statusFilter: "all", scheduleFilter: "all",
                    }))}
                  >
                    Clear filters
                  </button>
                </>
              )}
            </div>

          ) : (

            /* ── Task table ── */
            <table className="tasks-table" aria-label="Task list">
              <thead>
                <tr>
                  <th className="tasks-th tasks-th-title">Task</th>
                  <th className="tasks-th tasks-th-type">Type</th>
                  <th className="tasks-th tasks-th-schedule">Schedule</th>
                  <th className="tasks-th tasks-th-status">Status</th>
                  <th className="tasks-th tasks-th-date tasks-td-collapsible">Next run</th>
                  <th className="tasks-th tasks-th-date tasks-td-collapsible">Last run</th>
                  <th className="tasks-th tasks-th-toggle">Enabled</th>
                  <th className="tasks-th tasks-th-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    isSelected={
                      drawerTarget !== null &&
                      drawerTarget !== undefined &&
                      drawerTarget.id === task.id
                    }
                    busy={saving}
                    onEdit={(t) => setDrawerTarget(t)}
                    onDelete={(id) => setDeleteConfirmId(id)}
                    onToggle={handleToggle}
                  />
                ))}
              </tbody>
            </table>

          )}
        </div>

        {/* ── Right-side slide-over editor drawer ── */}
        <TaskDrawer
          task={drawerTarget}
          saving={saving}
          onSave={handleSave}
          onClose={() => setDrawerTarget(undefined)}
        />

      </div>

    </section>
  );
}
