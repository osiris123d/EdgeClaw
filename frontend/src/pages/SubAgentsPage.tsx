import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { AgentClient } from "../lib/agentClient";
import {
  appendCoordinatorRun,
  createCoordinatorTask,
  deleteCoordinatorProject,
  deleteCoordinatorTask,
  getCoordinatorAiGatewayRunLogs,
  getCoordinatorProjectGatewayUsageBatch,
  getCoordinatorSubagentGatewayUsage,
  getCoordinatorHealth,
  getCoordinatorProject,
  listCoordinatorProjects,
  listCoordinatorRuns,
  listCoordinatorTasks,
  patchCoordinatorProject,
  postCoordinatorBlueprintTemplates,
  postCoordinatorProjectFinalize,
  postCoordinatorProjectMaterializeJson,
  postCoordinatorProjectMaterializePreview,
  postCoordinatorProjectMaterializeZip,
  postImportCoordinatorRoadmap,
} from "../lib/coordinatorControlPlaneApi";
import { CoordinatorReviewPanel } from "../components/coordinator/CoordinatorReviewPanel";
import { EditCoordinatorTaskDialog } from "../components/coordinator/EditCoordinatorTaskDialog";
import { ProjectBlueprintDialog } from "../components/coordinator/ProjectBlueprintDialog";
import type {
  CoordinatorAiGatewayRollup,
  CoordinatorAiGatewayRunLogsResponse,
  CoordinatorHealthResponse,
  CoordinatorMaterializeMappingPreset,
  CoordinatorMaterializePreviewResponse,
  CoordinatorSubagentGatewayUsageResponse,
} from "../lib/coordinatorControlPlaneApi";
import type {
  CoordinatorProject,
  CoordinatorRun,
  CoordinatorRunIterationSummary,
  CoordinatorRunIterationEvidence,
  CoordinatorSubagentTurnAuditEntry,
  CoordinatorTask,
} from "../types/coordinatorControlPlane";
import { BLUEPRINT_FILE_KEYS } from "../types/coordinatorControlPlane";
import { OrchestrationSystemHealthBar } from "../components/orchestration/OrchestrationSystemHealthBar";
import {
  OrchestrationConsoleTab,
  type OrchestrationPresetId,
} from "../components/orchestration/OrchestrationConsoleTab";
import {
  buildProjectAutonomySearchParams,
  httpOrchestrationModeFromPrimary,
  stopsFromExecutionMode,
  type ExecutionStopMode,
  type PrimaryRunMode,
} from "../components/orchestration/projectAutonomyQuery";

type TabId = "overview" | "monitor" | "registry" | "runs" | "orchestration";
type MonitorSubTab = "sessions" | "agents" | "timeline" | "projects" | "review";

interface Banner {
  kind: "success" | "error";
  message: string;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "—";
  return `$${cost.toFixed(4)}`;
}

function projectDisplayName(p: CoordinatorProject): string {
  return p.projectName?.trim() || p.title?.trim() || "Untitled";
}

function readinessBadgeClass(r: CoordinatorProject["readiness"] | undefined): string {
  if (r === "ready") return "coord-badge coord-badge-ok";
  if (r === "incomplete") return "coord-badge coord-badge-warn";
  return "coord-badge";
}

/** Matches server {@link assertTaskRunnableForProject} — todo / in_progress / review only. */
function coordinatorTaskRunnableForOrchestration(t: CoordinatorTask): boolean {
  return t.status === "todo" || t.status === "in_progress" || t.status === "review";
}

function displayTaskSource(t: CoordinatorTask): string {
  return t.taskSource ?? "manual";
}

/** Compact operator-review signals for the tasks table (legacy rows may omit). */
function taskReviewAuditCell(t: CoordinatorTask): ReactNode {
  const parts: ReactNode[] = [];
  if (t.status === "review") {
    parts.push(
      <span key="rv" className="coord-badge coord-badge-warn" title="Awaiting operator review">
        in review
      </span>
    );
  }
  if (t.reviewDecision === "needs_revision" && (t.status === "todo" || t.status === "in_progress")) {
    parts.push(
      <span key="nr" className="coord-badge" title={t.reviewedAt ? `Reviewed ${t.reviewedAt}` : undefined}>
        returned
      </span>
    );
  }
  if (t.reviewDecision === "blocked") {
    parts.push(
      <span key="opb" className="coord-badge coord-badge-warn" title="Blocked via structured review">
        op blocked
      </span>
    );
  } else if (t.status === "blocked") {
    parts.push(
      <span key="blk" className="coord-badge coord-badge-warn" title="Blocked (orchestration or operator)">
        blocked
      </span>
    );
  }
  if (t.reviewDecision === "approved" && t.status === "done") {
    parts.push(
      <span key="ap" className="coord-badge coord-badge-ok" title={t.reviewedAt ? `Reviewed ${t.reviewedAt}` : undefined}>
        approved
      </span>
    );
  }
  if (parts.length === 0) return <span className="muted">—</span>;
  return <div className="coord-task-review-badges">{parts}</div>;
}

/** Pretty-print stored verdict chains (`fail→pass`) for narrow table cells. */
function formatVerdictSummaryForDisplay(s: string | null | undefined): string {
  if (s == null || s === "") return "—";
  return s.replace(/\u2192/g, " → ");
}

function summarizeVerdicts(body: Record<string, unknown>): string | undefined {
  const v = body.verdicts;
  if (!Array.isArray(v)) return undefined;
  return v
    .map((x: unknown) => {
      const o = x as Record<string, unknown>;
      return typeof o.verdict === "string" ? o.verdict : "?";
    })
    .join(" → ");
}

function extractIterationSummaries(body: Record<string, unknown>): CoordinatorRunIterationSummary[] | undefined {
  const it = body.iterations;
  if (!Array.isArray(it)) return undefined;
  const out: CoordinatorRunIterationSummary[] = [];
  for (const x of it) {
    const o = x as Record<string, unknown>;
    const iteration = Number(o.iteration);
    if (Number.isNaN(iteration)) continue;
    out.push({
      iteration,
      testerVerdict: typeof o.testerVerdict === "string" ? o.testerVerdict : undefined,
      managerDecision: typeof o.managerDecision === "string" ? o.managerDecision : undefined,
    });
  }
  return out.length ? out : undefined;
}

function extractIterationEvidence(body: Record<string, unknown>): CoordinatorRunIterationEvidence[] | undefined {
  const it = body.iterations;
  if (!Array.isArray(it)) return undefined;
  const out: CoordinatorRunIterationEvidence[] = [];
  for (const x of it) {
    const o = x as Record<string, unknown>;
    const iteration = Number(o.iteration);
    if (Number.isNaN(iteration)) continue;
    const cs = o.coderSummary as Record<string, unknown> | undefined;
    const ts = o.testerSummary as Record<string, unknown> | undefined;
    if (!cs || !ts) continue;
    out.push({
      iteration,
      coder: {
        ok: Boolean(cs.ok),
        textLen: Number(cs.textLen) || 0,
        eventCount: Number(cs.eventCount) || 0,
        ...(typeof cs.error === "string" ? { error: cs.error } : {}),
      },
      tester: {
        ok: Boolean(ts.ok),
        textLen: Number(ts.textLen) || 0,
        eventCount: Number(ts.eventCount) || 0,
        ...(typeof ts.error === "string" ? { error: ts.error } : {}),
      },
      testerVerdict: typeof o.testerVerdict === "string" ? o.testerVerdict : undefined,
      managerDecision: typeof o.managerDecision === "string" ? o.managerDecision : undefined,
      newPendingPatchIds: Array.isArray(o.newPendingPatchIds)
        ? o.newPendingPatchIds.filter((id): id is string => typeof id === "string")
        : [],
      activePatchIdsForIteration: Array.isArray(o.activePatchIdsForIteration)
        ? o.activePatchIdsForIteration.filter((id): id is string => typeof id === "string")
        : [],
    });
  }
  return out.length ? out : undefined;
}

function orchestrateResponseToRun(
  sessionId: string,
  projectId: string,
  source: CoordinatorRun["source"],
  body: unknown
): CoordinatorRun {
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const startedAt = typeof o.startedAt === "string" ? o.startedAt : new Date().toISOString();
  const patchIds = Array.isArray(o.patchIds)
    ? o.patchIds.filter((p): p is string => typeof p === "string")
    : undefined;
  const iterationCount = typeof o.iterations === "object" && Array.isArray(o.iterations)
    ? o.iterations.length
    : undefined;
  const taskIdUsed = typeof o.taskIdUsed === "string" && o.taskIdUsed.trim() ? o.taskIdUsed.trim() : undefined;
  const coordinatorPathUsed =
    typeof o.coordinatorPathUsed === "boolean" ? o.coordinatorPathUsed : undefined;
  const followUpFromMeta = Array.isArray(o.followUpTasksCreated)
    ? o.followUpTasksCreated.filter((id): id is string => typeof id === "string")
    : undefined;
  const iterationEvidence = extractIterationEvidence(o);
  return {
    runId: crypto.randomUUID(),
    projectId,
    ...(taskIdUsed ? { taskId: taskIdUsed } : {}),
    sessionId,
    source,
    startedAt,
    finishedAt: new Date().toISOString(),
    finalStatus: typeof o.status === "string" ? o.status : undefined,
    iterationCount,
    patchIds,
    verdictSummary: summarizeVerdicts(o),
    ...(coordinatorPathUsed !== undefined ? { coordinatorPathUsed } : {}),
    iterationSummaries: extractIterationSummaries(o),
    ...(typeof o.summaryForUser === "string" && o.summaryForUser.trim()
      ? { summaryForUser: o.summaryForUser }
      : {}),
    ...(iterationEvidence ? { iterationEvidence } : {}),
    ...(followUpFromMeta?.length ? { followUpTaskIds: followUpFromMeta } : {}),
  };
}

export interface SubAgentsPageProps {
  /** WebSocket URL for the MainAgent session (same as Chat). */
  wsEndpoint: string;
  sessionId: string;
}

export function SubAgentsPage({ wsEndpoint, sessionId }: SubAgentsPageProps) {
  const [tab, setTab] = useState<TabId>("overview");
  const [monitorSubTab, setMonitorSubTab] = useState<MonitorSubTab>("sessions");
  const [health, setHealth] = useState<CoordinatorHealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [projects, setProjects] = useState<CoordinatorProject[]>([]);
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [runs, setRuns] = useState<CoordinatorRun[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CoordinatorTask[]>([]);
  /** Per-project task counts for Monitor / Overview (best-effort; requires KV). */
  const [projectTaskCounts, setProjectTaskCounts] = useState<Record<string, number>>({});
  const [projectTaskCountsLoading, setProjectTaskCountsLoading] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [roadmapImportBusy, setRoadmapImportBusy] = useState(false);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [bootstrapRunFirstTask, setBootstrapRunFirstTask] = useState(false);
  const [bootstrapLog, setBootstrapLog] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [debugToken, setDebugToken] = useState("");
  const [primaryRunMode, setPrimaryRunMode] = useState<PrimaryRunMode>("success");
  const [executionStopMode, setExecutionStopMode] = useState<ExecutionStopMode>("completion");
  const [autonomyBatchMaxSteps, setAutonomyBatchMaxSteps] = useState(3);
  const [debugChildStateless, setDebugChildStateless] = useState(false);
  const [debugNoSharedTools, setDebugNoSharedTools] = useState(false);
  const [orchCodingLoopMaxIterations, setOrchCodingLoopMaxIterations] = useState("");
  const [debugAttachControlPlaneProject, setDebugAttachControlPlaneProject] = useState(true);
  const [selectedOrchestrationTaskId, setSelectedOrchestrationTaskId] = useState<string | null>(null);
  const [minimalChildStateless, setMinimalChildStateless] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugResult, setDebugResult] = useState<string | null>(null);
  const [finalizeAckHumanReview, setFinalizeAckHumanReview] = useState(false);
  const [finalizePersistManifest, setFinalizePersistManifest] = useState(false);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeResult, setFinalizeResult] = useState<string | null>(null);
  const [materializeBusy, setMaterializeBusy] = useState(false);
  const [materializePreviewBusy, setMaterializePreviewBusy] = useState(false);
  const [materializeMappingPreset, setMaterializeMappingPreset] =
    useState<CoordinatorMaterializeMappingPreset>("none");
  const [materializePreview, setMaterializePreview] = useState<CoordinatorMaterializePreviewResponse | null>(null);
  const [blueprintDialogOpen, setBlueprintDialogOpen] = useState(false);
  const [blueprintDialogMode, setBlueprintDialogMode] = useState<"create" | "edit">("create");
  const [taskBeingEdited, setTaskBeingEdited] = useState<CoordinatorTask | null>(null);
  const [reviewExplicitRunId, setReviewExplicitRunId] = useState<string | null>(null);
  const [reviewAnchorTaskId, setReviewAnchorTaskId] = useState<string | null>(null);
  /** Session row expanded on Monitor → Sessions. */
  const [expandedMonitorSessionId, setExpandedMonitorSessionId] = useState<string | null>(null);
  /** After navigating from session detail — highlight row on Runs tab. */
  const [runsHighlightRunId, setRunsHighlightRunId] = useState<string | null>(null);
  /** Runs tab: show AI Gateway + persisted sub-agent audit for this run. */
  const [runsInspectorRunId, setRunsInspectorRunId] = useState<string | null>(null);
  const [gatewayLogs, setGatewayLogs] = useState<CoordinatorAiGatewayRunLogsResponse | null>(null);
  const [gatewayLogsBusy, setGatewayLogsBusy] = useState(false);
  /** Monitor → Projects: AI Gateway rollup per registry project (`metadata.project`). */
  const [monitorProjectGatewayById, setMonitorProjectGatewayById] = useState<
    Record<string, CoordinatorAiGatewayRollup | undefined>
  >({});
  const [monitorProjectGatewayLoading, setMonitorProjectGatewayLoading] = useState(false);
  const [monitorProjectGatewayBatchError, setMonitorProjectGatewayBatchError] = useState<string | null>(null);
  /** Monitor → Agents: AI Gateway rollup by `metadata.agent` (CoderAgent / TesterAgent). */
  const [monitorSubagentGateway, setMonitorSubagentGateway] =
    useState<CoordinatorSubagentGatewayUsageResponse | null>(null);
  const [monitorSubagentGatewayLoading, setMonitorSubagentGatewayLoading] = useState(false);
  const [monitorSubagentGatewayError, setMonitorSubagentGatewayError] = useState<string | null>(null);
  const [rpcStatus, setRpcStatus] = useState<"idle" | "connecting" | "connected" | "disconnected">("idle");
  const rpcClientRef = useRef<AgentClient | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string, kind: Banner["kind"] = "success") => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, message });
    bannerTimer.current = setTimeout(() => setBanner(null), 4_000);
  }, []);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const h = await getCoordinatorHealth();
      setHealth(h);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Health load failed", "error");
    } finally {
      setHealthLoading(false);
    }
  }, [flash]);

  const loadRegistry = useCallback(async () => {
    setRegistryLoading(true);
    try {
      const { projects: p, storageAvailable: sa } = await listCoordinatorProjects();
      setProjects(p);
      setStorageAvailable(sa);
      setSelectedProjectId((prev) => {
        if (prev && p.some((x) => x.projectId === prev)) return prev;
        return p[0]?.projectId ?? null;
      });
    } catch (e) {
      flash(e instanceof Error ? e.message : "Projects load failed", "error");
    } finally {
      setRegistryLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    setMonitorProjectGatewayById((prev) => {
      const allowed = new Set(projects.map((p) => p.projectId));
      const next: Record<string, CoordinatorAiGatewayRollup | undefined> = {};
      for (const id of allowed) {
        if (prev[id] !== undefined) next[id] = prev[id];
      }
      return next;
    });
  }, [projects]);

  const refreshMonitorProjectGatewayUsage = useCallback(async () => {
    const ids = projects.map((p) => p.projectId);
    if (ids.length === 0) {
      flash("No registry projects to query.", "error");
      return;
    }
    setMonitorProjectGatewayLoading(true);
    setMonitorProjectGatewayBatchError(null);
    try {
      const res = await getCoordinatorProjectGatewayUsageBatch(ids);
      if (!res.ok) {
        setMonitorProjectGatewayBatchError(res.error);
        flash(res.error, "error");
        return;
      }
      const next: Record<string, CoordinatorAiGatewayRollup | undefined> = {};
      for (const id of ids) {
        next[id] = res.projects[id];
      }
      setMonitorProjectGatewayById(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMonitorProjectGatewayBatchError(msg);
      flash(msg, "error");
    } finally {
      setMonitorProjectGatewayLoading(false);
    }
  }, [projects, flash]);

  const refreshMonitorSubagentGatewayUsage = useCallback(async () => {
    setMonitorSubagentGatewayLoading(true);
    setMonitorSubagentGatewayError(null);
    try {
      const res = await getCoordinatorSubagentGatewayUsage();
      if (!res.ok) {
        setMonitorSubagentGatewayError(res.error);
        flash(res.error, "error");
        return;
      }
      setMonitorSubagentGateway(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMonitorSubagentGatewayError(msg);
      flash(msg, "error");
    } finally {
      setMonitorSubagentGatewayLoading(false);
    }
  }, [flash]);

  const loadTasks = useCallback(
    async (projectId: string | null) => {
      if (!projectId) {
        setTasks([]);
        return;
      }
      try {
        const { tasks: t } = await listCoordinatorTasks(projectId);
        setTasks(t);
      } catch (e) {
        flash(e instanceof Error ? e.message : "Tasks load failed", "error");
      }
    },
    [flash]
  );

  const createNewTask = useCallback(async () => {
    if (!selectedProjectId || !storageAvailable) return;
    const tid = `task-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await createCoordinatorTask({
        taskId: tid,
        projectId: selectedProjectId,
        title: "New task",
        description: "",
        assignedRole: "coordinator",
        status: "todo",
        acceptanceCriteria: "",
        taskSource: "manual",
      });
      flash("Task created.");
      await loadTasks(selectedProjectId);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Create failed", "error");
    }
  }, [selectedProjectId, storageAvailable, flash, loadTasks]);

  const handleImportRoadmap = useCallback(async () => {
    if (!selectedProjectId || !storageAvailable) return;
    setRoadmapImportBusy(true);
    try {
      const r = await postImportCoordinatorRoadmap(selectedProjectId);
      if (!r.ok) {
        flash(r.error ?? "ROADMAP import failed", "error");
        return;
      }
      const warn = r.warnings.length ? ` — ${r.warnings.join(" · ")}` : "";
      flash(`ROADMAP.md → tasks: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped.${warn}`);
      await loadTasks(selectedProjectId);
    } catch (e) {
      flash(e instanceof Error ? e.message : "ROADMAP import failed", "error");
    } finally {
      setRoadmapImportBusy(false);
    }
  }, [selectedProjectId, storageAvailable, flash, loadTasks]);

  const appendBootstrapLog = useCallback((line: string) => {
    setBootstrapLog((prev) => (prev ? `${prev}\n` : "") + line);
  }, []);

  const runBootstrapSelectedProject = useCallback(async () => {
    if (!selectedProjectId || !storageAvailable) {
      flash("Select a project (control-plane KV required).", "error");
      return;
    }
    const proj = projects.find((p) => p.projectId === selectedProjectId) ?? null;
    if (!proj) {
      flash("Selected project not found in registry — reload projects.", "error");
      return;
    }
    setBootstrapBusy(true);
    setBootstrapLog("");
    const pid = selectedProjectId;
    const name = projectDisplayName(proj);
    const slug = proj.projectSlug;

    try {
      appendBootstrapLog("Step 1/4 — Generate blueprint templates (all docs + fingerprints, schema v2 includes FILE_STRUCTURE.md)…");
      const { blueprint } = await postCoordinatorBlueprintTemplates({
        projectName: name,
        projectSlug: slug,
      });

      appendBootstrapLog("Step 2/4 — Apply blueprint to project (PATCH)…");
      const patched = await patchCoordinatorProject(pid, { blueprint });
      appendBootstrapLog(
        `   → readiness: ${patched.readiness}` +
          (patched.validationErrors?.length ? ` | ${patched.validationErrors.join("; ")}` : "")
      );
      await loadRegistry();

      appendBootstrapLog("Step 3/4 — Import ROADMAP.md → tasks…");
      const imp = await postImportCoordinatorRoadmap(pid);
      if (!imp.ok) {
        const errMsg = imp.error ?? "ROADMAP import failed";
        appendBootstrapLog(`ERROR: ${errMsg}`);
        throw new Error(errMsg);
      }
      appendBootstrapLog(
        `   → tasks: ${imp.created} created, ${imp.updated} updated, ${imp.skipped} skipped` +
          (imp.warnings.length ? ` | warnings: ${imp.warnings.join("; ")}` : "")
      );
      await loadTasks(pid);

      appendBootstrapLog("Step 4/4 — Reload project (readiness)…");
      const { project: finalProj } = await getCoordinatorProject(pid);
      appendBootstrapLog(
        `   → readiness: ${finalProj.readiness}` +
          (finalProj.validationErrors?.length ? ` | ${finalProj.validationErrors.join("; ")}` : "")
      );

      let autonomyFailed = false;
      if (bootstrapRunFirstTask) {
        if (!health?.debugOrchestrationEndpointEnabled) {
          appendBootstrapLog(
            "Optional — Skipped: debug orchestration is disabled on this Worker (ENABLE_DEBUG_ORCHESTRATION_ENDPOINT)."
          );
        } else if (finalProj.readiness !== "ready") {
          appendBootstrapLog("Optional — Skipped: project is not ready; fix validation errors first.");
        } else {
          appendBootstrapLog("Optional — GET /api/debug/project-autonomy (maxSteps=1)…");
          setDebugBusy(true);
          setDebugResult(null);
          try {
            const q = buildProjectAutonomySearchParams({
              sessionId,
              projectId: pid,
              maxSteps: 1,
              mode: httpOrchestrationModeFromPrimary(primaryRunMode),
              stops: stopsFromExecutionMode(executionStopMode),
              debugChildStateless,
              debugNoSharedTools,
              selectedOrchestrationTaskId: null,
              orchCodingLoopMaxIterations,
            });
            const headers: Record<string, string> = { Accept: "application/json" };
            const tok = debugToken.trim();
            if (tok) headers.Authorization = `Bearer ${tok}`;
            const res = await fetch(`/api/debug/project-autonomy?${q}`, { method: "GET", headers });
            const text = await res.text();
            let body: unknown = text;
            try {
              body = text ? (JSON.parse(text) as unknown) : text;
            } catch {
              body = text;
            }
            setDebugResult(typeof body === "string" ? body : JSON.stringify(body, null, 2));
            if (res.ok) {
              const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
              const sr = typeof o.stopReason === "string" ? o.stopReason : "?";
              const se = typeof o.stepsExecuted === "number" ? o.stepsExecuted : "?";
              appendBootstrapLog(`   → autonomy: stopReason=${sr}, stepsExecuted=${se}`);
              await loadTasks(pid);
            } else {
              autonomyFailed = true;
              const errMsg =
                typeof body === "object" && body !== null && "error" in body
                  ? String((body as { error: unknown }).error)
                  : `HTTP ${res.status}`;
              console.error("[EdgeClaw] bootstrap GET /api/debug/project-autonomy failed", {
                status: res.status,
                error: errMsg,
                responseBody: body,
              });
              appendBootstrapLog(`   → autonomy failed: HTTP ${res.status} — ${errMsg.slice(0, 200)}`);
            }
          } finally {
            setDebugBusy(false);
          }
        }
      }

      await loadRegistry();
      flash(
        autonomyFailed
          ? "Bootstrap finished; autonomy step failed — see log and Orchestration › Run results."
          : "Bootstrap finished — see log below.",
        autonomyFailed ? "error" : "success"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendBootstrapLog(`ERROR: ${msg}`);
      flash(msg, "error");
    } finally {
      setBootstrapBusy(false);
    }
  }, [
    selectedProjectId,
    projects,
    storageAvailable,
    health,
    bootstrapRunFirstTask,
    sessionId,
    debugToken,
    primaryRunMode,
    executionStopMode,
    debugChildStateless,
    debugNoSharedTools,
    orchCodingLoopMaxIterations,
    appendBootstrapLog,
    loadRegistry,
    loadTasks,
    flash,
  ]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const { runs: r } = await listCoordinatorRuns(80);
      setRuns(r);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Runs load failed", "error");
    } finally {
      setRunsLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void loadHealth();
    void loadRegistry();
  }, [loadHealth, loadRegistry]);

  useEffect(() => {
    if ((tab === "runs" || tab === "registry" || tab === "monitor" || tab === "overview") && storageAvailable) {
      void loadRuns();
    }
  }, [tab, storageAvailable, loadRuns]);

  useEffect(() => {
    if (tab !== "runs" || !runsHighlightRunId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`coord-run-row-${runsHighlightRunId}`)?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [tab, runsHighlightRunId, runs]);

  useEffect(() => {
    if (!runsInspectorRunId) {
      setGatewayLogs(null);
      return;
    }
    let cancelled = false;
    setGatewayLogsBusy(true);
    setGatewayLogs(null);
    void getCoordinatorAiGatewayRunLogs(runsInspectorRunId, 50)
      .then((res) => {
        if (!cancelled) setGatewayLogs(res);
      })
      .catch((e) => {
        if (!cancelled) {
          setGatewayLogs({
            ok: false,
            runId: runsInspectorRunId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setGatewayLogsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runsInspectorRunId]);

  useEffect(() => {
    if (!storageAvailable || projects.length === 0) {
      setProjectTaskCounts({});
      setProjectTaskCountsLoading(false);
      return;
    }
    if (tab !== "overview" && tab !== "monitor") return;
    let cancelled = false;
    setProjectTaskCountsLoading(true);
    void (async () => {
      const counts: Record<string, number> = {};
      try {
        await Promise.all(
          projects.map(async (p) => {
            try {
              const { tasks: t } = await listCoordinatorTasks(p.projectId);
              if (!cancelled) counts[p.projectId] = t.length;
            } catch {
              if (!cancelled) counts[p.projectId] = 0;
            }
          })
        );
        if (!cancelled) setProjectTaskCounts(counts);
      } finally {
        if (!cancelled) setProjectTaskCountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, storageAvailable, projects]);

  useEffect(() => {
    if ((tab === "registry" || tab === "orchestration") && selectedProjectId) void loadTasks(selectedProjectId);
  }, [tab, selectedProjectId, loadTasks]);

  useEffect(() => {
    setSelectedOrchestrationTaskId(null);
  }, [selectedProjectId]);

  useEffect(() => {
    setMaterializePreview(null);
  }, [materializeMappingPreset, selectedProjectId]);

  useEffect(
    () => () => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
      rpcClientRef.current?.disconnect();
      rpcClientRef.current = null;
    },
    []
  );

  const connectRpc = useCallback(() => {
    if (rpcClientRef.current) {
      rpcClientRef.current.disconnect();
      rpcClientRef.current = null;
    }
    setRpcStatus("connecting");
    const c = new AgentClient({
      url: wsEndpoint,
      onStatusChange: (s) => {
        if (s === "connected") setRpcStatus("connected");
        else if (s === "disconnected") setRpcStatus("disconnected");
        else if (s === "reconnecting") setRpcStatus("connecting");
        else setRpcStatus("connecting");
      },
    });
    rpcClientRef.current = c;
    c.connect();
  }, [wsEndpoint]);

  const disconnectRpc = useCallback(() => {
    rpcClientRef.current?.disconnect();
    rpcClientRef.current = null;
    setRpcStatus("idle");
  }, []);

  const runDebugHttp = useCallback(
    async (path: "orchestrate" | "coordinator-chain" | "delegated-ping", mode?: "success" | "fail_revise") => {
      setDebugBusy(true);
      setDebugResult(null);
      try {
        const q = new URLSearchParams({ session: sessionId });
        if (path === "orchestrate") {
          q.set("mode", mode ?? httpOrchestrationModeFromPrimary(primaryRunMode));
          if (debugChildStateless) {
            q.set("childTurn", "stateless");
          }
          if (debugNoSharedTools) q.set("noSharedTools", "true");
          if (debugAttachControlPlaneProject && selectedProjectId) {
            const sp = projects.find((x) => x.projectId === selectedProjectId);
            if (sp?.readiness === "ready") {
              q.set("projectId", selectedProjectId);
              if (selectedOrchestrationTaskId?.trim()) {
                q.set("taskId", selectedOrchestrationTaskId.trim());
              }
            }
          }
        }
        const headers: Record<string, string> = { Accept: "application/json" };
        const t = debugToken.trim();
        if (t) headers.Authorization = `Bearer ${t}`;
        const res = await fetch(`/api/debug/${path}?${q}`, { method: "GET", headers });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = text ? (JSON.parse(text) as unknown) : text;
        } catch {
          body = text;
        }
        setDebugResult(typeof body === "string" ? body : JSON.stringify(body, null, 2));

        if (!res.ok) {
          const errMsg =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error: unknown }).error)
              : `HTTP ${res.status}`;
          console.error(`[EdgeClaw] GET /api/debug/${path} failed`, {
            status: res.status,
            statusText: res.statusText,
            error: errMsg,
            responseBody: body,
          });
        }

        if (res.ok && storageAvailable && path === "orchestrate" && typeof body === "object" && body !== null) {
          const o = body as Record<string, unknown>;
          if (o.controlPlaneRunRecorded === true) {
            void loadRuns();
          } else {
            const projFromResp =
              typeof o.projectIdUsed === "string" && o.projectIdUsed.trim() ? o.projectIdUsed.trim() : null;
            const proj = projFromResp ?? selectedProjectId ?? projects[0]?.projectId;
            if (proj) {
              try {
                const run = orchestrateResponseToRun(sessionId, proj, "debug_http_orchestrate", body);
                await appendCoordinatorRun(run);
                void loadRuns();
              } catch {
                /* append optional */
              }
            }
          }
        }
      } catch (e) {
        setDebugResult(e instanceof Error ? e.message : String(e));
      } finally {
        setDebugBusy(false);
      }
    },
    [
      sessionId,
      debugToken,
      primaryRunMode,
      debugChildStateless,
      debugNoSharedTools,
      storageAvailable,
      debugAttachControlPlaneProject,
      selectedProjectId,
      selectedOrchestrationTaskId,
      projects,
      loadRuns,
    ]
  );

  const runRpcOrchestrate = useCallback(async () => {
    const c = rpcClientRef.current;
    if (!c || rpcStatus !== "connected") {
      flash("Connect RPC first.", "error");
      return;
    }
    setDebugBusy(true);
    setDebugResult(null);
    try {
      const payload: {
        mode: string;
        debugOrchestrationToken?: string;
        childTurn?: string;
        noSharedTools?: boolean;
        projectId?: string;
        taskId?: string;
        sessionId?: string;
      } = { mode: httpOrchestrationModeFromPrimary(primaryRunMode), sessionId };
      const t = debugToken.trim();
      if (t) payload.debugOrchestrationToken = t;
      if (debugChildStateless) {
        payload.childTurn = "stateless";
      }
      if (debugNoSharedTools) payload.noSharedTools = true;
      if (debugAttachControlPlaneProject && selectedProjectId) {
        const sp = projects.find((x) => x.projectId === selectedProjectId);
        if (sp?.readiness === "ready") {
          payload.projectId = selectedProjectId;
          if (selectedOrchestrationTaskId?.trim()) {
            payload.taskId = selectedOrchestrationTaskId.trim();
          }
        }
      }
      const raw = await c.callCallable("debugRunOrchestrationRpc", [payload]);
      setDebugResult(JSON.stringify(raw, null, 2));
      if (storageAvailable && raw && typeof raw === "object" && (raw as Record<string, unknown>).controlPlaneRunRecorded === true) {
        void loadRuns();
      }
    } catch (e) {
      setDebugResult(e instanceof Error ? e.message : String(e));
    } finally {
      setDebugBusy(false);
    }
  }, [
    primaryRunMode,
    debugToken,
    debugChildStateless,
    debugNoSharedTools,
    debugAttachControlPlaneProject,
    selectedProjectId,
    selectedOrchestrationTaskId,
    projects,
    rpcStatus,
    flash,
    storageAvailable,
    loadRuns,
    sessionId,
  ]);

  const runRpcProbe = useCallback(
    async (which: "a" | "b1" | "c" | "ping") => {
      const c = rpcClientRef.current;
      if (!c || rpcStatus !== "connected") {
        flash("Connect RPC first.", "error");
        return;
      }
      setDebugBusy(true);
      setDebugResult(null);
      try {
        let raw: unknown;
        if (which === "a") {
          const payload: { message: string; debugOrchestrationToken?: string } = { message: "hello" };
          const t = debugToken.trim();
          if (t) payload.debugOrchestrationToken = t;
          raw = await c.callCallable("debugChatChildBaselineFromMainRpc", [payload]);
        } else if (which === "b1") {
          raw = await c.callCallable("debugSmokeDelegateCoder", ["coder smoke probe"]);
        } else if (which === "c") {
          const payload: { message: string; debugOrchestrationToken?: string; stateless?: boolean } = {
            message: "[debug] minimal delegation probe — reply briefly.",
          };
          const t = debugToken.trim();
          if (t) payload.debugOrchestrationToken = t;
          if (minimalChildStateless) payload.stateless = true;
          raw = await c.callCallable("debugDelegateMinimalChildLikeCoderRpc", [payload]);
        } else {
          const payload: { debugOrchestrationToken?: string } = {};
          const t = debugToken.trim();
          if (t) payload.debugOrchestrationToken = t;
          raw = await c.callCallable("debugDelegatedChildPingRpc", [payload]);
        }
        setDebugResult(JSON.stringify(raw, null, 2));
      } catch (e) {
        setDebugResult(e instanceof Error ? e.message : String(e));
      } finally {
        setDebugBusy(false);
      }
    },
    [rpcStatus, debugToken, flash, minimalChildStateless]
  );

  const selectedProject = projects.find((p) => p.projectId === selectedProjectId) ?? null;

  const openRunReview = useCallback((runId: string) => {
    setReviewExplicitRunId(runId);
    setReviewAnchorTaskId(null);
    setMonitorSubTab("review");
    setTab("monitor");
  }, []);

  const goToRunInRunsTab = useCallback((runId: string) => {
    setRunsHighlightRunId(runId);
    setTab("runs");
  }, []);

  const runsBySessionId = useMemo(() => {
    const m = new Map<string, CoordinatorRun[]>();
    for (const r of runs) {
      const arr = m.get(r.sessionId) ?? [];
      arr.push(r);
      m.set(r.sessionId, arr);
    }
    for (const arr of m.values()) {
      arr.sort(
        (a, b) =>
          new Date(b.finishedAt ?? b.startedAt).getTime() -
          new Date(a.finishedAt ?? a.startedAt).getTime()
      );
    }
    return m;
  }, [runs]);

  const orchestrateAttachBlocked =
    debugAttachControlPlaneProject &&
    !!selectedProjectId &&
    !!selectedProject &&
    selectedProject.readiness !== "ready";

  const selectedOrchestrationTask = useMemo(() => {
    if (!selectedOrchestrationTaskId) return null;
    return tasks.find((t) => t.taskId === selectedOrchestrationTaskId) ?? null;
  }, [tasks, selectedOrchestrationTaskId]);

  const orchestrateTaskBlocksLaunch =
    debugAttachControlPlaneProject &&
    Boolean(selectedOrchestrationTaskId?.trim()) &&
    (!selectedOrchestrationTask || !coordinatorTaskRunnableForOrchestration(selectedOrchestrationTask));

  const orchestrateLaunchBlocked = orchestrateAttachBlocked || orchestrateTaskBlocksLaunch;

  const projectAutonomyBlocked =
    !selectedProjectId || !selectedProject || selectedProject.readiness !== "ready";

  const runProjectAutonomyHttp = useCallback(
    async (maxSteps: number) => {
      setDebugBusy(true);
      setDebugResult(null);
      try {
        if (!selectedProjectId || !selectedProject || selectedProject.readiness !== "ready") {
          flash("Select a registry project with readiness ready.", "error");
          return;
        }
        const q = buildProjectAutonomySearchParams({
          sessionId,
          projectId: selectedProjectId,
          maxSteps,
          mode: httpOrchestrationModeFromPrimary(primaryRunMode),
          stops: stopsFromExecutionMode(executionStopMode),
          debugChildStateless,
          debugNoSharedTools,
          selectedOrchestrationTaskId,
          orchCodingLoopMaxIterations,
        });
        const headers: Record<string, string> = { Accept: "application/json" };
        const t = debugToken.trim();
        if (t) headers.Authorization = `Bearer ${t}`;
        const res = await fetch(`/api/debug/project-autonomy?${q}`, { method: "GET", headers });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = text ? (JSON.parse(text) as unknown) : text;
        } catch {
          body = text;
        }
        setDebugResult(typeof body === "string" ? body : JSON.stringify(body, null, 2));
        if (!res.ok) {
          const errMsg =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error: unknown }).error)
              : "Project autonomy request failed";
          console.error("[EdgeClaw] GET /api/debug/project-autonomy failed", {
            status: res.status,
            statusText: res.statusText,
            error: errMsg,
            responseBody: body,
          });
          flash(errMsg, "error");
        } else if (storageAvailable && selectedProjectId) {
          void loadTasks(selectedProjectId);
        }
      } catch (e) {
        setDebugResult(e instanceof Error ? e.message : String(e));
      } finally {
        setDebugBusy(false);
      }
    },
    [
      sessionId,
      debugToken,
      primaryRunMode,
      executionStopMode,
      selectedProjectId,
      selectedProject,
      selectedOrchestrationTaskId,
      debugChildStateless,
      debugNoSharedTools,
      orchCodingLoopMaxIterations,
      storageAvailable,
      flash,
      loadTasks,
    ]
  );

  const runFinalizeProject = useCallback(async () => {
    if (!selectedProjectId?.trim()) {
      flash("Select a project first.", "error");
      return;
    }
    if (!finalizeAckHumanReview) {
      flash("Confirm the human-review acknowledgement checkbox.", "error");
      return;
    }
    setFinalizeBusy(true);
    try {
      const out = await postCoordinatorProjectFinalize(selectedProjectId.trim(), {
        persistManifest: finalizePersistManifest,
        operatorAcknowledgesHumanReviewRequired: true,
      });
      setFinalizeResult(JSON.stringify(out, null, 2));
      if (out.ok) {
        flash("Finalize manifest generated — review JSON before any promotion.", "success");
      } else {
        flash(`Finalize checklist failed (${out.readiness.reasons.length} issue(s)) — see response JSON.`, "error");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFinalizeResult(msg);
      flash(msg, "error");
    } finally {
      setFinalizeBusy(false);
    }
  }, [
    selectedProjectId,
    finalizeAckHumanReview,
    finalizePersistManifest,
    flash,
  ]);

  const runMaterializePreview = useCallback(async () => {
    if (!selectedProjectId?.trim()) {
      flash("Select a project first.", "error");
      return;
    }
    setMaterializePreviewBusy(true);
    try {
      const out = await postCoordinatorProjectMaterializePreview(selectedProjectId.trim(), {
        mappingPreset: materializeMappingPreset,
      });
      setMaterializePreview(out);
      flash(`Preview loaded (${out.previewRows.length} row(s); preset ${out.mapping.preset}).`, "success");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "error");
      setMaterializePreview(null);
    } finally {
      setMaterializePreviewBusy(false);
    }
  }, [selectedProjectId, materializeMappingPreset, flash]);

  const runMaterializeProjectZip = useCallback(async () => {
    if (!selectedProjectId?.trim()) {
      flash("Select a project first.", "error");
      return;
    }
    const proj = projects.find((p) => p.projectId === selectedProjectId) ?? null;
    setMaterializeBusy(true);
    try {
      const blob = await postCoordinatorProjectMaterializeZip(selectedProjectId.trim(), {
        mappingPreset: materializeMappingPreset,
      });
      const slug =
        proj?.projectSlug?.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "project";
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${slug}-materialized.zip`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      flash("ZIP downloaded — open MATERIALIZE_REPORT.json inside the archive for conflicts/skips.", "success");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setMaterializeBusy(false);
    }
  }, [selectedProjectId, projects, materializeMappingPreset, flash]);

  const runMaterializeProjectJson = useCallback(async () => {
    if (!selectedProjectId?.trim()) {
      flash("Select a project first.", "error");
      return;
    }
    const proj = projects.find((p) => p.projectId === selectedProjectId) ?? null;
    setMaterializeBusy(true);
    try {
      const out = await postCoordinatorProjectMaterializeJson(selectedProjectId.trim(), {
        mappingPreset: materializeMappingPreset,
      });
      const slug =
        proj?.projectSlug?.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "project";
      const blob = new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${slug}-materialized.json`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      flash(
        `JSON export downloaded (${out.fileCount} files; ${out.conflicts.length} conflicts; ${out.skipped.length} skips).`,
        "success"
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setMaterializeBusy(false);
    }
  }, [selectedProjectId, projects, materializeMappingPreset, flash]);

  const applyOrchestrationPreset = useCallback((id: OrchestrationPresetId) => {
    switch (id) {
      case "run_normal":
        setPrimaryRunMode("success");
        setExecutionStopMode("completion");
        setDebugChildStateless(false);
        setDebugNoSharedTools(false);
        setOrchCodingLoopMaxIterations("");
        setAutonomyBatchMaxSteps(3);
        break;
      case "single_step":
        setPrimaryRunMode("success");
        setExecutionStopMode("single_step");
        setAutonomyBatchMaxSteps(1);
        break;
      case "batch_three":
        setPrimaryRunMode("success");
        setExecutionStopMode("completion");
        setAutonomyBatchMaxSteps(3);
        break;
      default:
        break;
    }
  }, []);

  const overviewControlMetrics = useMemo(() => {
    const taskByStatus: Record<string, number> = {};
    for (const t of tasks) {
      taskByStatus[t.status] = (taskByStatus[t.status] ?? 0) + 1;
    }
    const runsSorted = [...runs].sort(
      (a, b) =>
        new Date(b.finishedAt ?? b.startedAt).getTime() -
        new Date(a.finishedAt ?? a.startedAt).getTime()
    );
    const lastSuccess = runsSorted.find((r) => (r.finalStatus ?? "").toLowerCase().includes("success"));
    const lastBlocked = runsSorted.find((r) =>
      /fail|blocked|abort|stopped/i.test(r.finalStatus ?? r.loopTerminalStatus ?? "")
    );
    const runByOutcome: Record<string, number> = {};
    for (const r of runs) {
      const k = r.finalStatus ?? r.loopTerminalStatus ?? "unknown";
      runByOutcome[k] = (runByOutcome[k] ?? 0) + 1;
    }
    return {
      projectCount: projects.length,
      taskByStatus,
      runCount: runs.length,
      lastSuccess,
      lastBlocked,
      runByOutcome,
    };
  }, [projects.length, tasks, runs]);

  const monitorSessions = useMemo(() => {
    const map = new Map<
      string,
      { sessionId: string; runCount: number; lastRun: CoordinatorRun; projectIds: Set<string> }
    >();
    for (const r of runs) {
      const cur = map.get(r.sessionId);
      if (!cur) {
        map.set(r.sessionId, {
          sessionId: r.sessionId,
          runCount: 1,
          lastRun: r,
          projectIds: new Set([r.projectId]),
        });
      } else {
        cur.runCount++;
        cur.projectIds.add(r.projectId);
        const ta = new Date(cur.lastRun.finishedAt ?? cur.lastRun.startedAt).getTime();
        const tb = new Date(r.finishedAt ?? r.startedAt).getTime();
        if (tb >= ta) cur.lastRun = r;
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        new Date(b.lastRun.finishedAt ?? b.lastRun.startedAt).getTime() -
        new Date(a.lastRun.finishedAt ?? a.lastRun.startedAt).getTime()
    );
  }, [runs]);

  const monitorAgentRollup = useMemo(() => {
    let coderTurns = 0;
    let testerTurns = 0;
    let coderChars = 0;
    let testerChars = 0;
    for (const r of runs) {
      for (const it of r.iterationEvidence ?? []) {
        coderTurns += 1;
        testerTurns += 1;
        coderChars += it.coder?.textLen ?? 0;
        testerChars += it.tester?.textLen ?? 0;
      }
    }
    return { coderTurns, testerTurns, coderChars, testerChars };
  }, [runs]);

  const monitorProjectRollup = useMemo(() => {
    const byId = new Map<string, { projectId: string; runCount: number; latest?: CoordinatorRun }>();
    for (const p of projects) {
      byId.set(p.projectId, { projectId: p.projectId, runCount: 0 });
    }
    for (const r of runs) {
      if (!byId.has(r.projectId)) {
        byId.set(r.projectId, { projectId: r.projectId, runCount: 0 });
      }
      const row = byId.get(r.projectId)!;
      row.runCount++;
      const cur = row.latest;
      const rt = new Date(r.finishedAt ?? r.startedAt).getTime();
      if (!cur || rt >= new Date(cur.finishedAt ?? cur.startedAt).getTime()) row.latest = r;
    }
    return projects
      .map((p) => ({
        project: p,
        rollup: byId.get(p.projectId) ?? { projectId: p.projectId, runCount: 0 },
      }))
      .sort((a, b) => (b.rollup.runCount ?? 0) - (a.rollup.runCount ?? 0));
  }, [projects, runs]);

  const monitorProjectsGatewayTotals = useMemo(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let totalCost = 0;
    let truncated = false;
    let hasLoaded = false;
    let loadErrorProjects = 0;
    for (const p of projects) {
      const r = monitorProjectGatewayById[p.projectId];
      if (r === undefined) continue;
      hasLoaded = true;
      if (r.ok) {
        tokensIn += r.tokensIn;
        tokensOut += r.tokensOut;
        totalCost += r.totalCost;
        truncated = truncated || r.truncated;
      } else {
        loadErrorProjects += 1;
      }
    }
    return { tokensIn, tokensOut, totalCost, truncated, hasLoaded, loadErrorProjects };
  }, [projects, monitorProjectGatewayById]);

  const monitorSubagentGatewayCombined = useMemo(() => {
    if (!monitorSubagentGateway) return null;
    const c = monitorSubagentGateway.CoderAgent;
    const t = monitorSubagentGateway.TesterAgent;
    if (!c.ok || !t.ok) return null;
    return {
      tokensIn: c.tokensIn + t.tokensIn,
      tokensOut: c.tokensOut + t.tokensOut,
      totalCost: c.totalCost + t.totalCost,
      truncated: c.truncated || t.truncated,
    };
  }, [monitorSubagentGateway]);

  const monitorTimeline = useMemo(() => {
    return [...runs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }, [runs]);

  const runBySource = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of runs) {
      m[r.source] = (m[r.source] ?? 0) + 1;
    }
    return m;
  }, [runs]);

  const totalRegistryTasks = useMemo(
    () => Object.values(projectTaskCounts).reduce((a, n) => a + n, 0),
    [projectTaskCounts]
  );

  return (
    <section className="page-shell coord-page">
      <header className="page-header">
        <div className="page-header-main">
          <h2>Sub-Agents</h2>
          <p className="subhead">
            Coordinator control plane — system health, project registry, run history, and the orchestration console.
            Chat stays on <strong>Chat</strong>; this page is for operators.
          </p>
        </div>
      </header>

      {banner && (
        <div
          className={`memory-banner memory-banner-${banner.kind === "success" ? "success" : "error"}`}
          role={banner.kind === "error" ? "alert" : "status"}
        >
          {banner.message}
        </div>
      )}

      <OrchestrationSystemHealthBar health={health} healthLoading={healthLoading} onRefresh={loadHealth} />

      <div className="memory-tab-bar" role="tablist" aria-label="Sub-agents sections">
        {(
    [
      ["overview", "Overview"],
      ["monitor", "Monitor"],
      ["registry", "Projects & tasks"],
      ["runs", "Runs"],
      ["orchestration", "Orchestration"],
    ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`memory-tab-btn${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="coord-tab-body-scroll">
      {tab === "overview" && (
        <div className="coord-section-stack">
          <section className="coord-panel">
            <h3 className="coord-panel-title">Coordinator health</h3>
            {health ? (
              <dl className="coord-dl">
                <dt>Promotion artifact writer</dt>
                <dd>{health.promotionArtifactWriterBranch}</dd>
                <dt>Promotion persistence</dt>
                <dd>{health.hasArtifactPromotionPersistence ? "Available" : "Not available"}</dd>
                <dt>Flagship evaluation branch</dt>
                <dd>{health.flagshipEvaluationBranch}</dd>
                <dt>Debug Bearer required</dt>
                <dd>{health.debugOrchestrationTokenConfigured ? "Yes (paste token for HTTP/RPC)" : "No"}</dd>
                <dt>Last coordinator-chain (HTTP)</dt>
                <dd>
                  {health.lastCoordinatorChain ? (
                    <>
                      {fmtDate(health.lastCoordinatorChain.completedAtIso)} — session{" "}
                      <code>{health.lastCoordinatorChain.session}</code> — HTTP{" "}
                      {health.lastCoordinatorChain.httpStatus}
                    </>
                  ) : (
                    <span className="muted">None recorded (run coordinator-chain debug or bind control-plane KV)</span>
                  )}
                </dd>
              </dl>
            ) : (
              <p className="muted">No health data.</p>
            )}
          </section>

          <section className="coord-panel">
            <h3 className="coord-panel-title">Control plane snapshot</h3>
            {!storageAvailable ? (
              <p className="muted">
                Bind <code>COORDINATOR_CONTROL_PLANE_KV</code> to populate local run/task history. Token and cost
                rollups for a run load via <code>GET /api/coordinator/ai-gateway/runs/:runId/logs</code> when the Worker
                has <code>CLOUDFLARE_API_TOKEN</code> and gateway targeting configured; model requests already attach{" "}
                <code>cf-aig-metadata</code> for that filter.
              </p>
            ) : (
              <div className="coord-monitor-overview-grid">
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Projects</span>
                  <span className="coord-stat-value">{overviewControlMetrics.projectCount}</span>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Recorded runs</span>
                  <span className="coord-stat-value">{overviewControlMetrics.runCount}</span>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Tasks (all projects)</span>
                  <span className="coord-stat-value">
                    {projectTaskCountsLoading ? "…" : totalRegistryTasks}
                  </span>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {projectTaskCountsLoading
                      ? "Loading per-project task counts…"
                      : "Summed from registry; status mix below is for the project selected in Projects & tasks."}
                  </div>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Tasks by status (selected project)</span>
                  <span className="coord-stat-value">{tasks.length}</span>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {Object.keys(overviewControlMetrics.taskByStatus).length === 0
                      ? "Select a project in Projects & tasks to load task rows."
                      : Object.entries(overviewControlMetrics.taskByStatus)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                  </div>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Runs by outcome</span>
                  <div className="muted small" style={{ marginTop: 4, lineHeight: 1.45 }}>
                    {Object.keys(overviewControlMetrics.runByOutcome).length === 0
                      ? "—"
                      : Object.entries(overviewControlMetrics.runByOutcome)
                          .sort((a, b) => b[1] - a[1])
                          .map(([k, v]) => (
                            <div key={k}>
                              <code>{k}</code>: {v}
                            </div>
                          ))}
                  </div>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Last successful run</span>
                  <span className="coord-stat-value" style={{ fontSize: "0.95rem" }}>
                    {overviewControlMetrics.lastSuccess
                      ? fmtDate(overviewControlMetrics.lastSuccess.finishedAt ?? overviewControlMetrics.lastSuccess.startedAt)
                      : "—"}
                  </span>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Last blocked / failed-ish run</span>
                  <span className="coord-stat-value" style={{ fontSize: "0.95rem" }}>
                    {overviewControlMetrics.lastBlocked
                      ? fmtDate(overviewControlMetrics.lastBlocked.finishedAt ?? overviewControlMetrics.lastBlocked.startedAt)
                      : "—"}
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="coord-panel coord-blueprint">
            <h3 className="coord-panel-title">Recommended project blueprint files</h3>
            <p className="muted">
              Blueprint bodies are stored in control-plane KV with each project. Use the registry to author and validate
              them before coordinator-backed runs.
            </p>
            <ul className="coord-blueprint-list">
              {BLUEPRINT_FILE_KEYS.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {tab === "monitor" && (
        <div className="coord-section-stack">
          <section className="coord-panel coord-monitor-landing">
            <h3 className="coord-panel-title">Monitor</h3>
            <p className="muted small">
              <strong>Sessions</strong> group stored coordinator runs by orchestration <code>sessionId</code>.{" "}
              <strong>Runs</strong> lists individual KV rows. Expand a session to see its runs, jump to the Runs tab,
              or open structured review when a task id is present. AI Gateway token/cost for a run is loaded from the
              Worker proxy on the Runs tab when <code>CLOUDFLARE_API_TOKEN</code> and gateway targeting are configured.
            </p>
          </section>
          <div className="coord-monitor-subtabs" role="tablist" aria-label="Monitor views">
            {(
              [
                ["sessions", "Sessions"],
                ["agents", "Agents"],
                ["timeline", "Timeline"],
                ["projects", "Projects"],
                ["review", "Review"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={monitorSubTab === id}
                className={`coord-monitor-subtab${monitorSubTab === id ? " is-active" : ""}`}
                onClick={() => setMonitorSubTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {monitorSubTab === "sessions" && (
            <section className="coord-panel">
              <h3 className="coord-panel-title">Sessions</h3>
              <p className="muted small">
                Aggregated from control-plane run history. Expand a session to list its runs, open review, or go to
                the Runs tab. Gateway usage uses metadata key <code>run</code> aligned with persisted{" "}
                <code>runId</code> on task-backed orchestration.
              </p>
              {monitorSessions.length === 0 ? (
                <div className="tasks-empty-state coord-empty">
                  <p>No sessions yet.</p>
                </div>
              ) : (
                <div className="coord-table-wrap">
                  <table className="tasks-table coord-sessions-table" aria-label="Sessions">
                    <thead>
                      <tr>
                        <th className="tasks-th tasks-th-type coord-sessions-th-expand" aria-label="Expand" />
                        <th className="tasks-th tasks-th-title">Session</th>
                        <th className="tasks-th tasks-th-type">Runs</th>
                        <th className="tasks-th tasks-th-type">Projects touched</th>
                        <th className="tasks-th tasks-th-type">Last run task</th>
                        <th className="tasks-th tasks-th-date">Last activity</th>
                        <th className="tasks-th tasks-th-type">Latest status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitorSessions.map((s) => {
                        const expanded = expandedMonitorSessionId === s.sessionId;
                        const sessionRuns = runsBySessionId.get(s.sessionId) ?? [];
                        return (
                          <Fragment key={s.sessionId}>
                            <tr className="tasks-row coord-session-row">
                              <td className="tasks-td tasks-td-type coord-sessions-td-expand">
                                <button
                                  type="button"
                                  className="coord-session-expand-btn"
                                  aria-expanded={expanded}
                                  aria-controls={`coord-session-detail-${s.sessionId}`}
                                  onClick={() =>
                                    setExpandedMonitorSessionId((cur) => (cur === s.sessionId ? null : s.sessionId))
                                  }
                                >
                                  {expanded ? "▼" : "▶"}
                                </button>
                              </td>
                              <td className="tasks-td tasks-td-title">
                                <code>{s.sessionId}</code>
                              </td>
                              <td className="tasks-td tasks-td-type">{s.runCount}</td>
                              <td className="tasks-td tasks-td-type">{s.projectIds.size}</td>
                              <td className="tasks-td tasks-td-type">
                                {s.lastRun.taskId ? (
                                  <code className="coord-task-meta">{s.lastRun.taskId}</code>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td className="tasks-td tasks-td-date">
                                {fmtDate(s.lastRun.finishedAt ?? s.lastRun.startedAt)}
                              </td>
                              <td className="tasks-td tasks-td-type">
                                <span className="coord-run-loop-outcome">
                                  {s.lastRun.finalStatus ?? s.lastRun.loopTerminalStatus ?? "—"}
                                </span>
                              </td>
                            </tr>
                            {expanded ? (
                              <tr key={`${s.sessionId}-detail`} className="coord-session-detail-row">
                                <td colSpan={7} className="coord-session-detail-cell">
                                  <div
                                    className="coord-session-detail-inner"
                                    id={`coord-session-detail-${s.sessionId}`}
                                    role="region"
                                  >
                                    <div className="coord-session-detail-toolbar">
                                      <span className="coord-session-detail-title">Runs in this session</span>
                                      {s.lastRun.taskId ? (
                                        <button
                                          type="button"
                                          className="btn-header-secondary coord-small-btn"
                                          onClick={() => openRunReview(s.lastRun.runId)}
                                        >
                                          Open review (last run)
                                        </button>
                                      ) : null}
                                    </div>
                                    {sessionRuns.length === 0 ? (
                                      <p className="muted small">No run rows for this session.</p>
                                    ) : (
                                      <div className="coord-table-wrap coord-session-runs-nested">
                                        <table className="tasks-table" aria-label={`Runs for session ${s.sessionId}`}>
                                          <thead>
                                            <tr>
                                              <th className="tasks-th tasks-th-date">Finished</th>
                                              <th className="tasks-th tasks-th-title">Run id</th>
                                              <th className="tasks-th tasks-th-type">Task</th>
                                              <th className="tasks-th tasks-th-type">Loop outcome</th>
                                              <th className="tasks-th tasks-th-actions">Actions</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {sessionRuns.map((r) => (
                                              <tr key={r.runId} className="tasks-row">
                                                <td className="tasks-td tasks-td-date">
                                                  {fmtDate(r.finishedAt ?? r.startedAt)}
                                                </td>
                                                <td className="tasks-td tasks-td-title">
                                                  <code className="coord-task-meta">{r.runId}</code>
                                                </td>
                                                <td className="tasks-td tasks-td-type">
                                                  {r.taskId ? (
                                                    <code className="coord-task-meta">{r.taskId}</code>
                                                  ) : (
                                                    <span className="muted">—</span>
                                                  )}
                                                </td>
                                                <td className="tasks-td tasks-td-type">
                                                  <span className="coord-run-loop-outcome">
                                                    {r.finalStatus ?? r.loopTerminalStatus ?? "—"}
                                                  </span>
                                                </td>
                                                <td className="tasks-td tasks-td-actions">
                                                  <div className="coord-session-run-actions">
                                                    <button
                                                      type="button"
                                                      className="btn-header-secondary coord-small-btn"
                                                      onClick={() => {
                                                        setRunsInspectorRunId(null);
                                                        goToRunInRunsTab(r.runId);
                                                      }}
                                                    >
                                                      View in Runs
                                                    </button>
                                                    {r.taskId ? (
                                                      <button
                                                        type="button"
                                                        className="btn-header-secondary coord-small-btn"
                                                        onClick={() => openRunReview(r.runId)}
                                                      >
                                                        Review
                                                      </button>
                                                    ) : null}
                                                  </div>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {monitorSubTab === "agents" && (
            <section className="coord-panel">
              <h3 className="coord-panel-title">Agents</h3>
              <p className="muted small">
                Sub-agent turns inferred from stored run iteration evidence (text length proxy, not token counts).
                MainAgent and coordinator do not persist per-call counts here yet.
              </p>
              <div className="coord-monitor-overview-grid">
                <div className="coord-stat-card">
                  <span className="coord-stat-label">MainAgent-linked runs (heuristic)</span>
                  <span className="coord-stat-value">
                    {runs.filter(
                      (r) =>
                        r.source === "debug_http_orchestrate" ||
                        r.source === "debug_rpc_orchestrate" ||
                        r.source === "manual"
                    ).length}
                  </span>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Count of stored runs whose <code>source</code> is typically MainAgent-led orchestration — not token
                    usage.
                  </p>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Coordinator</span>
                  <span className="coord-stat-value muted">—</span>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Workers AI path — not AI Gateway tagged in v1.
                  </p>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Coder turns (evidence)</span>
                  <span className="coord-stat-value">{monitorAgentRollup.coderTurns}</span>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Σ output chars ≈ {monitorAgentRollup.coderChars.toLocaleString()}
                  </p>
                </div>
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Tester turns (evidence)</span>
                  <span className="coord-stat-value">{monitorAgentRollup.testerTurns}</span>
                  <p className="muted small" style={{ marginTop: 6 }}>
                    Σ output chars ≈ {monitorAgentRollup.testerChars.toLocaleString()}
                  </p>
                </div>
              </div>

              <p style={{ marginTop: 20, marginBottom: 6 }}>
                <strong>AI Gateway usage</strong> (<code>metadata.agent</code>)
              </p>
              <p className="muted small" style={{ marginTop: 4 }}>
                Totals come from gateway logs filtered by agent class (CoderAgent / TesterAgent). Other traffic without
                that tag does not appear here; high-volume gateways may truncate unless you raise{" "}
                <code>maxPages</code> on the Worker.
              </p>
              <div className="coord-projects-toolbar" style={{ marginTop: 10, marginBottom: 12 }}>
                <button
                  type="button"
                  className="btn-header-secondary coord-small-btn"
                  disabled={monitorSubagentGatewayLoading}
                  onClick={() => void refreshMonitorSubagentGatewayUsage()}
                >
                  {monitorSubagentGatewayLoading ? "Loading gateway totals…" : "Refresh AI Gateway totals"}
                </button>
                {monitorSubagentGatewayError ? (
                  <span className="coord-badge coord-badge-warn" style={{ marginLeft: 8 }}>
                    {monitorSubagentGatewayError}
                  </span>
                ) : null}
              </div>
              <div className="coord-monitor-overview-grid">
                {(
                  [
                    ["CoderAgent", monitorSubagentGateway?.CoderAgent] as const,
                    ["TesterAgent", monitorSubagentGateway?.TesterAgent] as const,
                  ] as const
                ).map(([label, rollup]) => (
                  <div key={label} className="coord-stat-card">
                    <span className="coord-stat-label">{label}</span>
                    {!rollup ? (
                      <span className="coord-stat-value muted">—</span>
                    ) : !rollup.ok ? (
                      <span className="coord-stat-value coord-badge coord-badge-warn" title={rollup.hint}>
                        {rollup.error}
                      </span>
                    ) : (
                      <span className="coord-stat-value">{fmtUsd(rollup.totalCost)}</span>
                    )}
                    <p className="muted small" style={{ marginTop: 6 }}>
                      {rollup && rollup.ok ? (
                        <>
                          Tokens in: {rollup.tokensIn.toLocaleString()} · Tokens out:{" "}
                          {rollup.tokensOut.toLocaleString()}
                          {rollup.truncated ? (
                            <>
                              {" "}
                              · <span title="Paged gateway log fetch hit cap">partial *</span>
                            </>
                          ) : null}
                          {rollup.entryCount > 0 ? (
                            <>
                              {" "}
                              · {rollup.entryCount.toLocaleString()} log rows
                            </>
                          ) : null}
                        </>
                      ) : (
                        "Use Refresh to load gateway totals."
                      )}
                    </p>
                  </div>
                ))}
                <div className="coord-stat-card">
                  <span className="coord-stat-label">Coder + Tester (gateway)</span>
                  {!monitorSubagentGatewayCombined ? (
                    <span className="coord-stat-value muted">—</span>
                  ) : (
                    <span className="coord-stat-value">{fmtUsd(monitorSubagentGatewayCombined.totalCost)}</span>
                  )}
                  <p className="muted small" style={{ marginTop: 6 }}>
                    {monitorSubagentGatewayCombined ? (
                      <>
                        Tokens in: {monitorSubagentGatewayCombined.tokensIn.toLocaleString()} · Tokens out:{" "}
                        {monitorSubagentGatewayCombined.tokensOut.toLocaleString()}
                        {monitorSubagentGatewayCombined.truncated ? (
                          <>
                            {" "}
                            · <span title="At least one side hit page cap">partial *</span>
                          </>
                        ) : null}
                      </>
                    ) : monitorSubagentGateway?.CoderAgent && monitorSubagentGateway.TesterAgent ? (
                      <>
                        Combined total unavailable —
                        {!monitorSubagentGateway.CoderAgent.ok && !monitorSubagentGateway.TesterAgent.ok
                          ? " fix errors on both roles."
                          : !monitorSubagentGateway.CoderAgent.ok
                            ? " fix Coder error."
                            : " fix Tester error."}
                      </>
                    ) : (
                      "Use Refresh to load gateway totals."
                    )}
                  </p>
                </div>
              </div>

              <p className="muted small" style={{ marginTop: 16 }}>
                Runs by stored <code>source</code> (control-plane run records):
              </p>
              {Object.keys(runBySource).length === 0 ? (
                <p className="muted">No runs.</p>
              ) : (
                <ul className="coord-deps-list">
                  {Object.entries(runBySource)
                    .sort((a, b) => b[1] - a[1])
                    .map(([src, n]) => (
                      <li key={src}>
                        <code>{src}</code> — {n}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          )}

          {monitorSubTab === "timeline" && (
            <section className="coord-panel">
              <h3 className="coord-panel-title">Timeline</h3>
              <p className="muted small">Run starts from local history, newest first.</p>
              {monitorTimeline.length === 0 ? (
                <div className="tasks-empty-state coord-empty">
                  <p>No events.</p>
                </div>
              ) : (
                <ul className="coord-monitor-timeline">
                  {monitorTimeline.map((r) => (
                    <li key={r.runId} className="coord-monitor-timeline-item">
                      <div className="coord-monitor-timeline-ts">{fmtDate(r.startedAt)}</div>
                      <div>
                        <strong>Run</strong> <code>{r.runId.slice(0, 8)}…</code>{" "}
                        <span className="muted">project {r.projectId}</span>
                        {r.taskId ? (
                          <>
                            {" "}
                            · task <code>{r.taskId}</code>
                          </>
                        ) : null}
                        <div className="muted small">
                          {r.finalStatus ?? r.loopTerminalStatus ?? "—"} · session{" "}
                          <code>{r.sessionId}</code>
                          {r.iterationEvidence && r.iterationEvidence.length > 0 ? (
                            <> · iterations (evidence rows): {r.iterationEvidence.length}</>
                          ) : r.iterationCount != null ? (
                            <> · iterations: {r.iterationCount}</>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {monitorSubTab === "projects" && (
            <section className="coord-panel">
              <h3 className="coord-panel-title">Projects</h3>
              <p className="muted small">
                Run counts come from local coordinator history. AI Gateway totals use <code>metadata.project</code> on
                gateway requests — refresh to pull recent logs (MainAgent-only chat without that tag won’t roll up).
              </p>
              <div className="coord-projects-toolbar" style={{ marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn-header-secondary coord-small-btn"
                  disabled={monitorProjectGatewayLoading || projects.length === 0}
                  onClick={() => void refreshMonitorProjectGatewayUsage()}
                >
                  {monitorProjectGatewayLoading ? "Loading gateway usage…" : "Refresh AI Gateway usage"}
                </button>
                {monitorProjectGatewayBatchError ? (
                  <span className="coord-badge coord-badge-warn" style={{ marginLeft: 8 }}>
                    {monitorProjectGatewayBatchError}
                  </span>
                ) : null}
              </div>
              {monitorProjectsGatewayTotals.hasLoaded ? (
                <p className="muted small" style={{ marginBottom: 12 }}>
                  <strong>Overall (registry projects, gateway)</strong> — tokens in{" "}
                  {monitorProjectsGatewayTotals.tokensIn.toLocaleString()}, tokens out{" "}
                  {monitorProjectsGatewayTotals.tokensOut.toLocaleString()}, est. cost{" "}
                  {fmtUsd(monitorProjectsGatewayTotals.totalCost)}
                  {monitorProjectsGatewayTotals.truncated ? (
                    <span title="At least one project hit the log page cap"> · partial *</span>
                  ) : null}
                  {monitorProjectsGatewayTotals.loadErrorProjects > 0 ? (
                    <span>
                      {" "}
                      · {monitorProjectsGatewayTotals.loadErrorProjects} project
                      {monitorProjectsGatewayTotals.loadErrorProjects === 1 ? "" : "s"} failed (see row)
                    </span>
                  ) : null}
                </p>
              ) : (
                <p className="muted small" style={{ marginBottom: 12 }}>
                  Click <strong>Refresh AI Gateway usage</strong> to load per-project token and cost totals.
                </p>
              )}
              {monitorProjectRollup.length === 0 ? (
                <div className="tasks-empty-state coord-empty">
                  <p>No registry projects.</p>
                </div>
              ) : (
                <div className="coord-table-wrap">
                  <table className="tasks-table" aria-label="Project rollup">
                    <thead>
                      <tr>
                        <th className="tasks-th tasks-th-title">Project</th>
                        <th className="tasks-th tasks-th-type">Readiness</th>
                        <th className="tasks-th tasks-th-type">Tasks</th>
                        <th className="tasks-th tasks-th-type">Runs recorded</th>
                        <th className="tasks-th tasks-th-date">Latest run</th>
                        <th className="tasks-th tasks-th-type">Tokens in</th>
                        <th className="tasks-th tasks-th-type">Tokens out</th>
                        <th className="tasks-th tasks-th-type">Est. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitorProjectRollup.map(({ project, rollup }) => {
                        const gw = monitorProjectGatewayById[project.projectId];
                        return (
                          <tr key={project.projectId} className="tasks-row">
                            <td className="tasks-td tasks-td-title">
                              <strong>{projectDisplayName(project)}</strong>
                              <div className="muted small">
                                <code>{project.projectId}</code>
                              </div>
                            </td>
                            <td className="tasks-td tasks-td-type">
                              <span className={readinessBadgeClass(project.readiness)}>{project.readiness}</span>
                            </td>
                            <td className="tasks-td tasks-td-type">
                              {projectTaskCountsLoading ? "…" : projectTaskCounts[project.projectId] ?? "—"}
                            </td>
                            <td className="tasks-td tasks-td-type">{rollup.runCount}</td>
                            <td className="tasks-td tasks-td-date">
                              {rollup.latest
                                ? fmtDate(rollup.latest.finishedAt ?? rollup.latest.startedAt)
                                : "—"}
                            </td>
                            <td className="tasks-td tasks-td-type">
                              {gw === undefined ? (
                                <span className="muted">—</span>
                              ) : !gw.ok ? (
                                <span className="coord-badge coord-badge-warn" title={gw.hint}>
                                  {gw.error}
                                </span>
                              ) : (
                                <>
                                  {gw.tokensIn.toLocaleString()}
                                  {gw.truncated ? (
                                    <span className="muted" title="Partial sum — log paging cap">
                                      {" "}
                                      *
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </td>
                            <td className="tasks-td tasks-td-type">
                              {gw === undefined ? (
                                <span className="muted">—</span>
                              ) : !gw.ok ? (
                                <span className="coord-badge coord-badge-warn">—</span>
                              ) : (
                                <>
                                  {gw.tokensOut.toLocaleString()}
                                  {gw.truncated ? (
                                    <span className="muted" title="Partial sum — log paging cap">
                                      {" "}
                                      *
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </td>
                            <td className="tasks-td tasks-td-type">
                              {gw === undefined ? (
                                <span className="muted">—</span>
                              ) : !gw.ok ? (
                                <span className="coord-badge coord-badge-warn">—</span>
                              ) : (
                                <span title={gw.entryCount > 0 ? `${gw.entryCount} log rows` : undefined}>
                                  {fmtUsd(gw.totalCost)}
                                  {gw.truncated ? " *" : ""}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {monitorProjectsGatewayTotals.hasLoaded ? (
                      <tfoot>
                        <tr className="tasks-row">
                          <td className="tasks-td" colSpan={5}>
                            <strong>Overall</strong>
                            <span className="muted small" style={{ marginLeft: 8 }}>
                              Summed gateway rows above
                              {monitorProjectsGatewayTotals.truncated ? " (may be partial *)" : ""}
                            </span>
                          </td>
                          <td className="tasks-td tasks-td-type">
                            {monitorProjectsGatewayTotals.tokensIn.toLocaleString()}
                          </td>
                          <td className="tasks-td tasks-td-type">
                            {monitorProjectsGatewayTotals.tokensOut.toLocaleString()}
                          </td>
                          <td className="tasks-td tasks-td-type">{fmtUsd(monitorProjectsGatewayTotals.totalCost)}</td>
                        </tr>
                      </tfoot>
                    ) : null}
                  </table>
                </div>
              )}
            </section>
          )}

          {monitorSubTab === "review" && (
            <CoordinatorReviewPanel
              storageAvailable={storageAvailable}
              sharedWorkspaceKvPresent={health?.sharedWorkspaceKvPresent ?? false}
              selectedProjectId={selectedProjectId}
              selectedProject={selectedProject}
              tasks={tasks}
              runs={runs}
              reviewExplicitRunId={reviewExplicitRunId}
              reviewAnchorTaskId={reviewAnchorTaskId}
              onClearReview={() => {
                setReviewExplicitRunId(null);
                setReviewAnchorTaskId(null);
              }}
              onTaskUpdated={() => {
                if (selectedProjectId) void loadTasks(selectedProjectId);
                void loadRuns();
                void loadRegistry();
              }}
              flash={flash}
            />
          )}
        </div>
      )}

      {tab === "registry" && (
        <>
        <div className="coord-registry-layout">
          <section className="coord-panel coord-registry-projects">
            <div className="coord-panel-head">
              <h3 className="coord-panel-title">Projects</h3>
              {!storageAvailable && (
                <span className="coord-badge coord-badge-warn">KV not bound — read-only</span>
              )}
            </div>
            {!storageAvailable ? (
              <p className="muted">
                Bind <code>COORDINATOR_CONTROL_PLANE_KV</code> in wrangler to persist projects and tasks. Health still
                loads without it.
              </p>
            ) : null}
            <div className="coord-projects-toolbar">
              <button
                type="button"
                className="btn-header-secondary coord-small-btn"
                disabled={registryLoading || !storageAvailable}
                onClick={() => void loadRegistry()}
              >
                {registryLoading ? "Loading…" : "Reload"}
              </button>
              {storageAvailable ? (
                <button
                  type="button"
                  className="btn-primary coord-small-btn"
                  disabled={registryLoading}
                  onClick={() => {
                    setBlueprintDialogMode("create");
                    setBlueprintDialogOpen(true);
                  }}
                >
                  + New project
                </button>
              ) : null}
            </div>
            {projects.length === 0 ? (
              <div className="tasks-empty-state coord-empty">
                <p>No projects yet.</p>
                {storageAvailable ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => {
                      setBlueprintDialogMode("create");
                      setBlueprintDialogOpen(true);
                    }}
                  >
                    + New project
                  </button>
                ) : null}
              </div>
            ) : (
              <ul className="coord-project-list">
                {projects.map((p) => (
                  <li key={p.projectId} className="coord-project-row">
                    <button
                      type="button"
                      className={`coord-project-pick${selectedProjectId === p.projectId ? " is-active" : ""}`}
                      onClick={() => setSelectedProjectId(p.projectId)}
                    >
                      <strong>{projectDisplayName(p)}</strong>
                      <span className={readinessBadgeClass(p.readiness)} title="Blueprint readiness">
                        {p.readiness ?? "—"}
                      </span>
                      <span className="muted">{p.projectSlug}</span>
                      <span className="muted">{p.projectId}</span>
                    </button>
                    {storageAvailable ? (
                      <>
                        <button
                          type="button"
                          className="btn-header-secondary coord-small-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedProjectId(p.projectId);
                            setBlueprintDialogMode("edit");
                            setBlueprintDialogOpen(true);
                          }}
                        >
                          Blueprint
                        </button>
                        <button
                          type="button"
                          className="btn-text-danger coord-project-delete"
                          onClick={async () => {
                            if (!confirm(`Delete project ${p.projectId} and its tasks?`)) return;
                            try {
                              await deleteCoordinatorProject(p.projectId);
                              flash("Project deleted.");
                              await loadRegistry();
                            } catch (e) {
                              flash(e instanceof Error ? e.message : "Delete failed", "error");
                            }
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="coord-panel">
            <div className="coord-bootstrap-operator">
              <h4 className="coord-bootstrap-title">Bootstrap project</h4>
              <p className="muted coord-bootstrap-help">
                One shot: generate the standard blueprint templates including <code>FILE_STRUCTURE.md</code> (same as{" "}
                <code>POST /api/coordinator/blueprint-templates</code>), <code>PATCH</code> them onto this project,
                import <code>ROADMAP.md</code> into tasks, reload readiness, then optionally run a single bounded
                autonomy step (<code>GET /api/debug/project-autonomy?maxSteps=1</code> — uses orchestration token and
                execution settings on the Orchestration tab). Progress appears here; banners toast success or failure.
              </p>
              <div className="coord-bootstrap-actions">
                <label className="coord-bootstrap-checkbox">
                  <input
                    type="checkbox"
                    checked={bootstrapRunFirstTask}
                    onChange={(e) => setBootstrapRunFirstTask(e.target.checked)}
                    disabled={bootstrapBusy}
                  />
                  After import, if readiness is <strong>ready</strong> and the orchestration HTTP route is enabled,
                  run <strong>one</strong> coordinator step (see Orchestration › Run results).
                </label>
                <button
                  type="button"
                  className="btn-primary coord-bootstrap-run"
                  disabled={
                    !storageAvailable ||
                    !selectedProjectId ||
                    !projects.some((p) => p.projectId === selectedProjectId) ||
                    bootstrapBusy ||
                    roadmapImportBusy ||
                    registryLoading
                  }
                  title={
                    !storageAvailable
                      ? "Control-plane KV not bound"
                      : !selectedProjectId || !projects.some((p) => p.projectId === selectedProjectId)
                        ? "Select a project in the list"
                        : "Templates → PATCH project → import ROADMAP → validate → optional autonomy"
                  }
                  onClick={() => void runBootstrapSelectedProject()}
                >
                  {bootstrapBusy ? "Bootstrapping…" : "Run bootstrap"}
                </button>
              </div>
              {bootstrapLog ? (
                <pre className="coord-bootstrap-log" aria-live="polite">
                  {bootstrapLog}
                </pre>
              ) : (
                <p className="muted coord-bootstrap-log-placeholder">Step log appears after you run bootstrap.</p>
              )}
            </div>
            <div className="coord-panel-head">
              <h3 className="coord-panel-title">Tasks {selectedProject ? `— ${projectDisplayName(selectedProject)}` : ""}</h3>
              {storageAvailable && selectedProjectId ? (
                <div className="coord-task-panel-actions">
                  <button
                    type="button"
                    className="btn-header-secondary coord-small-btn"
                    disabled={roadmapImportBusy || registryLoading || bootstrapBusy}
                    title="Add a placeholder task (edit title and details after create)"
                    onClick={() => void createNewTask()}
                  >
                    + Task
                  </button>
                  <button
                    type="button"
                    className="btn-header-secondary coord-small-btn"
                    disabled={roadmapImportBusy || registryLoading || bootstrapBusy}
                    title="Parse ROADMAP.md from the project blueprint in KV and upsert roadmap tasks (idempotent)"
                    onClick={() => void handleImportRoadmap()}
                  >
                    {roadmapImportBusy ? "Importing…" : "Import ROADMAP.md"}
                  </button>
                </div>
              ) : null}
            </div>
            {!selectedProjectId ? (
              <p className="muted">Select a project.</p>
            ) : tasks.length === 0 ? (
              <div className="tasks-empty-state coord-empty">
                <p>No tasks for this project.</p>
                {storageAvailable ? (
                  <button type="button" className="btn-primary" onClick={() => void createNewTask()}>
                    + Task
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <p className="muted small coord-table-hint">
                  <strong>Status</strong> <code>review</code> after a successful orchestration means the coding loop
                  finished OK and the task is waiting for you to confirm — use <strong>Edit</strong> and set status to{" "}
                  <code>done</code> when finished, or run <strong>Project autonomy</strong> again (review tasks stay
                  eligible).
                </p>
                <div className="coord-table-wrap">
                  <table className="tasks-table coord-tasks-table" aria-label="Coordinator tasks">
                <thead>
                  <tr>
                    <th className="tasks-th tasks-th-title">Task</th>
                    <th className="tasks-th tasks-th-type">Role</th>
                    <th className="tasks-th tasks-th-type">Status</th>
                    <th className="tasks-th tasks-th-type coord-tasks-th-review">Review</th>
                    <th className="tasks-th tasks-th-type">Provenance</th>
                    <th className="tasks-th tasks-th-type">Depends on</th>
                    <th className="tasks-th tasks-th-type coord-tasks-th-last-run">Last run</th>
                    <th className="tasks-th tasks-th-actions coord-tasks-th-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.taskId} className="tasks-row">
                      <td className="tasks-td tasks-td-title">
                        <strong>{t.title}</strong>
                        <div className="muted coord-task-meta">{t.taskId}</div>
                      </td>
                      <td className="tasks-td tasks-td-type">{t.assignedRole}</td>
                      <td className="tasks-td tasks-td-type">
                        <span className={t.status === "review" ? "coord-badge coord-badge-warn" : ""}>{t.status}</span>
                      </td>
                      <td className="tasks-td tasks-td-type coord-tasks-td-review">{taskReviewAuditCell(t)}</td>
                      <td className="tasks-td tasks-td-type">
                        <span
                          className={
                            t.taskSource === "coordinator_generated"
                              ? "coord-badge coord-badge-warn"
                              : t.taskSource === "roadmap"
                                ? "coord-badge coord-badge-ok"
                                : "coord-badge"
                          }
                          title={t.generationReason ?? undefined}
                        >
                          {displayTaskSource(t)}
                        </span>
                        {t.importedFromRoadmap ? (
                          <div className="muted small">imported from blueprint</div>
                        ) : null}
                        {t.generationReason ? (
                          <div className="muted small">reason: {t.generationReason}</div>
                        ) : null}
                        {t.parentTaskId ? (
                          <div className="muted small">
                            parent:{" "}
                            <code title={tasks.find((x) => x.taskId === t.parentTaskId)?.title}>
                              {t.parentTaskId.slice(0, 8)}…
                            </code>
                          </div>
                        ) : null}
                      </td>
                      <td className="tasks-td tasks-td-type">
                        {t.dependsOnTaskIds && t.dependsOnTaskIds.length > 0 ? (
                          <ul className="coord-deps-list">
                            {t.dependsOnTaskIds.map((id) => (
                              <li key={id}>
                                <code className="coord-task-meta" title={tasks.find((x) => x.taskId === id)?.title}>
                                  {id.length > 22 ? `${id.slice(0, 20)}…` : id}
                                </code>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="tasks-td tasks-td-type">
                        {t.lastRunId ? (
                          <>
                            <code className="coord-task-meta">{t.lastRunId.slice(0, 8)}…</code>
                            <div className="muted small">{t.lastRunStatus ?? "—"}</div>
                            {t.lastRunSummary ? (
                              <div className="muted small" title={t.lastRunSummary}>
                                {t.lastRunSummary.length > 48 ? `${t.lastRunSummary.slice(0, 48)}…` : t.lastRunSummary}
                              </div>
                            ) : null}
                            {t.lastRunErrorNote ? (
                              <div className="coord-badge coord-badge-warn" style={{ marginTop: 4 }}>
                                {t.lastRunErrorNote.length > 40 ? `${t.lastRunErrorNote.slice(0, 40)}…` : t.lastRunErrorNote}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="tasks-td tasks-td-actions">
                        {storageAvailable ? (
                          <div className="coord-task-row-actions">
                            {t.lastRunId ? (
                              <button
                                type="button"
                                className="btn-header-secondary coord-small-btn"
                                onClick={() => {
                                  setReviewAnchorTaskId(t.taskId);
                                  setReviewExplicitRunId(null);
                                }}
                              >
                                Review run
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn-header-secondary coord-small-btn"
                              onClick={() => setTaskBeingEdited(t)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn-text-danger"
                              onClick={async () => {
                                if (!confirm(`Delete task ${t.taskId}?`)) return;
                                try {
                                  await deleteCoordinatorTask(t.taskId);
                                  await loadTasks(selectedProjectId);
                                } catch (e) {
                                  flash(e instanceof Error ? e.message : "Delete failed", "error");
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
        <CoordinatorReviewPanel
          storageAvailable={storageAvailable}
          sharedWorkspaceKvPresent={health?.sharedWorkspaceKvPresent ?? false}
          selectedProjectId={selectedProjectId}
          selectedProject={selectedProject}
          tasks={tasks}
          runs={runs}
          reviewExplicitRunId={reviewExplicitRunId}
          reviewAnchorTaskId={reviewAnchorTaskId}
          onClearReview={() => {
            setReviewExplicitRunId(null);
            setReviewAnchorTaskId(null);
          }}
          onTaskUpdated={() => {
            if (selectedProjectId) void loadTasks(selectedProjectId);
            void loadRuns();
            void loadRegistry();
          }}
          flash={flash}
        />
        </>
      )}

      {tab === "runs" && (
        <section className="coord-panel">
          <div className="coord-panel-head">
            <h3 className="coord-panel-title">Orchestration runs</h3>
            <button type="button" className="btn-header-secondary" onClick={() => void loadRuns()} disabled={runsLoading}>
              {runsLoading ? "Loading…" : "Reload"}
            </button>
          </div>
          {!storageAvailable ? (
            <p className="muted">
              Runs are stored when <code>COORDINATOR_CONTROL_PLANE_KV</code> is bound. Successful HTTP orchestrate
              responses from orchestration / diagnostics HTTP probes on this page can append a run when storage is
              available.
            </p>
          ) : null}
          {runs.length === 0 ? (
            <div className="tasks-empty-state coord-empty">
              <p>No recorded runs.</p>
              <p className="muted small">
                TODO: wire automatic append from all debug entrypoints; v1 records successful HTTP orchestrate from
                this page only.
              </p>
            </div>
          ) : (
            <>
              <p className="muted small coord-table-hint">
                <strong>Lifecycle</strong> is the run row state (<code>completed</code> = closed).{" "}
                <strong>Loop outcome</strong> is the coding-loop terminal status (
                <code>completed_success</code> = loop finished successfully). <strong>Tester verdicts</strong> are per
                iteration (e.g. first <code>fail</code> then <code>pass</code> after a revision) — not a project-wide
                failure if the loop outcome is success.
              </p>
              <div className="coord-table-wrap">
                <table className="tasks-table coord-runs-table" aria-label="Coordinator runs">
                  <thead>
                    <tr>
                      <th className="tasks-th tasks-th-date">Finished</th>
                      <th className="tasks-th tasks-th-title">Project</th>
                      <th className="tasks-th tasks-th-type">Task</th>
                      <th className="tasks-th tasks-th-type">Session</th>
                      <th className="tasks-th tasks-th-type coord-runs-th-lifecycle">Lifecycle</th>
                      <th className="tasks-th tasks-th-type coord-runs-th-outcome">Loop outcome</th>
                      <th className="tasks-th tasks-th-type coord-runs-th-verdicts">Tester verdicts</th>
                      <th className="tasks-th tasks-th-type coord-runs-th-usage">Usage</th>
                      <th className="tasks-th tasks-th-actions coord-runs-th-review">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr
                        key={r.runId}
                        id={`coord-run-row-${r.runId}`}
                        className={`tasks-row${runsHighlightRunId === r.runId ? " coord-run-row-highlight" : ""}`}
                      >
                        <td className="tasks-td tasks-td-date">{fmtDate(r.finishedAt ?? r.startedAt)}</td>
                        <td className="tasks-td tasks-td-title">
                          <code>{r.projectId}</code>
                          <div className="muted small">{r.source}</div>
                        </td>
                        <td className="tasks-td tasks-td-type">
                          {r.taskId ? <code className="coord-run-task-id">{r.taskId}</code> : <span className="muted">—</span>}
                        </td>
                        <td className="tasks-td tasks-td-type">
                          <code>{r.sessionId}</code>
                        </td>
                        <td className="tasks-td tasks-td-type coord-runs-td-lifecycle">
                          {r.runLifecycleStatus ? (
                            <span className="coord-badge">{r.runLifecycleStatus}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="tasks-td tasks-td-type coord-runs-td-outcome">
                          <span className="coord-run-loop-outcome">{r.finalStatus ?? r.loopTerminalStatus ?? "—"}</span>
                        </td>
                        <td className="tasks-td tasks-td-type coord-runs-td-verdicts">
                          {r.iterationSummaries && r.iterationSummaries.length > 0 ? (
                            <ul className="coord-run-verdict-list">
                              {r.iterationSummaries.map((s) => (
                                <li key={s.iteration}>
                                  <span className="coord-run-verdict-iter">#{s.iteration}</span>{" "}
                                  <code>{s.testerVerdict ?? "—"}</code>
                                  {s.managerDecision ? (
                                    <span className="muted small"> mgr {s.managerDecision}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="coord-run-verdict-fallback">
                              {formatVerdictSummaryForDisplay(r.verdictSummary)}
                            </span>
                          )}
                        </td>
                        <td className="tasks-td tasks-td-type coord-runs-td-usage">
                          <button
                            type="button"
                            className={`btn-header-secondary coord-small-btn${runsInspectorRunId === r.runId ? " is-active" : ""}`}
                            onClick={() =>
                              setRunsInspectorRunId((cur) => (cur === r.runId ? null : r.runId))
                            }
                          >
                            {runsInspectorRunId === r.runId ? "Hide usage" : "Cost / logs"}
                          </button>
                        </td>
                        <td className="tasks-td tasks-td-actions coord-runs-td-review">
                          <button
                            type="button"
                            className="btn-header-secondary coord-small-btn"
                            onClick={() => openRunReview(r.runId)}
                          >
                            Open review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {runsInspectorRunId ? (
                <div className="coord-run-inspector" role="region" aria-label={`Run ${runsInspectorRunId} usage`}>
                  <div className="coord-run-inspector-head">
                    <h4 className="coord-panel-title">Run usage</h4>
                    <button
                      type="button"
                      className="btn-header-secondary coord-small-btn"
                      onClick={() => setRunsInspectorRunId(null)}
                    >
                      Close
                    </button>
                  </div>
                  <p className="muted small">
                    <code>{runsInspectorRunId}</code> — AI Gateway logs filtered by metadata <code>run</code> (Worker
                    proxy). Persisted prompts/responses below come from the coding loop when the run was finalized.
                  </p>
                  {gatewayLogsBusy ? <p className="muted">Loading gateway logs…</p> : null}
                  {gatewayLogs && !gatewayLogs.ok ? (
                    <p className="coord-run-inspector-error" role="alert">
                      {gatewayLogs.error}
                      {gatewayLogs.hint ? ` ${gatewayLogs.hint}` : ""}
                    </p>
                  ) : null}
                  {gatewayLogs && gatewayLogs.ok ? (
                    <>
                      <div className="coord-run-usage-strip" aria-label="Token and cost summary">
                        <span>
                          <strong>Tokens in</strong> {gatewayLogs.tokensIn.toLocaleString()}
                        </span>
                        <span>
                          <strong>Tokens out</strong> {gatewayLogs.tokensOut.toLocaleString()}
                        </span>
                        <span>
                          <strong>Est. cost</strong> {gatewayLogs.totalCost.toFixed(6)}
                        </span>
                        <span className="muted">{gatewayLogs.entryCount} log row(s)</span>
                      </div>
                      {gatewayLogs.entries.length > 0 ? (
                        <div className="coord-table-wrap">
                          <table className="tasks-table coord-gateway-logs-table" aria-label="Gateway log rows">
                            <thead>
                              <tr>
                                <th className="tasks-th tasks-th-date">At</th>
                                <th className="tasks-th tasks-th-title">Model</th>
                                <th className="tasks-th tasks-th-type">Provider</th>
                                <th className="tasks-th tasks-th-type">OK</th>
                                <th className="tasks-th tasks-th-type">In</th>
                                <th className="tasks-th tasks-th-type">Out</th>
                                <th className="tasks-th tasks-th-type">Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {gatewayLogs.entries.map((e) => (
                                <tr key={e.id} className="tasks-row">
                                  <td className="tasks-td tasks-td-date">{fmtDate(e.created_at)}</td>
                                  <td className="tasks-td tasks-td-title">
                                    <code>{e.model}</code>
                                  </td>
                                  <td className="tasks-td tasks-td-type">{e.provider}</td>
                                  <td className="tasks-td tasks-td-type">{e.success ? "yes" : "no"}</td>
                                  <td className="tasks-td tasks-td-type">{e.tokens_in}</td>
                                  <td className="tasks-td tasks-td-type">{e.tokens_out}</td>
                                  <td className="tasks-td tasks-td-type">
                                    {e.cost !== undefined ? e.cost.toFixed(6) : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="muted small">No log rows returned for this run id.</p>
                      )}
                    </>
                  ) : null}
                  {(() => {
                    const inspected = runs.find((x) => x.runId === runsInspectorRunId);
                    const audit = inspected?.subagentTurnAudit;
                    if (audit && audit.length > 0) {
                      return (
                        <>
                          <h4 className="coord-panel-title coord-run-inspector-subtitle">
                            Sub-agent turn audit (persisted)
                          </h4>
                          <div className="coord-table-wrap">
                            <table className="tasks-table coord-audit-table" aria-label="Sub-agent turn audit">
                              <thead>
                                <tr>
                                  <th className="tasks-th tasks-th-type">Iter</th>
                                  <th className="tasks-th tasks-th-type">Role</th>
                                  <th className="tasks-th tasks-th-type">Prompt chars</th>
                                  <th className="tasks-th tasks-th-title">Prompt preview</th>
                                  <th className="tasks-th tasks-th-type">Resp chars</th>
                                  <th className="tasks-th tasks-th-title">Notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {audit.map((row: CoordinatorSubagentTurnAuditEntry, idx: number) => (
                                  <tr key={`${row.iteration}-${row.role}-${idx}`} className="tasks-row">
                                    <td className="tasks-td tasks-td-type">{row.iteration}</td>
                                    <td className="tasks-td tasks-td-type">{row.role}</td>
                                    <td className="tasks-td tasks-td-type">{row.promptCharCount}</td>
                                    <td className="tasks-td tasks-td-title">
                                      <pre className="coord-audit-preview">{row.promptPreview}</pre>
                                    </td>
                                    <td className="tasks-td tasks-td-type">{row.responseCharCount}</td>
                                    <td className="tasks-td tasks-td-title">
                                      {row.testerVerdictLine ? (
                                        <code className="coord-task-meta">{row.testerVerdictLine}</code>
                                      ) : row.responsePreview ? (
                                        <pre className="coord-audit-preview">{row.responsePreview}</pre>
                                      ) : (
                                        <span className="muted">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      );
                    }
                    if (inspected) {
                      return (
                        <p className="muted small">
                          No persisted sub-agent turn audit on this run (older runs or paths that did not finalize
                          audit).
                        </p>
                      );
                    }
                    return <p className="muted small">Run row not found in the current list — reload runs.</p>;
                  })()}
                </div>
              ) : null}
            </>
          )}
        </section>
      )}

      {tab === "orchestration" && (
        <OrchestrationConsoleTab
          sessionId={sessionId}
          wsEndpoint={wsEndpoint}
          storageAvailable={storageAvailable}
          projects={projects}
          selectedProjectId={selectedProjectId}
          setSelectedProjectId={setSelectedProjectId}
          selectedProject={selectedProject}
          tasks={tasks}
          selectedOrchestrationTaskId={selectedOrchestrationTaskId}
          setSelectedOrchestrationTaskId={setSelectedOrchestrationTaskId}
          primaryRunMode={primaryRunMode}
          setPrimaryRunMode={setPrimaryRunMode}
          executionStopMode={executionStopMode}
          setExecutionStopMode={setExecutionStopMode}
          autonomyBatchMaxSteps={autonomyBatchMaxSteps}
          setAutonomyBatchMaxSteps={setAutonomyBatchMaxSteps}
          debugToken={debugToken}
          setDebugToken={setDebugToken}
          debugBusy={debugBusy}
          debugChildStateless={debugChildStateless}
          setDebugChildStateless={setDebugChildStateless}
          debugNoSharedTools={debugNoSharedTools}
          setDebugNoSharedTools={setDebugNoSharedTools}
          debugAttachControlPlaneProject={debugAttachControlPlaneProject}
          setDebugAttachControlPlaneProject={setDebugAttachControlPlaneProject}
          orchCodingLoopMaxIterations={orchCodingLoopMaxIterations}
          setOrchCodingLoopMaxIterations={setOrchCodingLoopMaxIterations}
          orchestrateLaunchBlocked={orchestrateLaunchBlocked}
          orchestrateTaskBlocksLaunch={orchestrateTaskBlocksLaunch}
          orchestrateAttachBlocked={orchestrateAttachBlocked}
          projectAutonomyBlocked={projectAutonomyBlocked}
          rpcStatus={rpcStatus}
          connectRpc={connectRpc}
          disconnectRpc={disconnectRpc}
          minimalChildStateless={minimalChildStateless}
          setMinimalChildStateless={setMinimalChildStateless}
          sharedWorkspaceKvPresent={health?.sharedWorkspaceKvPresent ?? false}
          finalizeAckHumanReview={finalizeAckHumanReview}
          setFinalizeAckHumanReview={setFinalizeAckHumanReview}
          finalizePersistManifest={finalizePersistManifest}
          setFinalizePersistManifest={setFinalizePersistManifest}
          finalizeBusy={finalizeBusy}
          finalizeResult={finalizeResult}
          runFinalizeProject={runFinalizeProject}
          materializeMappingPreset={materializeMappingPreset}
          setMaterializeMappingPreset={setMaterializeMappingPreset}
          materializePreview={materializePreview}
          materializePreviewBusy={materializePreviewBusy}
          runMaterializePreview={runMaterializePreview}
          materializeBusy={materializeBusy}
          runMaterializeProjectZip={runMaterializeProjectZip}
          runMaterializeProjectJson={runMaterializeProjectJson}
          runDebugHttp={runDebugHttp}
          runProjectAutonomyHttp={runProjectAutonomyHttp}
          runRpcOrchestrate={runRpcOrchestrate}
          runRpcProbe={runRpcProbe}
          debugResult={debugResult}
          applyOrchestrationPreset={applyOrchestrationPreset}
        />
      )}
      </div>

      <EditCoordinatorTaskDialog
        open={taskBeingEdited !== null}
        task={taskBeingEdited}
        storageAvailable={storageAvailable}
        onClose={() => setTaskBeingEdited(null)}
        onSaved={() => {
          if (selectedProjectId) void loadTasks(selectedProjectId);
        }}
        flash={flash}
      />

      <ProjectBlueprintDialog
        open={blueprintDialogOpen}
        mode={blueprintDialogMode}
        projectId={blueprintDialogMode === "edit" ? selectedProjectId : null}
        storageAvailable={storageAvailable}
        onClose={() => setBlueprintDialogOpen(false)}
        onSaved={async (createdProjectId) => {
          await loadRegistry();
          if (createdProjectId) setSelectedProjectId(createdProjectId);
          setBlueprintDialogOpen(false);
        }}
        flash={flash}
      />
    </section>
  );
}
