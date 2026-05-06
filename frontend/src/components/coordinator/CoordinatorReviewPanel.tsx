import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  getCoordinatorProjectWorkspacePatch,
  listCoordinatorProjectWorkspacePatches,
  patchCoordinatorRun,
  patchCoordinatorTask,
} from "../../lib/coordinatorControlPlaneApi";
import { isDebugSystemPatchId } from "../../lib/coordinatorPatchClassification";
import type {
  CoordinatorProject,
  CoordinatorRun,
  CoordinatorRunIterationEvidence,
  CoordinatorReviewReasonCategory,
  CoordinatorTask,
} from "../../types/coordinatorControlPlane";

export interface CoordinatorReviewPanelProps {
  storageAvailable: boolean;
  sharedWorkspaceKvPresent: boolean;
  selectedProjectId: string | null;
  selectedProject: CoordinatorProject | null;
  tasks: CoordinatorTask[];
  runs: CoordinatorRun[];
  reviewExplicitRunId: string | null;
  reviewAnchorTaskId: string | null;
  onClearReview: () => void;
  onTaskUpdated: () => void;
  flash: (message: string, kind?: "success" | "error") => void;
}

type WorkspacePatchRow = { patchId: string; status: string };

function collectRunLinkedPatchIds(run: CoordinatorRun | null): Set<string> {
  const s = new Set<string>();
  if (!run) return s;
  run.patchIds?.forEach((id) => s.add(id));
  const ev = run.iterationEvidence;
  if (ev) {
    for (const row of ev) {
      row.newPendingPatchIds?.forEach((id) => s.add(id));
      row.activePatchIdsForIteration?.forEach((id) => s.add(id));
    }
  }
  return s;
}

function formatPatchIdInlineList(ids: string[] | undefined): ReactNode {
  if (!ids?.length) return "—";
  return ids.map((id, i) => (
    <Fragment key={id}>
      {i > 0 ? ", " : null}
      <code
        className={
          isDebugSystemPatchId(id)
            ? "coord-review-patch-id coord-review-patch-id--debug"
            : "coord-review-patch-id coord-review-patch-id--task"
        }
        title={isDebugSystemPatchId(id) ? "Debug / system scaffolding" : "Task / coder patch"}
      >
        {id}
      </code>
    </Fragment>
  ));
}

function formatVerdictChain(s: string | undefined): string {
  if (!s) return "—";
  return s.replace(/\u2192/g, " → ");
}

function formatReviewReasonLabel(c: CoordinatorReviewReasonCategory | undefined): string {
  if (!c) return "—";
  const map: Record<CoordinatorReviewReasonCategory, string> = {
    contract_mismatch: "Contract / schema mismatch",
    acceptance_criteria_failure: "Acceptance criteria",
    dependency_issue: "Dependency issue",
    operator_preference: "Operator preference",
    other: "Other",
  };
  return map[c] ?? c;
}

const REVIEW_REASON_OPTIONS: { value: CoordinatorReviewReasonCategory; label: string }[] = [
  { value: "contract_mismatch", label: "Contract / schema mismatch" },
  { value: "acceptance_criteria_failure", label: "Acceptance criteria failure" },
  { value: "dependency_issue", label: "Dependency issue" },
  { value: "operator_preference", label: "Operator preference" },
  { value: "other", label: "Other" },
];

function turnLine(m: { ok: boolean; textLen: number; eventCount: number; error?: string }): string {
  const bits = [`ok=${m.ok}`, `textLen=${m.textLen}`, `events=${m.eventCount}`];
  if (m.error) bits.push(`err=${m.error}`);
  return bits.join(" · ");
}

function CoordinatorReviewPatchListRow({
  patch,
  expandedPatchId,
  patchBody,
  patchDetailBusy,
  onToggle,
  variant,
}: {
  patch: WorkspacePatchRow;
  expandedPatchId: string | null;
  patchBody: string | null;
  patchDetailBusy: boolean;
  onToggle: (patchId: string) => void;
  variant: "task-linked" | "task-other" | "debug";
}) {
  const liClass =
    variant === "task-linked"
      ? "coord-review-patch-li coord-review-patch-li--task-linked"
      : variant === "debug"
        ? "coord-review-patch-li coord-review-patch-li--debug"
        : "coord-review-patch-li coord-review-patch-li--task-other";
  return (
    <li className={liClass}>
      <button
        type="button"
        className="btn-header-secondary coord-small-btn coord-review-patch-toggle"
        onClick={() => void onToggle(patch.patchId)}
      >
        {expandedPatchId === patch.patchId && patchBody !== null ? "Hide" : "View"} body
      </button>{" "}
      <code
        className={
          variant === "debug"
            ? "coord-review-patch-id coord-review-patch-id--debug"
            : variant === "task-linked"
              ? "coord-review-patch-id coord-review-patch-id--task-linked"
              : "coord-review-patch-id"
        }
      >
        {patch.patchId}
      </code>{" "}
      <span className="coord-badge">{patch.status}</span>
      {variant === "debug" ? (
        <span className="coord-badge coord-review-patch-kind-badge">Debug / system</span>
      ) : variant === "task-linked" ? (
        <span className="coord-badge coord-review-patch-kind-badge coord-review-patch-kind-badge--task">
          This run
        </span>
      ) : null}
      {expandedPatchId === patch.patchId && patchDetailBusy ? (
        <div className="muted small">Loading…</div>
      ) : expandedPatchId === patch.patchId && patchBody !== null ? (
        <pre className="coord-review-patch-pre">{patchBody}</pre>
      ) : null}
    </li>
  );
}

export function CoordinatorReviewPanel({
  storageAvailable,
  sharedWorkspaceKvPresent,
  selectedProjectId,
  selectedProject,
  tasks,
  runs,
  reviewExplicitRunId,
  reviewAnchorTaskId,
  onClearReview,
  onTaskUpdated,
  flash,
}: CoordinatorReviewPanelProps) {
  const [patches, setPatches] = useState<WorkspacePatchRow[] | null>(null);
  const [patchesErr, setPatchesErr] = useState<string | null>(null);
  const [patchesBusy, setPatchesBusy] = useState(false);
  const [expandedPatchId, setExpandedPatchId] = useState<string | null>(null);
  const [patchBody, setPatchBody] = useState<string | null>(null);
  const [patchDetailBusy, setPatchDetailBusy] = useState(false);
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [reviewReasonCategory, setReviewReasonCategory] = useState<CoordinatorReviewReasonCategory>("contract_mismatch");
  const [structuredNote, setStructuredNote] = useState("");

  const anchorTask = useMemo(
    () => (reviewAnchorTaskId ? tasks.find((t) => t.taskId === reviewAnchorTaskId) ?? null : null),
    [tasks, reviewAnchorTaskId]
  );

  const displayRun = useMemo((): CoordinatorRun | null => {
    if (reviewExplicitRunId) {
      return runs.find((r) => r.runId === reviewExplicitRunId) ?? null;
    }
    const lr = anchorTask?.lastRunId;
    if (!lr) return null;
    return runs.find((r) => r.runId === lr) ?? null;
  }, [runs, reviewExplicitRunId, anchorTask]);

  const taskForActions = useMemo((): CoordinatorTask | null => {
    if (anchorTask) return anchorTask;
    const tid = displayRun?.taskId;
    if (!tid) return null;
    return tasks.find((t) => t.taskId === tid) ?? null;
  }, [anchorTask, displayRun, tasks]);

  useEffect(() => {
    setStructuredNote("");
    setReviewReasonCategory("contract_mismatch");
  }, [taskForActions?.taskId]);

  const runLinkedPatchIds = useMemo(() => collectRunLinkedPatchIds(displayRun), [displayRun]);

  const { taskLinkedPatches, taskOtherPatches, debugPatches } = useMemo(() => {
    const list = patches ?? [];
    const taskLinked: WorkspacePatchRow[] = [];
    const taskOther: WorkspacePatchRow[] = [];
    const debugList: WorkspacePatchRow[] = [];
    for (const p of list) {
      if (isDebugSystemPatchId(p.patchId)) {
        debugList.push(p);
        continue;
      }
      if (runLinkedPatchIds.has(p.patchId)) taskLinked.push(p);
      else taskOther.push(p);
    }
    const cmp = (a: WorkspacePatchRow, b: WorkspacePatchRow) => a.patchId.localeCompare(b.patchId);
    taskLinked.sort(cmp);
    taskOther.sort(cmp);
    debugList.sort(cmp);
    return { taskLinkedPatches: taskLinked, taskOtherPatches: taskOther, debugPatches: debugList };
  }, [patches, runLinkedPatchIds]);

  const loadPatches = useCallback(async () => {
    if (!storageAvailable || !selectedProjectId || !sharedWorkspaceKvPresent) {
      setPatches(null);
      setPatchesErr(null);
      return;
    }
    setPatchesBusy(true);
    setPatchesErr(null);
    try {
      const { patches: list } = await listCoordinatorProjectWorkspacePatches(selectedProjectId);
      setPatches(list);
    } catch (e) {
      setPatches(null);
      setPatchesErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPatchesBusy(false);
    }
  }, [storageAvailable, selectedProjectId, sharedWorkspaceKvPresent]);

  useEffect(() => {
    void loadPatches();
  }, [loadPatches, displayRun?.runId]);

  const openPatchBody = useCallback(
    async (patchId: string) => {
      if (!selectedProjectId) return;
      if (expandedPatchId === patchId && patchBody !== null) {
        setExpandedPatchId(null);
        setPatchBody(null);
        return;
      }
      setPatchDetailBusy(true);
      setExpandedPatchId(patchId);
      setPatchBody(null);
      try {
        const { record } = await getCoordinatorProjectWorkspacePatch(selectedProjectId, patchId);
        setPatchBody(record.body);
      } catch (e) {
        setPatchBody(`(error) ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setPatchDetailBusy(false);
      }
    },
    [selectedProjectId, expandedPatchId, patchBody]
  );

  const mirrorReviewToRun = useCallback(
    async (snapshot: {
      reviewDecision: "approved" | "needs_revision" | "blocked";
      reviewReasonCategory: CoordinatorReviewReasonCategory;
      reviewDecisionNote: string;
      reviewedAt: string;
    }) => {
      const rid = displayRun?.runId;
      if (!rid) return;
      try {
        await patchCoordinatorRun(rid, snapshot);
      } catch {
        /* best-effort audit mirror */
      }
    },
    [displayRun?.runId]
  );

  const applyLegacyTaskStatus = useCallback(
    async (status: CoordinatorTask["status"]) => {
      const t = taskForActions;
      if (!t || !storageAvailable) {
        flash("No task linked to this review selection.", "error");
        return;
      }
      setReviewActionBusy(true);
      try {
        await patchCoordinatorTask(t.taskId, { status });
        flash(`Task set to ${status}.`);
        onTaskUpdated();
      } catch (e) {
        flash(e instanceof Error ? e.message : "Update failed", "error");
      } finally {
        setReviewActionBusy(false);
      }
    },
    [taskForActions, storageAvailable, flash, onTaskUpdated]
  );

  const submitApproveStructured = useCallback(async () => {
    const t = taskForActions;
    if (!t || !storageAvailable) {
      flash("No task linked to this review selection.", "error");
      return;
    }
    const reviewedAt = new Date().toISOString();
    setReviewActionBusy(true);
    try {
      await patchCoordinatorTask(t.taskId, {
        status: "done",
        operatorRevisionNote: "",
        reviewDecision: "approved",
        reviewReasonCategory: "operator_preference",
        reviewDecisionNote: "",
        reviewedAt,
      });
      await mirrorReviewToRun({
        reviewDecision: "approved",
        reviewReasonCategory: "operator_preference",
        reviewDecisionNote: "",
        reviewedAt,
      });
      flash("Task approved and marked done.", "success");
      onTaskUpdated();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setReviewActionBusy(false);
    }
  }, [taskForActions, storageAvailable, flash, onTaskUpdated, mirrorReviewToRun]);

  const submitNeedsRevision = useCallback(async () => {
    const t = taskForActions;
    const note = structuredNote.trim();
    if (!t || !storageAvailable) {
      flash("No task linked to this review selection.", "error");
      return;
    }
    if (!note) {
      flash("Add rerun guidance for the agent (required).", "error");
      return;
    }
    const reviewedAt = new Date().toISOString();
    setReviewActionBusy(true);
    try {
      await patchCoordinatorTask(t.taskId, {
        status: "todo",
        reviewDecision: "needs_revision",
        reviewReasonCategory,
        reviewDecisionNote: note,
        operatorRevisionNote: note,
        reviewedAt,
      });
      await mirrorReviewToRun({
        reviewDecision: "needs_revision",
        reviewReasonCategory,
        reviewDecisionNote: note,
        reviewedAt,
      });
      flash("Task returned to todo with structured review; next run will include your note.", "success");
      setStructuredNote("");
      onTaskUpdated();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setReviewActionBusy(false);
    }
  }, [
    taskForActions,
    storageAvailable,
    structuredNote,
    reviewReasonCategory,
    flash,
    onTaskUpdated,
    mirrorReviewToRun,
  ]);

  const submitBlockedStructured = useCallback(async () => {
    const t = taskForActions;
    const note = structuredNote.trim();
    if (!t || !storageAvailable) {
      flash("No task linked to this review selection.", "error");
      return;
    }
    if (!note) {
      flash("Add a note explaining the block (required).", "error");
      return;
    }
    const reviewedAt = new Date().toISOString();
    setReviewActionBusy(true);
    try {
      await patchCoordinatorTask(t.taskId, {
        status: "blocked",
        reviewDecision: "blocked",
        reviewReasonCategory,
        reviewDecisionNote: note,
        operatorRevisionNote: "",
        reviewedAt,
      });
      await mirrorReviewToRun({
        reviewDecision: "blocked",
        reviewReasonCategory,
        reviewDecisionNote: note,
        reviewedAt,
      });
      flash("Task marked blocked. Autonomy will not pick it until status changes.", "success");
      setStructuredNote("");
      onTaskUpdated();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setReviewActionBusy(false);
    }
  }, [
    taskForActions,
    storageAvailable,
    structuredNote,
    reviewReasonCategory,
    flash,
    onTaskUpdated,
    mirrorReviewToRun,
  ]);

  const evidence = displayRun?.iterationEvidence;
  const legacyIterations = displayRun?.iterationSummaries;

  return (
    <section className="coord-panel coord-review-panel" aria-labelledby="coord-review-title">
      <div className="coord-panel-head">
        <h3 className="coord-panel-title" id="coord-review-title">
          Run &amp; review evidence
        </h3>
        {(reviewExplicitRunId || reviewAnchorTaskId) && (
          <button type="button" className="btn-header-secondary coord-small-btn" onClick={onClearReview}>
            Clear selection
          </button>
        )}
      </div>

      {!selectedProjectId || !selectedProject ? (
        <p className="muted">Select a project to review runs and workspace patches.</p>
      ) : !storageAvailable ? (
        <p className="muted">Control-plane KV is not available.</p>
      ) : (
        <>
          <p className="muted small coord-review-intro">
            Open evidence from a task row (<strong>Review run</strong>) or from the <strong>Runs</strong> tab (
            <strong>Open review</strong>). Inspect loop outcome, per-iteration coder/tester metrics, patch ids, and
            shared-workspace patch records, then mark the task done or send it back for more work.
          </p>

          {!displayRun ? (
            <div className="coord-review-empty muted">
              <p>No run selected.</p>
              <ul className="coord-review-hint-list">
                <li>
                  On a task with a <strong>last run</strong>, click <strong>Review run</strong>.
                </li>
                <li>
                  On the <strong>Runs</strong> tab, click <strong>Open review</strong> for a row.
                </li>
              </ul>
            </div>
          ) : (
            <div className="coord-review-body">
              <div className="coord-review-meta">
                <div>
                  <span className="coord-review-meta-label">Run id</span>{" "}
                  <code className="coord-task-meta">{displayRun.runId}</code>
                </div>
                <div>
                  <span className="coord-review-meta-label">Task</span>{" "}
                  {displayRun.taskId ? (
                    <code className="coord-task-meta">{displayRun.taskId}</code>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <div>
                  <span className="coord-review-meta-label">Loop outcome</span>{" "}
                  <code>{displayRun.finalStatus ?? displayRun.loopTerminalStatus ?? "—"}</code>
                </div>
                <div>
                  <span className="coord-review-meta-label">Lifecycle</span>{" "}
                  {displayRun.runLifecycleStatus ? (
                    <span className="coord-badge">{displayRun.runLifecycleStatus}</span>
                  ) : (
                    "—"
                  )}
                </div>
                <div>
                  <span className="coord-review-meta-label">Tester verdict chain</span>{" "}
                  <span>{formatVerdictChain(displayRun.verdictSummary)}</span>
                </div>
                <div>
                  <span className="coord-review-meta-label">Patch ids (run)</span>{" "}
                  {displayRun.patchIds?.length ? (
                    <span className="coord-review-run-patch-ids">{formatPatchIdInlineList(displayRun.patchIds)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <div>
                  <span className="coord-review-meta-label">Follow-up tasks</span>{" "}
                  {displayRun.followUpTaskIds?.length ? (
                    <ul className="coord-run-verdict-list">
                      {displayRun.followUpTaskIds.map((id) => (
                        <li key={id}>
                          <code>{id}</code>{" "}
                          <span className="muted small">{tasks.find((x) => x.taskId === id)?.title ?? ""}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">None recorded</span>
                  )}
                </div>
              </div>

              {displayRun.summaryForUser?.trim() ? (
                <div className="coord-review-block">
                  <h4 className="coord-review-subtitle">Summary for operator</h4>
                  <pre className="coord-review-summary-pre">{displayRun.summaryForUser}</pre>
                </div>
              ) : null}

              <div className="coord-review-block">
                <h4 className="coord-review-subtitle">Per-iteration evidence</h4>
                {evidence && evidence.length > 0 ? (
                  <div className="coord-table-wrap">
                    <table className="tasks-table coord-review-evidence-table">
                      <thead>
                        <tr>
                          <th className="tasks-th tasks-th-type">#</th>
                          <th className="tasks-th tasks-th-title">Coder</th>
                          <th className="tasks-th tasks-th-title">Tester</th>
                          <th className="tasks-th tasks-th-type">Verdict</th>
                          <th className="tasks-th tasks-th-title">Manager</th>
                          <th className="tasks-th tasks-th-title">Patches</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidence.map((row: CoordinatorRunIterationEvidence) => (
                          <tr key={row.iteration}>
                            <td className="tasks-td tasks-td-type">{row.iteration}</td>
                            <td className="tasks-td tasks-td-title">
                              <span className="muted small">{turnLine(row.coder)}</span>
                            </td>
                            <td className="tasks-td tasks-td-title">
                              <span className="muted small">{turnLine(row.tester)}</span>
                            </td>
                            <td className="tasks-td tasks-td-type">
                              <code>{row.testerVerdict ?? "—"}</code>
                            </td>
                            <td className="tasks-td tasks-td-title">
                              <code className="muted small">{row.managerDecision ?? "—"}</code>
                            </td>
                            <td className="tasks-td tasks-td-title">
                              <div className="muted small">new: {(row.newPendingPatchIds ?? []).join(", ") || "—"}</div>
                              <div className="muted small">
                                active: {(row.activePatchIdsForIteration ?? []).join(", ") || "—"}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : legacyIterations && legacyIterations.length > 0 ? (
                  <ul className="coord-run-verdict-list">
                    {legacyIterations.map((s) => (
                      <li key={s.iteration}>
                        <span className="coord-run-verdict-iter">#{s.iteration}</span> tester{" "}
                        <code>{s.testerVerdict ?? "—"}</code>
                        {s.managerDecision ? (
                          <span className="muted small"> · mgr {s.managerDecision}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">No iteration evidence stored for this run (older run row).</p>
                )}
              </div>

              <div className="coord-review-block">
                <h4 className="coord-review-subtitle">
                  Shared workspace (project <code>{selectedProject.sharedProjectId}</code>)
                </h4>
                <p className="muted small coord-review-patch-legend">
                  <span className="coord-review-legend-task">Task / coder patches</span>
                  {" · "}
                  <span className="coord-review-legend-debug">Debug / system scaffolding</span> (e.g.{" "}
                  <code>debug-orch-success</code>) — review labels only; patch application is unchanged.
                </p>
                {!sharedWorkspaceKvPresent ? (
                  <p className="muted small">SHARED_WORKSPACE_KV is not bound on this Worker.</p>
                ) : patchesBusy ? (
                  <p className="muted small">Loading patches…</p>
                ) : patchesErr ? (
                  <p className="coord-form-error">{patchesErr}</p>
                ) : patches && patches.length === 0 ? (
                  <p className="muted small">No patch proposals in KV for this shared project id.</p>
                ) : (
                  <div className="coord-review-patch-groups">
                    <div className="coord-review-patch-section coord-review-patch-section--task">
                      <h5 className="coord-review-patch-section-title">Task patches</h5>
                      <p className="muted small coord-review-patch-section-intro">
                        Patches from the coding loop for this review run (excluding debug scaffold ids). Linked ids
                        match <strong>run patch ids</strong> or <strong>per-iteration evidence</strong> for{" "}
                        <code>{displayRun.runId}</code>
                        {displayRun.taskId ? (
                          <>
                            {" "}
                            (task <code>{displayRun.taskId}</code>
                            {reviewAnchorTaskId && reviewAnchorTaskId === displayRun.taskId
                              ? ", current review anchor"
                              : ""}
                            )
                          </>
                        ) : null}
                        .
                      </p>
                      {taskLinkedPatches.length === 0 && taskOtherPatches.length === 0 ? (
                        <p className="muted small">No non-debug patches in workspace KV for this project.</p>
                      ) : (
                        <>
                          {taskLinkedPatches.length > 0 ? (
                            <ul className="coord-review-patch-list" aria-label="Task patches linked to this run">
                              {taskLinkedPatches.map((p) => (
                                <CoordinatorReviewPatchListRow
                                  key={p.patchId}
                                  patch={p}
                                  expandedPatchId={expandedPatchId}
                                  patchBody={patchBody}
                                  patchDetailBusy={patchDetailBusy}
                                  onToggle={openPatchBody}
                                  variant="task-linked"
                                />
                              ))}
                            </ul>
                          ) : (
                            <p className="muted small">
                              No workspace rows match this run&rsquo;s patch ids yet; see other proposals below if
                              any.
                            </p>
                          )}
                          {taskOtherPatches.length > 0 ? (
                            <>
                              <h6 className="coord-review-patch-subheading">Other workspace patches</h6>
                              <p className="muted small coord-review-patch-section-intro">
                                Present in KV for this shared project but not listed on this run&rsquo;s evidence (may
                                be from other tasks or older runs).
                              </p>
                              <ul className="coord-review-patch-list" aria-label="Other workspace patches">
                                {taskOtherPatches.map((p) => (
                                  <CoordinatorReviewPatchListRow
                                    key={p.patchId}
                                    patch={p}
                                    expandedPatchId={expandedPatchId}
                                    patchBody={patchBody}
                                    patchDetailBusy={patchDetailBusy}
                                    onToggle={openPatchBody}
                                    variant="task-other"
                                  />
                                ))}
                              </ul>
                            </>
                          ) : null}
                        </>
                      )}
                    </div>

                    {debugPatches.length > 0 ? (
                      <details className="coord-review-debug-details">
                        <summary className="coord-review-debug-summary">
                          Debug / system patches ({debugPatches.length}) — collapsed by default
                        </summary>
                        <p className="muted small coord-review-patch-section-intro">
                          Harness / orchestration patch records (not the main deliverable for the task).
                        </p>
                        <ul className="coord-review-patch-list" aria-label="Debug and system patches">
                          {debugPatches.map((p) => (
                            <CoordinatorReviewPatchListRow
                              key={p.patchId}
                              patch={p}
                              expandedPatchId={expandedPatchId}
                              patchBody={patchBody}
                              patchDetailBusy={patchDetailBusy}
                              onToggle={openPatchBody}
                              variant="debug"
                            />
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="coord-review-actions">
                <span className="coord-review-actions-label">Structured review</span>
                {taskForActions ? (
                  <>
                    <span className="muted small">
                      Target: <strong>{taskForActions.title}</strong> (<code>{taskForActions.taskId}</code>) — status{" "}
                      <code>{taskForActions.status}</code>
                    </span>
                    {taskForActions.reviewDecision ? (
                      <div className="coord-review-revision-persisted">
                        <span className="coord-review-meta-label">Last review on task</span>
                        <div className="muted small">
                          <strong>{taskForActions.reviewDecision}</strong>
                          {taskForActions.reviewReasonCategory ? (
                            <>
                              {" "}
                              · reason: <code>{taskForActions.reviewReasonCategory}</code> (
                              {formatReviewReasonLabel(taskForActions.reviewReasonCategory)})
                            </>
                          ) : null}
                          {taskForActions.reviewedAt ? (
                            <>
                              {" "}
                              · <time dateTime={taskForActions.reviewedAt}>{taskForActions.reviewedAt}</time>
                            </>
                          ) : null}
                        </div>
                        {taskForActions.reviewDecisionNote?.trim() ? (
                          <pre className="coord-review-revision-pre">{taskForActions.reviewDecisionNote.trim()}</pre>
                        ) : null}
                      </div>
                    ) : null}
                    {taskForActions.operatorRevisionNote?.trim() ? (
                      <div className="coord-review-revision-persisted">
                        <span className="coord-review-meta-label">Operator rerun note (next orchestration)</span>
                        <pre className="coord-review-revision-pre">{taskForActions.operatorRevisionNote.trim()}</pre>
                      </div>
                    ) : null}

                    <div className="coord-review-structured-form">
                      <label className="coord-review-revision-label" htmlFor="coord-review-reason">
                        Review reason category
                      </label>
                      <select
                        id="coord-review-reason"
                        className="coord-review-reason-select"
                        value={reviewReasonCategory}
                        onChange={(e) => setReviewReasonCategory(e.target.value as CoordinatorReviewReasonCategory)}
                        disabled={reviewActionBusy}
                      >
                        {REVIEW_REASON_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <label className="coord-review-revision-label" htmlFor="coord-review-structured-note">
                        Note (required for send-back or block)
                      </label>
                      <textarea
                        id="coord-review-structured-note"
                        className="coord-review-revision-textarea"
                        rows={4}
                        value={structuredNote}
                        onChange={(e) => setStructuredNote(e.target.value)}
                        placeholder="For send-back: agent rerun guidance (also saved as audit note). For block: explain why work must stop."
                        disabled={reviewActionBusy}
                      />
                      <div className="coord-review-structured-buttons">
                        <button
                          type="button"
                          className="btn-primary coord-small-btn"
                          disabled={reviewActionBusy}
                          onClick={() => void submitApproveStructured()}
                        >
                          Approve as done
                        </button>
                        <button
                          type="button"
                          className="btn-header-secondary coord-small-btn"
                          disabled={reviewActionBusy || !structuredNote.trim()}
                          onClick={() => void submitNeedsRevision()}
                        >
                          Send back for revision (→ todo)
                        </button>
                        <button
                          type="button"
                          className="btn-header-secondary coord-small-btn"
                          disabled={reviewActionBusy || !structuredNote.trim()}
                          onClick={() => void submitBlockedStructured()}
                        >
                          Mark blocked
                        </button>
                      </div>
                    </div>

                    <details className="coord-review-legacy-status">
                      <summary className="muted small">Legacy status-only moves</summary>
                      <p className="muted small">
                        These update status only (no structured review fields). Prefer the actions above for audit
                        trails.
                      </p>
                      <div className="coord-review-action-buttons">
                        <button
                          type="button"
                          className="btn-header-secondary coord-small-btn"
                          disabled={reviewActionBusy}
                          onClick={() => void applyLegacyTaskStatus("todo")}
                        >
                          Set status: todo
                        </button>
                        <button
                          type="button"
                          className="btn-header-secondary coord-small-btn"
                          disabled={reviewActionBusy}
                          onClick={() => void applyLegacyTaskStatus("in_progress")}
                        >
                          Set status: in progress
                        </button>
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="muted small">Link a task (use <strong>Review run</strong> on a task row) to enable review actions.</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
