import type {
  CodingCollaborationLoopResult,
  CodingIterationRecord,
} from "../agents/codingLoop/codingLoopTypes";
import type { CoordinatorTask } from "../coordinatorControlPlane/types";
import { OrchestrationBlueprintError } from "../coordinatorControlPlane/projectBlueprintOrchestrationContext";

export type DebugOrchestrationMode = "success" | "fail_revise";

export type DebugChildTurnMode = "normal" | "stateless";

/** Debug-only options for `runDebugOrchestrationScenario` (HTTP + RPC). */
export interface DebugOrchestrationRunOptions {
  /** `normal` = stateful `rpcCollectChatTurn`; `stateless` = `rpcCollectStatelessModelTurn`. */
  childTurn?: DebugChildTurnMode;
  /** When true, child omits shared_workspace_* tools for this run (message prefix protocol). */
  disableSharedWorkspaceTools?: boolean;
  /** Override coding-loop iteration cap (defaults mode-based). */
  maxIterations?: number;
  /**
   * Control-plane registry project id — MainAgent loads blueprint from KV and uses
   * that row's `sharedProjectId` for the shared workspace. Requires readiness === ready.
   */
  controlPlaneProjectId?: string;
  /**
   * Optional control-plane task id — requires {@link controlPlaneProjectId}; must belong to that
   * project and be runnable (todo | in_progress | review).
   */
  controlPlaneTaskId?: string;
  /**
   * Agent session id (DO name) for control-plane run rows — same as `?session=` on `/api/debug/orchestrate`.
   * Defaults to `default` when missing or invalid.
   */
  sessionId?: string;
}

export interface DebugOrchestrationScenarioOutcome {
  result: CodingCollaborationLoopResult;
  iterationTrace: string[];
  childTurnModeUsed: DebugChildTurnMode;
  sharedWorkspaceToolsEnabled: boolean;
  orchestrationMeta?: {
    projectIdUsed: string | null;
    taskIdUsed: string | null;
    blueprintContextLoaded: boolean;
    blueprintReadiness?: string;
    /** How blueprint markdown was built for coder/tester (from loop result). */
    blueprintContextAssembly?: "task_scoped" | "full_fallback" | "preformatted" | null;
    /** True when MainAgent delegated the loop via `SUBAGENT_COORDINATOR` (vs in-DO fallback). */
    coordinatorPathUsed?: boolean;
    /** True when a task-backed run row was written to control-plane KV. */
    controlPlaneRunRecorded?: boolean;
    /** Run id in KV when {@link controlPlaneRunRecorded} is true. */
    controlPlaneRunId?: string | null;
    /** Follow-up task ids appended after this run (coordinator policy). */
    followUpTasksCreated?: string[];
    /** Why follow-up creation was skipped or partial (debug audit). */
    followUpTasksSkipped?: string[];
  };
}

export interface DebugOrchestrationRunner {
  runDebugOrchestrationScenario(
    mode: DebugOrchestrationMode,
    entry: "http" | "rpc",
    runOptions?: DebugOrchestrationRunOptions
  ): Promise<DebugOrchestrationScenarioOutcome>;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function parseDebugOrchestrationMode(raw: string | undefined): DebugOrchestrationMode {
  const m = (raw ?? "success").trim().toLowerCase();
  if (m === "fail_revise" || m === "fail-revise") return "fail_revise";
  return "success";
}

export function parseDebugChildTurnMode(raw: string | undefined): DebugChildTurnMode {
  const t = (raw ?? "normal").trim().toLowerCase();
  if (t === "stateless") return "stateless";
  return "normal";
}

export function parseCodingLoopMaxIterations(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

export function parseDebugDisableSharedTools(raw: string | undefined): boolean {
  const t = (raw ?? "").trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function parseControlPlaneProjectId(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  return s && s.length > 0 ? s : undefined;
}

function parseControlPlaneTaskId(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  return s && s.length > 0 ? s : undefined;
}

/** Align with Worker → DO session gate in `forwardDebugOrchestration.ts`. */
export function parseDebugOrchestrationSessionId(raw: string | undefined): string {
  const s = (raw ?? "default").trim();
  if (s.length > 0 && s.length <= 128 && /^[a-zA-Z0-9_.-]+$/.test(s)) return s;
  return "default";
}

function debugOrchestrationTail(mode: DebugOrchestrationMode): string {
  return mode === "fail_revise"
    ? "Goal: revision loop. Iteration 1: use shared_workspace tools to create one pending patch with id " +
        "exactly `debug-orch-rev-1` that is intentionally incomplete or wrong so the tester can FAIL. " +
        "Later iterations: fix via a new pending patch id `debug-orch-rev-2` (or overwrite pending per tool rules). " +
        "Keep scope tiny; direct file writes only under `staging/`."
    : "Propose exactly one minimal pending patch via shared_workspace tools with patch id `debug-orch-success`. " +
        "Use a tiny safe diff (comment or staging note only). Avoid unrelated changes.";
}

/**
 * Manager task string for {@link runCodingCollaborationLoop}: optional task unit + existing debug patch protocol.
 */
export function buildDebugOrchestrationManagerTask(
  mode: DebugOrchestrationMode,
  sharedProjectId: string,
  taskContext?: { task: CoordinatorTask; projectDisplayName: string }
): string {
  const tail = debugOrchestrationTail(mode);
  const header = `[DEBUG ORCHESTRATION — shared workspace project ${sharedProjectId}]\n`;
  if (!taskContext) {
    return header + tail;
  }
  const { task, projectDisplayName } = taskContext;
  const taskBlock = [
    "## Primary work unit (control-plane task)",
    `- **project (display):** ${projectDisplayName}`,
    `- **controlPlaneProjectId:** ${task.projectId}`,
    `- **taskId:** ${task.taskId}`,
    `- **title:** ${task.title}`,
    `- **description:** ${task.description}`,
    `- **acceptanceCriteria:** ${task.acceptanceCriteria}`,
    `- **assignedRole:** ${task.assignedRole}`,
    `- **status:** ${task.status}`,
    "",
    "Work toward fulfilling this task while following the debug patch protocol below.",
    "",
    header,
    tail,
  ].join("\n");
  return taskBlock;
}

export function resolveDebugOrchestrateRequestFieldsSync(url: URL): {
  mode: DebugOrchestrationMode;
  childTurn: DebugChildTurnMode;
  disableSharedTools: boolean;
  maxIterations?: number;
  controlPlaneProjectId?: string;
  controlPlaneTaskId?: string;
  sessionId: string;
} {
  const disableSharedFrom =
    parseDebugDisableSharedTools(url.searchParams.get("noSharedTools") ?? undefined) ||
    parseDebugDisableSharedTools(url.searchParams.get("disableSharedWorkspaceTools") ?? undefined);
  return {
    mode: parseDebugOrchestrationMode(url.searchParams.get("mode") ?? undefined),
    childTurn: parseDebugChildTurnMode(url.searchParams.get("childTurn") ?? undefined),
    disableSharedTools: disableSharedFrom,
    maxIterations: parseCodingLoopMaxIterations(url.searchParams.get("maxIterations") ?? undefined),
    controlPlaneProjectId: parseControlPlaneProjectId(url.searchParams.get("projectId") ?? undefined),
    controlPlaneTaskId: parseControlPlaneTaskId(url.searchParams.get("taskId") ?? undefined),
    sessionId: parseDebugOrchestrationSessionId(url.searchParams.get("session") ?? undefined),
  };
}

export async function resolveDebugOrchestrateRequestFields(
  request: Request,
  url: URL
): Promise<{
  mode: DebugOrchestrationMode;
  childTurn: DebugChildTurnMode;
  disableSharedTools: boolean;
  maxIterations?: number;
  controlPlaneProjectId?: string;
  controlPlaneTaskId?: string;
  sessionId: string;
}> {
  if (request.method === "GET") {
    return resolveDebugOrchestrateRequestFieldsSync(url);
  }
  if (request.method === "POST") {
    const ct = request.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await request.json()) as {
          mode?: string;
          childTurn?: string;
          noSharedTools?: string | boolean;
          maxIterations?: number;
          projectId?: string;
          taskId?: string;
          sessionId?: string;
        };
        const fromUrl = parseControlPlaneProjectId(url.searchParams.get("projectId") ?? undefined);
        const fromUrlTask = parseControlPlaneTaskId(url.searchParams.get("taskId") ?? undefined);
        const sessionFromUrl = parseDebugOrchestrationSessionId(url.searchParams.get("session") ?? undefined);
        const disableSharedBody =
          typeof body.noSharedTools === "boolean"
            ? body.noSharedTools
            : parseDebugDisableSharedTools(
                typeof body.noSharedTools === "string" ? body.noSharedTools : undefined
              );
        const disableSharedUrl =
          parseDebugDisableSharedTools(url.searchParams.get("noSharedTools") ?? undefined) ||
          parseDebugDisableSharedTools(url.searchParams.get("disableSharedWorkspaceTools") ?? undefined);
        return {
          mode: parseDebugOrchestrationMode(body.mode),
          childTurn: parseDebugChildTurnMode(
            typeof body.childTurn === "string" ? body.childTurn : undefined
          ),
          disableSharedTools: disableSharedBody || disableSharedUrl,
          maxIterations:
            typeof body.maxIterations === "number"
              ? body.maxIterations
              : parseCodingLoopMaxIterations(url.searchParams.get("maxIterations") ?? undefined),
          controlPlaneProjectId:
            parseControlPlaneProjectId(typeof body.projectId === "string" ? body.projectId : undefined) ??
            fromUrl,
          controlPlaneTaskId:
            parseControlPlaneTaskId(typeof body.taskId === "string" ? body.taskId : undefined) ?? fromUrlTask,
          sessionId:
            typeof body.sessionId === "string" && body.sessionId.trim()
              ? parseDebugOrchestrationSessionId(body.sessionId)
              : sessionFromUrl,
        };
      } catch {
        return resolveDebugOrchestrateRequestFieldsSync(url);
      }
    }
  }
  return resolveDebugOrchestrateRequestFieldsSync(url);
}

function summarizeIterationRecord(r: CodingIterationRecord): Record<string, unknown> {
  return {
    iteration: r.iteration,
    subAgentSuffix: r.subAgentSuffix,
    newPendingPatchIds: r.newPendingPatchIds,
    pendingPatchIdsAfterCoder: r.pendingPatchIdsAfterCoder,
    activePatchIdsForIteration: r.activePatchIdsForIteration,
    testerVerdict: r.testerVerdict,
    testerVerdictScope: r.testerVerdictScope,
    managerDecision: r.managerDecision,
    revisionReasonCategory: r.revisionReasonCategory,
    coderSummary: r.coderSummary,
    testerSummary: r.testerSummary,
  };
}

export function formatDebugOrchestrationResponseBody(input: {
  mode: DebugOrchestrationMode;
  result: CodingCollaborationLoopResult;
  iterationTrace: string[];
  childTurnModeUsed?: DebugChildTurnMode;
  sharedWorkspaceToolsForCoderTester?: "enabled" | "disabled";
  orchestrationMeta?: DebugOrchestrationScenarioOutcome["orchestrationMeta"];
}): Record<string, unknown> {
  const {
    result,
    iterationTrace,
    mode,
    childTurnModeUsed,
    sharedWorkspaceToolsForCoderTester,
    orchestrationMeta,
  } = input;
  const verdicts = result.iterations.map((it) => ({
    iteration: it.iteration,
    verdict: it.testerVerdict,
    managerDecision: it.managerDecision,
  }));
  const patchIdSet = new Set<string>();
  for (const it of result.iterations) {
    for (const id of it.pendingPatchIdsAfterCoder) patchIdSet.add(id);
    for (const id of it.newPendingPatchIds) patchIdSet.add(id);
    for (const id of it.activePatchIdsForIteration) patchIdSet.add(id);
  }
  const patchIds = [...patchIdSet].sort();

  return {
    debug: true,
    mode,
    status: result.status,
    summaryForUser: result.summaryForUser,
    iterations: result.iterations.map((it) => summarizeIterationRecord(it)),
    patchIds,
    verdicts,
    /** Same iteration summaries as JSON strings (legacy tail / scripts). */
    iterationTrace,
    ...(childTurnModeUsed != null ? { childTurnModeUsed } : {}),
    ...(sharedWorkspaceToolsForCoderTester != null ? { sharedWorkspaceToolsForCoderTester } : {}),
    ...(orchestrationMeta
      ? {
          projectIdUsed: orchestrationMeta.projectIdUsed ?? null,
          taskIdUsed: orchestrationMeta.taskIdUsed ?? null,
          blueprintContextLoaded: orchestrationMeta.blueprintContextLoaded,
          ...(orchestrationMeta.blueprintReadiness !== undefined
            ? { blueprintReadiness: orchestrationMeta.blueprintReadiness }
            : {}),
          ...(orchestrationMeta.blueprintContextAssembly !== undefined &&
          orchestrationMeta.blueprintContextAssembly !== null
            ? { blueprintContextAssembly: orchestrationMeta.blueprintContextAssembly }
            : {}),
          ...(orchestrationMeta.coordinatorPathUsed !== undefined
            ? { coordinatorPathUsed: orchestrationMeta.coordinatorPathUsed }
            : {}),
          ...(orchestrationMeta.controlPlaneRunRecorded === true
            ? {
                controlPlaneRunRecorded: true,
                controlPlaneRunId: orchestrationMeta.controlPlaneRunId ?? null,
              }
            : {}),
          ...(orchestrationMeta.followUpTasksCreated?.length
            ? { followUpTasksCreated: orchestrationMeta.followUpTasksCreated }
            : {}),
          ...(orchestrationMeta.followUpTasksSkipped?.length
            ? { followUpTasksSkipped: orchestrationMeta.followUpTasksSkipped }
            : {}),
        }
      : {}),
  };
}

/**
 * MainAgent DO handler for `/debug/orchestrate` (rewritten from `/api/debug/orchestrate`).
 */
export async function handleDebugOrchestrateDoRequest(
  request: Request,
  runner: DebugOrchestrationRunner
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  console.info(
    "debug_orchestrate_do_handler_enter",
    JSON.stringify({ method: request.method, pathname: url.pathname })
  );

  const fields = await resolveDebugOrchestrateRequestFields(request, url);

  try {
    const outcome = await runner.runDebugOrchestrationScenario(fields.mode, "http", {
      childTurn: fields.childTurn,
      disableSharedWorkspaceTools: fields.disableSharedTools,
      ...(fields.maxIterations != null ? { maxIterations: fields.maxIterations } : {}),
      controlPlaneProjectId: fields.controlPlaneProjectId,
      controlPlaneTaskId: fields.controlPlaneTaskId,
      sessionId: fields.sessionId,
    });
    const { result, iterationTrace, childTurnModeUsed, sharedWorkspaceToolsEnabled, orchestrationMeta } = outcome;
    return json(
      formatDebugOrchestrationResponseBody({
        mode: fields.mode,
        result,
        iterationTrace,
        childTurnModeUsed,
        sharedWorkspaceToolsForCoderTester: sharedWorkspaceToolsEnabled ? "enabled" : "disabled",
        orchestrationMeta,
      }),
      200
    );
  } catch (e) {
    if (e instanceof OrchestrationBlueprintError) {
      return json({ error: e.message, debug: true }, e.statusCode);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg, debug: true }, 500);
  }
}
