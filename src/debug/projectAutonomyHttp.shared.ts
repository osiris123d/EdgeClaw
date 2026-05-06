import {
  parseCodingLoopMaxIterations,
  parseDebugChildTurnMode,
  parseDebugDisableSharedTools,
  parseDebugOrchestrationMode,
  parseDebugOrchestrationSessionId,
  type DebugChildTurnMode,
  type DebugOrchestrationMode,
} from "./debugOrchestrationHttp";
import type { ProjectAutonomyScenarioResult } from "./projectAutonomyTypes";

export interface ProjectAutonomyScenarioInput {
  projectId: string;
  sessionId: string;
  maxSteps: number;
  stopOnReview: boolean;
  stopOnBlocked: boolean;
  stopOnFollowUpTasks: boolean;
  mode: DebugOrchestrationMode;
  /** Optional child RPC mode for orchestration (`normal` = stateful collect chat turn). */
  childTurn?: DebugChildTurnMode;
  disableSharedWorkspaceTools?: boolean;
  codingLoopMaxIterations?: number;
  /** Run this task id directly when set (`todo` / `in_progress` / `review` rules apply). */
  taskId?: string;
}

export interface ProjectAutonomyRunner {
  runProjectAutonomyScenario(input: ProjectAutonomyScenarioInput): Promise<ProjectAutonomyScenarioResult>;
}

/** Worker attaches edge query string so DO parsing survives runtimes that strip `?` from stub.fetch URLs. */
export const DEBUG_PROJECT_AUTONOMY_FORWARDED_QUERY_HEADER =
  "X-Edgeclaw-Debug-Project-Autonomy-Query";

/** Prefer forwarded query from Worker when present (authoritative copy of edge URL search). */
export function urlForProjectAutonomyParsing(request: Request): URL {
  const base = new URL(request.url);
  const forwarded = request.headers.get(DEBUG_PROJECT_AUTONOMY_FORWARDED_QUERY_HEADER);
  if (forwarded != null && forwarded.trim() !== "") {
    return new URL(`${base.origin}${base.pathname}?${forwarded}`);
  }
  return base;
}

function parseBoolParam(raw: string | null, defaultTrue: boolean): boolean {
  if (raw == null || raw === "") return defaultTrue;
  const t = raw.trim().toLowerCase();
  if (t === "0" || t === "false" || t === "no" || t === "off") return false;
  return true;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export async function parseProjectAutonomyRequest(
  request: Request,
  url: URL
): Promise<ProjectAutonomyScenarioInput> {
  if (request.method === "GET") {
    const projectId = url.searchParams.get("projectId")?.trim();
    if (!projectId) throw new Error("projectId is required");
    const maxSteps = clampInt(parseInt(url.searchParams.get("maxSteps") ?? "1", 10), 1, 3);
    const input: ProjectAutonomyScenarioInput = {
      projectId,
      sessionId: parseDebugOrchestrationSessionId(url.searchParams.get("session") ?? undefined),
      maxSteps,
      stopOnReview: parseBoolParam(url.searchParams.get("stopOnReview"), true),
      stopOnBlocked: parseBoolParam(url.searchParams.get("stopOnBlocked"), true),
      stopOnFollowUpTasks: parseBoolParam(url.searchParams.get("stopOnFollowUpTasks"), true),
      mode: parseDebugOrchestrationMode(url.searchParams.get("mode") ?? undefined),
    };
    const ct = url.searchParams.get("childTurn");
    if (ct != null && ct.trim() !== "") {
      input.childTurn = parseDebugChildTurnMode(ct);
    }
    if (url.searchParams.has("disableSharedWorkspaceTools")) {
      input.disableSharedWorkspaceTools = parseDebugDisableSharedTools(
        url.searchParams.get("disableSharedWorkspaceTools") ?? undefined
      );
    }
    if (url.searchParams.has("codingLoopMaxIterations")) {
      const n = parseCodingLoopMaxIterations(url.searchParams.get("codingLoopMaxIterations") ?? undefined);
      if (n != null) input.codingLoopMaxIterations = n;
    }
    const taskIdPick = url.searchParams.get("taskId")?.trim();
    if (taskIdPick) input.taskId = taskIdPick;
    return input;
  }

  if (request.method === "POST") {
    const ct = request.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await request.json()) as {
        projectId?: string;
        sessionId?: string;
        maxSteps?: number;
        stopOnReview?: boolean;
        stopOnBlocked?: boolean;
        stopOnFollowUpTasks?: boolean;
        mode?: string;
        childTurn?: string;
        disableSharedWorkspaceTools?: boolean;
        codingLoopMaxIterations?: number;
        taskId?: string;
      };
      const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
      if (!projectId) throw new Error("projectId is required");
      const maxSteps = clampInt(
        typeof body.maxSteps === "number" ? body.maxSteps : parseInt(String(body.maxSteps ?? 1), 10),
        1,
        3
      );
      const input: ProjectAutonomyScenarioInput = {
        projectId,
        sessionId:
          typeof body.sessionId === "string"
            ? parseDebugOrchestrationSessionId(body.sessionId)
            : parseDebugOrchestrationSessionId(url.searchParams.get("session") ?? undefined),
        maxSteps,
        stopOnReview: typeof body.stopOnReview === "boolean" ? body.stopOnReview : true,
        stopOnBlocked: typeof body.stopOnBlocked === "boolean" ? body.stopOnBlocked : true,
        stopOnFollowUpTasks: typeof body.stopOnFollowUpTasks === "boolean" ? body.stopOnFollowUpTasks : true,
        mode: parseDebugOrchestrationMode(typeof body.mode === "string" ? body.mode : undefined),
      };
      if (typeof body.childTurn === "string" && body.childTurn.trim()) {
        input.childTurn = parseDebugChildTurnMode(body.childTurn);
      } else if (url.searchParams.has("childTurn")) {
        input.childTurn = parseDebugChildTurnMode(url.searchParams.get("childTurn") ?? undefined);
      }
      if (typeof body.disableSharedWorkspaceTools === "boolean") {
        input.disableSharedWorkspaceTools = body.disableSharedWorkspaceTools;
      } else if (url.searchParams.has("disableSharedWorkspaceTools")) {
        input.disableSharedWorkspaceTools = parseDebugDisableSharedTools(
          url.searchParams.get("disableSharedWorkspaceTools") ?? undefined
        );
      }
      if (typeof body.codingLoopMaxIterations === "number") {
        input.codingLoopMaxIterations = body.codingLoopMaxIterations;
      } else if (url.searchParams.has("codingLoopMaxIterations")) {
        const n = parseCodingLoopMaxIterations(url.searchParams.get("codingLoopMaxIterations") ?? undefined);
        if (n != null) input.codingLoopMaxIterations = n;
      }
      const postTaskId =
        typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : "";
      if (postTaskId) input.taskId = postTaskId;
      else {
        const urlTaskId = url.searchParams.get("taskId")?.trim();
        if (urlTaskId) input.taskId = urlTaskId;
      }
      return input;
    }
  }

  throw new Error("Unsupported request — use GET with query params or POST JSON");
}
