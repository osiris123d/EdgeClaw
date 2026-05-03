import type { CodingCollaborationLoopResult } from "./codingLoopTypes";

/** Cloudflare tears down in-flight DOs when Worker code is published; Agents surfaces it as SqlError. */
export function isDurableObjectCodeUpdateResetError(err: string | undefined): boolean {
  const s = typeof err === "string" ? err : "";
  return s.includes("Durable Object reset because its code was updated");
}

/**
 * Detect deploy-time DO reset from a finished coding-loop / orchestration result (summary, audit rows,
 * or iteration summaries).
 */
export function orchestrationResultIndicatesDeployReset(result: CodingCollaborationLoopResult): boolean {
  if (isDurableObjectCodeUpdateResetError(result.summaryForUser)) return true;
  for (const a of result.subagentTurnAudit ?? []) {
    if (isDurableObjectCodeUpdateResetError(a.responsePreview)) return true;
  }
  for (const it of result.iterations) {
    if (isDurableObjectCodeUpdateResetError(it.coderSummary.error)) return true;
    if (isDurableObjectCodeUpdateResetError(it.testerSummary.error)) return true;
  }
  return false;
}
