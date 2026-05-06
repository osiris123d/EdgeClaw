export interface ParsedProjectAutonomyResult {
  kind: "project_autonomy";
  stepsExecuted: number | null;
  /** Batch cap from the worker (`maxStepsRequested`) — same as Sub-Agents “Run N tasks”. */
  maxStepsRequested: number | null;
  stopReason: string | null;
  totalFollowUpsCreated: number | null;
  steps: Array<{
    taskId?: string;
    loopTerminalStatus?: string;
    selectionReason?: string;
  }>;
}

export interface ParsedGenericOrchestrationResult {
  kind: "generic_orchestrate";
  status: string | null;
  summaryForUser?: string;
}

export type ParsedLastOrchestrationResult = ParsedProjectAutonomyResult | ParsedGenericOrchestrationResult | null;

export function parseLastOrchestrationPayload(debugResult: string | null): ParsedLastOrchestrationResult {
  if (debugResult == null || debugResult.trim() === "") return null;
  try {
    const o = JSON.parse(debugResult) as Record<string, unknown>;
    if (o.autonomy === true && o.debug === true) {
      const steps = Array.isArray(o.steps)
        ? o.steps.map((x) => {
            const r = x as Record<string, unknown>;
            return {
              taskId: typeof r.taskId === "string" ? r.taskId : undefined,
              loopTerminalStatus: typeof r.loopTerminalStatus === "string" ? r.loopTerminalStatus : undefined,
              selectionReason: typeof r.selectionReason === "string" ? r.selectionReason : undefined,
            };
          })
        : [];
      return {
        kind: "project_autonomy",
        stepsExecuted: typeof o.stepsExecuted === "number" ? o.stepsExecuted : null,
        maxStepsRequested: typeof o.maxStepsRequested === "number" ? o.maxStepsRequested : null,
        stopReason: typeof o.stopReason === "string" ? o.stopReason : null,
        totalFollowUpsCreated: typeof o.totalFollowUpsCreated === "number" ? o.totalFollowUpsCreated : null,
        steps,
      };
    }
    if (typeof o.status === "string") {
      return {
        kind: "generic_orchestrate",
        status: o.status,
        ...(typeof o.summaryForUser === "string" ? { summaryForUser: o.summaryForUser } : {}),
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** User-facing explanation of `stopReason` (autonomy uses *iterations*, not total backlog tasks). */
export function formatAutonomyStopReasonHuman(parsed: ParsedProjectAutonomyResult): string {
  const sr = (parsed.stopReason ?? "").trim().toLowerCase();
  const exec = parsed.stepsExecuted;
  const cap = parsed.maxStepsRequested;
  if (sr === "max_steps_reached") {
    if (cap != null && exec != null) {
      return `Stopped because this batch hit its iteration limit (${exec}/${cap}). Each iteration runs one task through the loop — raise “Run N tasks” if you want more in one run.`;
    }
    return "Stopped because this batch hit its autonomy iteration limit (same cap as Run N tasks).";
  }
  return parsed.stopReason ?? "—";
}

function formatAutonomyStopTimelineSuffix(parsed: ParsedProjectAutonomyResult): string {
  const sr = (parsed.stopReason ?? "").trim().toLowerCase();
  const exec = parsed.stepsExecuted;
  const cap = parsed.maxStepsRequested;
  if (sr === "max_steps_reached") {
    if (exec != null && cap != null) {
      return `stop: batch iteration limit (${exec}/${cap})`;
    }
    return "stop: batch iteration limit reached";
  }
  return `stop: ${parsed.stopReason ?? "?"}`;
}

export function autonomyTimelineSummary(parsed: ParsedProjectAutonomyResult): string {
  const parts: string[] = [];
  for (const s of parsed.steps) {
    const id = s.taskId ?? "task";
    const st = s.loopTerminalStatus ?? "…";
    parts.push(`${id} → ${st}`);
  }
  if (parsed.totalFollowUpsCreated != null && parsed.totalFollowUpsCreated > 0) {
    parts.push(`follow-ups +${parsed.totalFollowUpsCreated}`);
  }
  if (parsed.stopReason) {
    parts.push(formatAutonomyStopTimelineSuffix(parsed));
  }
  return parts.length ? parts.join(" → ") : "—";
}
