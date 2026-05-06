/** Matches SubAgents orchestration tab primary mode selector. */
export type PrimaryRunMode = "success" | "fail_revise";

/** Execution stop behavior for bounded project autonomy. */
export type ExecutionStopMode = "completion" | "review" | "failure" | "single_step";

export function httpOrchestrationModeFromPrimary(m: PrimaryRunMode): "success" | "fail_revise" {
  return m === "fail_revise" ? "fail_revise" : "success";
}

export function stopsFromExecutionMode(m: ExecutionStopMode): {
  stopOnReview: boolean;
  stopOnBlocked: boolean;
  stopOnFollowUp: boolean;
} {
  switch (m) {
    case "completion":
      return { stopOnReview: false, stopOnBlocked: false, stopOnFollowUp: false };
    case "review":
      return { stopOnReview: true, stopOnBlocked: false, stopOnFollowUp: false };
    case "failure":
      return { stopOnReview: false, stopOnBlocked: true, stopOnFollowUp: false };
    case "single_step":
      return { stopOnReview: true, stopOnBlocked: true, stopOnFollowUp: true };
    default:
      return { stopOnReview: true, stopOnBlocked: true, stopOnFollowUp: true };
  }
}

export interface ProjectAutonomyQueryOpts {
  sessionId: string;
  projectId: string;
  maxSteps: number;
  mode: "success" | "fail_revise";
  stops: { stopOnReview: boolean; stopOnBlocked: boolean; stopOnFollowUp: boolean };
  debugChildStateless: boolean;
  debugNoSharedTools: boolean;
  selectedOrchestrationTaskId: string | null;
  /** Empty omits override (server defaults apply). */
  orchCodingLoopMaxIterations: string;
}

/** Builds `/api/debug/project-autonomy` query string (Worker forwards unchanged semantics). */
export function buildProjectAutonomySearchParams(opts: ProjectAutonomyQueryOpts): URLSearchParams {
  const q = new URLSearchParams({
    session: opts.sessionId,
    projectId: opts.projectId,
    maxSteps: String(Math.min(3, Math.max(1, opts.maxSteps))),
    mode: opts.mode,
  });
  q.set("stopOnReview", opts.stops.stopOnReview ? "true" : "false");
  q.set("stopOnBlocked", opts.stops.stopOnBlocked ? "true" : "false");
  q.set("stopOnFollowUpTasks", opts.stops.stopOnFollowUp ? "true" : "false");
  if (opts.debugChildStateless) {
    q.set("childTurn", "stateless");
  }
  if (opts.debugNoSharedTools) {
    q.set("disableSharedWorkspaceTools", "true");
  }
  const tid = opts.selectedOrchestrationTaskId?.trim();
  if (tid) q.set("taskId", tid);
  const mi = opts.orchCodingLoopMaxIterations.trim();
  if (mi) q.set("codingLoopMaxIterations", mi);
  return q;
}
