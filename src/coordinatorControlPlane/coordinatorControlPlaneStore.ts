import type { Env } from "../lib/env";
import type {
  CodingCollaborationLoopResult,
  CodingLoopTerminalStatus,
} from "../agents/codingLoop/codingLoopTypes";
import { validateProjectBlueprint } from "./blueprintValidation";
import { withComputedDocState } from "./blueprintDocMeta";
import { slugifyProjectName } from "./projectSlug";
import { decideFollowUpTaskSpecs } from "./coordinatorFollowUpTaskPolicy";
import {
  mergeRoadmapImportIntoTasks,
  parseRoadmapMarkdown,
  type RoadmapImportResult,
} from "./roadmapTaskImport";
import type {
  CoordinatorControlPlaneState,
  CoordinatorProject,
  CoordinatorRun,
  CoordinatorRunIterationEvidence,
  CoordinatorRunIterationSummary,
  CoordinatorTask,
  ProjectBlueprint,
} from "./types";
import { BLUEPRINT_FILE_KEYS, CONTROL_PLANE_STATE_KEY } from "./types";

const MAX_RUNS = 100;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function emptyState(): CoordinatorControlPlaneState {
  return { schemaVersion: 1, projects: [], tasks: [], runs: [] };
}

function normalizeBlueprintInput(input: unknown): ProjectBlueprint {
  const docs: ProjectBlueprint["docs"] = {};
  const templateFingerprints: NonNullable<ProjectBlueprint["templateFingerprints"]> = {};
  if (isRecord(input)) {
    if (isRecord(input.docs)) {
      for (const k of BLUEPRINT_FILE_KEYS) {
        const v = input.docs[k];
        if (typeof v === "string") docs[k] = v;
      }
    }
    if (isRecord(input.templateFingerprints)) {
      for (const k of BLUEPRINT_FILE_KEYS) {
        const v = input.templateFingerprints[k];
        if (typeof v === "string") templateFingerprints[k] = v;
      }
    }
  }
  return withComputedDocState({ schemaVersion: 1, docs, templateFingerprints });
}

function mergeBlueprintPatch(prev: ProjectBlueprint, patchRaw: unknown): ProjectBlueprint {
  if (!isRecord(patchRaw)) return normalizeBlueprintInput(prev);
  const mergedDocs = { ...prev.docs };
  if (isRecord(patchRaw.docs)) {
    for (const k of BLUEPRINT_FILE_KEYS) {
      const v = patchRaw.docs[k];
      if (typeof v === "string") mergedDocs[k] = v;
    }
  }
  const mergedFp = { ...(prev.templateFingerprints ?? {}) };
  if (isRecord(patchRaw.templateFingerprints)) {
    for (const k of BLUEPRINT_FILE_KEYS) {
      const v = patchRaw.templateFingerprints[k];
      if (typeof v === "string") mergedFp[k] = v;
    }
  }
  return withComputedDocState({
    schemaVersion: 1,
    docs: mergedDocs,
    templateFingerprints: mergedFp,
  });
}

/** Recompute readiness from blueprint bodies (idempotent for reads and writes). */
function finalizeProjectFields(
  base: Omit<CoordinatorProject, "readiness" | "validationErrors" | "title">
): CoordinatorProject {
  const v = validateProjectBlueprint(base.blueprint);
  return {
    ...base,
    title: base.projectName,
    readiness: v.readiness,
    validationErrors: v.errors.length ? v.errors : undefined,
  };
}

function normalizeCoordinatorProject(raw: unknown): CoordinatorProject | null {
  if (!isRecord(raw)) return null;
  const projectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  if (!projectId) return null;

  const projectName =
    (typeof raw.projectName === "string" && raw.projectName.trim()) ||
    (typeof raw.title === "string" && raw.title.trim()) ||
    "Untitled";

  let projectSlug =
    typeof raw.projectSlug === "string" && raw.projectSlug.trim()
      ? raw.projectSlug.trim()
      : slugifyProjectName(projectName);
  projectSlug = slugifyProjectName(projectSlug);

  const status: CoordinatorProject["status"] = raw.status === "archived" ? "archived" : "active";

  const blueprint = normalizeBlueprintInput(raw.blueprint);

  const base: Omit<CoordinatorProject, "readiness" | "validationErrors" | "title"> = {
    projectId,
    projectName,
    projectSlug,
    description: typeof raw.description === "string" ? raw.description : "",
    specPath: typeof raw.specPath === "string" ? raw.specPath : "",
    sharedProjectId: typeof raw.sharedProjectId === "string" ? raw.sharedProjectId : "",
    status,
    blueprint,
    allowedScopeDirs: Array.isArray(raw.allowedScopeDirs)
      ? raw.allowedScopeDirs.filter((d): d is string => typeof d === "string")
      : [],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
  return finalizeProjectFields(base);
}

function slugTaken(
  slug: string,
  projects: CoordinatorProject[],
  excludeProjectId?: string
): boolean {
  const lower = slug.toLowerCase();
  return projects.some((p) => p.projectId !== excludeProjectId && p.projectSlug.toLowerCase() === lower);
}

/** After normalizing legacy rows, ensure no two projects share the same slug. */
function ensureUniqueSlugs(projects: CoordinatorProject[]): CoordinatorProject[] {
  const result: CoordinatorProject[] = [];
  for (const p of projects) {
    let slug = slugifyProjectName(p.projectSlug);
    const base = slug;
    let n = 1;
    while (result.some((x) => x.projectSlug.toLowerCase() === slug.toLowerCase())) {
      n += 1;
      slug = `${base}-${n}`;
    }
    result.push(slug === p.projectSlug ? p : { ...p, projectSlug: slug });
  }
  return result;
}

export function uniquifyProjectSlug(
  desired: string,
  projects: CoordinatorProject[],
  excludeProjectId?: string
): string {
  let candidate = slugifyProjectName(desired);
  if (!slugTaken(candidate, projects, excludeProjectId)) return candidate;
  let n = 2;
  while (n < 10_000) {
    const c = `${candidate}-${n}`;
    if (!slugTaken(c, projects, excludeProjectId)) return c;
    n += 1;
  }
  return `${candidate}-${crypto.randomUUID().slice(0, 8)}`;
}

async function readState(kv: KVNamespace): Promise<CoordinatorControlPlaneState> {
  const raw = await kv.get(CONTROL_PLANE_STATE_KEY);
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as CoordinatorControlPlaneState;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
      return emptyState();
    }
    const projects: CoordinatorProject[] = [];
    for (const p of parsed.projects) {
      const n = normalizeCoordinatorProject(p);
      if (n) projects.push(n);
    }
    return {
      schemaVersion: 1,
      projects: ensureUniqueSlugs(projects),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return emptyState();
  }
}

async function writeState(kv: KVNamespace, state: CoordinatorControlPlaneState): Promise<void> {
  await kv.put(CONTROL_PLANE_STATE_KEY, JSON.stringify(state));
}

export function controlPlaneStorageAvailable(env: Env): boolean {
  return Boolean(env.COORDINATOR_CONTROL_PLANE_KV);
}

export async function listProjects(env: Env): Promise<CoordinatorProject[]> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return [];
  const s = await readState(env.COORDINATOR_CONTROL_PLANE_KV);
  return [...s.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(env: Env, projectId: string): Promise<CoordinatorProject | null> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return null;
  const s = await readState(env.COORDINATOR_CONTROL_PLANE_KV);
  const p = s.projects.find((x) => x.projectId === projectId);
  return p ?? null;
}

export async function listTasksForProject(env: Env, projectId: string): Promise<CoordinatorTask[]> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return [];
  const s = await readState(env.COORDINATOR_CONTROL_PLANE_KV);
  return s.tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Lookup by `taskId` across all projects (caller verifies `projectId` if needed). */
export async function getTaskById(env: Env, taskId: string): Promise<CoordinatorTask | null> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return null;
  const id = taskId.trim();
  if (!id) return null;
  const s = await readState(env.COORDINATOR_CONTROL_PLANE_KV);
  return s.tasks.find((t) => t.taskId === id) ?? null;
}

export async function listRuns(env: Env, limit = 50): Promise<CoordinatorRun[]> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return [];
  const s = await readState(env.COORDINATOR_CONTROL_PLANE_KV);
  return [...s.runs]
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
    .slice(0, limit);
}

export async function createProject(
  env: Env,
  input: Omit<CoordinatorProject, "createdAt" | "updatedAt" | "readiness" | "validationErrors" | "title">
): Promise<CoordinatorProject> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const now = new Date().toISOString();
  const s = await readState(kv);
  if (s.projects.some((p) => p.projectId === input.projectId)) {
    throw new Error(`projectId already exists: ${input.projectId}`);
  }
  const projectSlug = uniquifyProjectSlug(input.projectSlug, s.projects);
  const base: Omit<CoordinatorProject, "readiness" | "validationErrors" | "title"> = {
    ...input,
    projectSlug,
    blueprint: normalizeBlueprintInput(input.blueprint),
    createdAt: now,
    updatedAt: now,
  };
  const row = finalizeProjectFields(base);
  s.projects.push(row);
  await writeState(kv, s);
  return row;
}

export async function updateProject(
  env: Env,
  projectId: string,
  patch: Partial<Omit<CoordinatorProject, "projectId" | "createdAt">>
): Promise<CoordinatorProject> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  const idx = s.projects.findIndex((p) => p.projectId === projectId);
  if (idx < 0) throw new Error(`project not found: ${projectId}`);
  const prev = s.projects[idx];
  const now = new Date().toISOString();

  let nextSlug = prev.projectSlug;
  if (typeof patch.projectSlug === "string" && patch.projectSlug.trim()) {
    nextSlug = uniquifyProjectSlug(patch.projectSlug.trim(), s.projects, projectId);
  }

  const nextBlueprint =
    patch.blueprint !== undefined ? mergeBlueprintPatch(prev.blueprint, patch.blueprint) : prev.blueprint;

  const base: Omit<CoordinatorProject, "readiness" | "validationErrors" | "title"> = {
    projectId,
    projectName:
      typeof patch.projectName === "string" && patch.projectName.trim()
        ? patch.projectName.trim()
        : prev.projectName,
    projectSlug: nextSlug,
    description:
      typeof patch.description === "string" ? patch.description : prev.description,
    specPath: typeof patch.specPath === "string" ? patch.specPath : prev.specPath,
    sharedProjectId:
      typeof patch.sharedProjectId === "string" && patch.sharedProjectId.trim()
        ? patch.sharedProjectId.trim()
        : prev.sharedProjectId,
    status: patch.status === "archived" || patch.status === "active" ? patch.status : prev.status,
    blueprint: nextBlueprint,
    allowedScopeDirs: Array.isArray(patch.allowedScopeDirs) ? patch.allowedScopeDirs : prev.allowedScopeDirs,
    createdAt: prev.createdAt,
    updatedAt: now,
  };

  const updated = finalizeProjectFields(base);
  s.projects[idx] = updated;
  await writeState(kv, s);
  return updated;
}

export async function deleteProject(env: Env, projectId: string): Promise<void> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  s.projects = s.projects.filter((p) => p.projectId !== projectId);
  s.tasks = s.tasks.filter((t) => t.projectId !== projectId);
  await writeState(kv, s);
}

export async function createTask(
  env: Env,
  input: Omit<CoordinatorTask, "createdAt" | "updatedAt">
): Promise<CoordinatorTask> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const now = new Date().toISOString();
  const row: CoordinatorTask = { ...input, createdAt: now, updatedAt: now };
  const s = await readState(kv);
  if (!s.projects.some((p) => p.projectId === row.projectId)) {
    throw new Error(`project not found: ${row.projectId}`);
  }
  if (s.tasks.some((t) => t.taskId === row.taskId)) {
    throw new Error(`taskId already exists: ${row.taskId}`);
  }
  s.tasks.push(row);
  await writeState(kv, s);
  return row;
}

export async function updateTask(
  env: Env,
  taskId: string,
  patch: Partial<Omit<CoordinatorTask, "taskId" | "createdAt">>
): Promise<CoordinatorTask> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  const idx = s.tasks.findIndex((t) => t.taskId === taskId);
  if (idx < 0) throw new Error(`task not found: ${taskId}`);
  const now = new Date().toISOString();
  const updated: CoordinatorTask = {
    ...s.tasks[idx],
    ...patch,
    taskId,
    createdAt: s.tasks[idx].createdAt,
    updatedAt: now,
  };
  s.tasks[idx] = updated;
  await writeState(kv, s);
  return updated;
}

export async function deleteTask(env: Env, taskId: string): Promise<void> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  s.tasks = s.tasks.filter((t) => t.taskId !== taskId);
  await writeState(kv, s);
}

/**
 * Parse {@link CoordinatorProject.blueprint} `ROADMAP.md` and upsert {@link CoordinatorTask} rows (`taskSource: roadmap`).
 * Idempotent; explicit operator action (not auto-run with autonomy v1).
 */
export async function importRoadmapTasksForProject(
  env: Env,
  projectId: string
): Promise<RoadmapImportResult & { ok: boolean; error?: string }> {
  const pid = projectId.trim();
  console.info("roadmap_import_start", JSON.stringify({ projectId: pid }));
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    const err = "COORDINATOR_CONTROL_PLANE_KV is not bound";
    console.info("roadmap_import_error", JSON.stringify({ projectId: pid, error: err }));
    throw new Error(err);
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const project = await getProject(env, pid);
  if (!project) {
    console.info("roadmap_import_skipped", JSON.stringify({ projectId: pid, reason: "project_not_found" }));
    return {
      ok: false,
      error: "Project not found",
      created: 0,
      updated: 0,
      skipped: 0,
      warnings: [],
      touchedTaskIds: [],
    };
  }
  const md = project.blueprint.docs["ROADMAP.md"]?.trim();
  if (!md) {
    console.info("roadmap_import_skipped", JSON.stringify({ projectId: pid, reason: "empty_roadmap" }));
    return {
      ok: true,
      created: 0,
      updated: 0,
      skipped: 1,
      warnings: ["ROADMAP.md is empty or missing on project blueprint"],
      touchedTaskIds: [],
    };
  }
  try {
    const parsed = parseRoadmapMarkdown(md, pid);
    if (parsed.length === 0) {
      console.info("roadmap_import_skipped", JSON.stringify({ projectId: pid, reason: "no_tasks_extracted" }));
      return {
        ok: true,
        created: 0,
        updated: 0,
        skipped: 1,
        warnings: ["No checklist lines, TASK-* blocks, or importable bullets found in ROADMAP.md"],
        touchedTaskIds: [],
      };
    }
    const s = await readState(kv);
    const now = new Date().toISOString();
    const { tasks, result } = mergeRoadmapImportIntoTasks(s.tasks, pid, parsed, now);
    s.tasks = tasks;
    await writeState(kv, s);
    console.info("roadmap_import_complete", JSON.stringify({ projectId: pid, ...result }));
    return { ok: true, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("roadmap_import_error", JSON.stringify({ projectId: pid, error: msg }));
    throw e;
  }
}

export async function appendRun(env: Env, run: CoordinatorRun): Promise<CoordinatorRun> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  s.runs.unshift(run);
  if (s.runs.length > MAX_RUNS) {
    s.runs = s.runs.slice(0, MAX_RUNS);
  }
  await writeState(kv, s);
  return run;
}

function collectPatchIdsForRun(result: CodingCollaborationLoopResult): string[] {
  const patchIdSet = new Set<string>();
  for (const it of result.iterations) {
    for (const id of it.pendingPatchIdsAfterCoder) patchIdSet.add(id);
    for (const id of it.newPendingPatchIds) patchIdSet.add(id);
    for (const id of it.activePatchIdsForIteration) patchIdSet.add(id);
  }
  return [...patchIdSet].sort();
}

function iterationSummariesFromResult(
  result: CodingCollaborationLoopResult
): CoordinatorRunIterationSummary[] {
  return result.iterations.map((it) => ({
    iteration: it.iteration,
    testerVerdict: it.testerVerdict,
    managerDecision: it.managerDecision,
  }));
}

function verdictSummaryLine(result: CodingCollaborationLoopResult): string {
  return result.iterations.map((it) => it.testerVerdict).join("→");
}

const RUN_SUMMARY_FOR_USER_MAX = 12_000;

function clampRunSummaryForUser(text: string): string {
  const t = text.trim();
  if (t.length <= RUN_SUMMARY_FOR_USER_MAX) return t;
  return `${t.slice(0, RUN_SUMMARY_FOR_USER_MAX)}\n\n…(truncated for control-plane KV)`;
}

function iterationEvidenceFromResult(result: CodingCollaborationLoopResult): CoordinatorRunIterationEvidence[] {
  return result.iterations.map((it) => ({
    iteration: it.iteration,
    coder: {
      ok: it.coderSummary.ok,
      textLen: it.coderSummary.textLen,
      eventCount: it.coderSummary.eventCount,
      ...(it.coderSummary.error ? { error: it.coderSummary.error } : {}),
    },
    tester: {
      ok: it.testerSummary.ok,
      textLen: it.testerSummary.textLen,
      eventCount: it.testerSummary.eventCount,
      ...(it.testerSummary.error ? { error: it.testerSummary.error } : {}),
    },
    testerVerdict: it.testerVerdict,
    managerDecision: it.managerDecision,
    newPendingPatchIds: [...it.newPendingPatchIds],
    activePatchIdsForIteration: [...it.activePatchIdsForIteration],
  }));
}

function isLoopTerminalSuccess(status: CodingLoopTerminalStatus): boolean {
  const s = status as string;
  return (
    s === "completed_success" || s === "stop_success_applied" || s === "stop_success_approved_pending_apply"
  );
}

/**
 * Inserts a `running` {@link CoordinatorRun} and applies the **start** task transition (`todo` → `in_progress`).
 * No-op when KV is unbound. Intended for task-backed debug orchestration only.
 */
export async function beginTaskBackedDebugOrchestrationRun(
  env: Env,
  input: {
    runId: string;
    projectId: string;
    taskId: string;
    sessionId: string;
    source: CoordinatorRun["source"];
    coordinatorPathUsed: boolean;
    blueprintContextLoaded: boolean;
  }
): Promise<void> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return;
  const now = new Date().toISOString();
  const run: CoordinatorRun = {
    runId: input.runId,
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: input.source,
    startedAt: now,
    runLifecycleStatus: "running",
    coordinatorPathUsed: input.coordinatorPathUsed,
    blueprintContextLoaded: input.blueprintContextLoaded,
  };
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  s.runs.unshift(run);
  if (s.runs.length > MAX_RUNS) {
    s.runs = s.runs.slice(0, MAX_RUNS);
  }
  const ti = s.tasks.findIndex((t) => t.taskId === input.taskId);
  if (ti >= 0) {
    const t = s.tasks[ti]!;
    let status: CoordinatorTask["status"] = t.status;
    if (status === "todo") status = "in_progress";
    s.tasks[ti] = {
      ...t,
      status,
      lastRunId: input.runId,
      lastRunStatus: "running",
      lastRunSummary: undefined,
      lastRunFinishedAt: undefined,
      lastRunErrorNote: undefined,
      updatedAt: now,
    };
  }
  await writeState(kv, s);
}

/**
 * Marks the run **completed** and applies **finish** task transitions (success → `review` or `done`;
 * `needs_user_approval` → `in_progress` with note; else → `blocked` with note).
 */
export async function finalizeTaskBackedDebugOrchestrationRun(
  env: Env,
  input: {
    runId: string;
    projectId: string;
    taskId: string;
    result: CodingCollaborationLoopResult;
    coordinatorPathUsed: boolean;
    blueprintContextLoaded: boolean;
    blueprintContextAssembly?: CodingCollaborationLoopResult["blueprintContextAssembly"] | null;
  }
): Promise<void> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return;
  const now = new Date().toISOString();
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  const ri = s.runs.findIndex((r) => r.runId === input.runId);
  if (ri < 0) {
    console.warn("finalizeTaskBackedDebugOrchestrationRun: run row missing", input.runId);
    return;
  }
  const prev = s.runs[ri]!;
  const patchIds = collectPatchIdsForRun(input.result);
  const verdictSummary = verdictSummaryLine(input.result);
  const asm = input.blueprintContextAssembly ?? input.result.blueprintContextAssembly ?? null;
  s.runs[ri] = {
    ...prev,
    finishedAt: now,
    finalStatus: input.result.status,
    loopTerminalStatus: input.result.status,
    runLifecycleStatus: "completed",
    iterationCount: input.result.iterations.length,
    patchIds,
    verdictSummary,
    coordinatorPathUsed: input.coordinatorPathUsed,
    blueprintContextLoaded: input.blueprintContextLoaded,
    blueprintContextAssembly: asm,
    iterationSummaries: iterationSummariesFromResult(input.result),
    summaryForUser: clampRunSummaryForUser(input.result.summaryForUser ?? ""),
    iterationEvidence: iterationEvidenceFromResult(input.result),
    ...(input.result.subagentTurnAudit?.length
      ? { subagentTurnAudit: input.result.subagentTurnAudit }
      : {}),
  };

  const ti = s.tasks.findIndex((t) => t.taskId === input.taskId);
  if (ti >= 0) {
    const t = s.tasks[ti]!;
    if (t.lastRunId !== input.runId) {
      console.warn("finalizeTaskBackedDebugOrchestrationRun: task lastRunId mismatch; skip task update", {
        taskId: input.taskId,
        expectedRunId: input.runId,
        lastRunId: t.lastRunId,
      });
    } else {
      const loopStatus = input.result.status;
      let nextStatus: CoordinatorTask["status"];
      let note: string | undefined;
      let summary = verdictSummary;

      if (isLoopTerminalSuccess(loopStatus)) {
        nextStatus = t.status === "review" ? "done" : "review";
        note = undefined;
      } else if (loopStatus === "needs_user_approval") {
        nextStatus = "in_progress";
        note = "needs_user_approval";
        summary = `${verdictSummary} (${loopStatus})`;
      } else {
        nextStatus = "blocked";
        note = loopStatus;
      }

      s.tasks[ti] = {
        ...t,
        status: nextStatus,
        lastRunStatus: loopStatus,
        lastRunSummary: summary,
        lastRunFinishedAt: now,
        lastRunErrorNote: note,
        updatedAt: now,
      };
    }
  }
  await writeState(kv, s);
}

/**
 * Merge fields into an existing run row (e.g. follow-up task ids after {@link appendFollowUpCoordinatorTasksAfterRun}).
 */
export async function patchCoordinatorRun(
  env: Env,
  runId: string,
  patch: Partial<Omit<CoordinatorRun, "runId">>
): Promise<CoordinatorRun> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    throw new Error("COORDINATOR_CONTROL_PLANE_KV is not bound");
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  const idx = s.runs.findIndex((r) => r.runId === runId);
  if (idx < 0) {
    throw new Error(`run not found: ${runId}`);
  }
  const prev = s.runs[idx]!;
  const merged: CoordinatorRun = { ...prev, ...patch, runId: prev.runId };
  s.runs[idx] = merged;
  await writeState(kv, s);
  return merged;
}

/** When the coding loop throws before returning a result — closes the run row and blocks the task. */
export async function abortTaskBackedDebugOrchestrationRun(
  env: Env,
  input: {
    runId: string;
    projectId: string;
    taskId: string;
    errorMessage: string;
    coordinatorPathUsed: boolean;
    blueprintContextLoaded: boolean;
  }
): Promise<void> {
  if (!env.COORDINATOR_CONTROL_PLANE_KV) return;
  const now = new Date().toISOString();
  const terminal: CodingLoopTerminalStatus = "stopped_aborted";
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  const ri = s.runs.findIndex((r) => r.runId === input.runId);
  if (ri >= 0) {
    const prev = s.runs[ri]!;
    s.runs[ri] = {
      ...prev,
      finishedAt: now,
      finalStatus: terminal,
      loopTerminalStatus: terminal,
      runLifecycleStatus: "completed",
      verdictSummary: `aborted: ${input.errorMessage.slice(0, 120)}`,
      coordinatorPathUsed: input.coordinatorPathUsed,
      blueprintContextLoaded: input.blueprintContextLoaded,
    };
  }
  const ti = s.tasks.findIndex((t) => t.taskId === input.taskId);
  if (ti >= 0) {
    const t = s.tasks[ti]!;
    if (t.lastRunId === input.runId) {
      s.tasks[ti] = {
        ...t,
        status: "blocked",
        lastRunStatus: terminal,
        lastRunSummary: "aborted",
        lastRunFinishedAt: now,
        lastRunErrorNote: input.errorMessage.slice(0, 500),
        updatedAt: now,
      };
    }
  }
  await writeState(kv, s);
}

/**
 * Appends coordinator-generated follow-up tasks (single KV write). Idempotent per
 * {@link decideFollowUpTaskSpecs} dedupe rules. Logs `coord_follow_up_task_create`.
 */
export async function appendFollowUpCoordinatorTasksAfterRun(
  env: Env,
  input: {
    projectId: string;
    parentTaskId: string;
    runId: string;
    result?: CodingCollaborationLoopResult | null;
    parentTitle?: string;
    abortMessage?: string | null;
  }
): Promise<{ createdTaskIds: string[]; skippedReasons: string[] }> {
  const skippedReasons: string[] = [];
  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    skippedReasons.push("no_kv");
    return { createdTaskIds: [], skippedReasons };
  }
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  const s = await readState(kv);
  if (!s.projects.some((p) => p.projectId === input.projectId)) {
    skippedReasons.push("project_missing");
    return { createdTaskIds: [], skippedReasons };
  }
  const projectTasks = s.tasks.filter((t) => t.projectId === input.projectId);
  const specs = decideFollowUpTaskSpecs({
    projectId: input.projectId,
    parentTaskId: input.parentTaskId,
    runId: input.runId,
    result: input.result ?? null,
    parentTitle: input.parentTitle,
    existingTasks: projectTasks,
    abortMessage: input.abortMessage ?? null,
  });
  if (specs.length === 0) {
    skippedReasons.push("policy_empty");
    return { createdTaskIds: [], skippedReasons };
  }
  const now = new Date().toISOString();
  const createdTaskIds: string[] = [];
  for (const spec of specs) {
    if (s.tasks.some((t) => t.taskId === spec.taskId)) {
      skippedReasons.push(`id_collision:${spec.taskId}`);
      continue;
    }
    const row: CoordinatorTask = {
      taskId: spec.taskId,
      projectId: spec.projectId,
      title: spec.title,
      description: spec.description,
      assignedRole: spec.assignedRole,
      status: "todo",
      acceptanceCriteria: spec.acceptanceCriteria,
      taskSource: spec.taskSource,
      parentTaskId: spec.parentTaskId,
      generationReason: spec.generationReason,
      spawnedByRunId: spec.spawnedByRunId,
      createdAt: now,
      updatedAt: now,
    };
    s.tasks.push(row);
    createdTaskIds.push(spec.taskId);
  }
  if (createdTaskIds.length > 0) {
    await writeState(kv, s);
    console.info(
      "coord_follow_up_task_create",
      JSON.stringify({
        runId: input.runId,
        parentTaskId: input.parentTaskId,
        projectId: input.projectId,
        createdTaskIds,
        reasons: specs.map((x) => x.generationReason),
      })
    );
  }
  return { createdTaskIds, skippedReasons };
}
