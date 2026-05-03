import { parseDebugOrchestrationMode, parseDebugOrchestrationSessionId } from "./debugOrchestrationHttp";
import type { DebugOrchestrationMode } from "./debugOrchestrationHttp";
import type { ProjectAutonomyScenarioResult } from "./projectAutonomyTypes";

export interface ProjectAutonomyScenarioInput {
  projectId: string;
  sessionId: string;
  maxSteps: number;
  stopOnReview: boolean;
  stopOnBlocked: boolean;
  stopOnFollowUpTasks: boolean;
  mode: DebugOrchestrationMode;
}

export interface ProjectAutonomyRunner {
  runProjectAutonomyScenario(input: ProjectAutonomyScenarioInput): Promise<ProjectAutonomyScenarioResult>;
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
    return {
      projectId,
      sessionId: parseDebugOrchestrationSessionId(url.searchParams.get("session") ?? undefined),
      maxSteps,
      stopOnReview: parseBoolParam(url.searchParams.get("stopOnReview"), true),
      stopOnBlocked: parseBoolParam(url.searchParams.get("stopOnBlocked"), true),
      stopOnFollowUpTasks: parseBoolParam(url.searchParams.get("stopOnFollowUpTasks"), true),
      mode: parseDebugOrchestrationMode(url.searchParams.get("mode") ?? undefined),
    };
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
      };
      const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
      if (!projectId) throw new Error("projectId is required");
      const maxSteps = clampInt(
        typeof body.maxSteps === "number" ? body.maxSteps : parseInt(String(body.maxSteps ?? 1), 10),
        1,
        3
      );
      return {
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
    }
  }

  throw new Error("Unsupported request — use GET with query params or POST JSON");
}
