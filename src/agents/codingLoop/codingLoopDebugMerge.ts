import type { CodingCollaborationLoopInput } from "./codingLoopTypes";

function truthyQuery(raw: string | null): boolean {
  if (raw == null || raw === "") return false;
  const t = raw.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

/**
 * Merge optional debug query params into coding-loop input (coordinator POST + optional `?…` on URL).
 */
export function mergeCodingLoopDebugQueryParams(
  input: CodingCollaborationLoopInput,
  searchParams: URLSearchParams
): CodingCollaborationLoopInput {
  const next: CodingCollaborationLoopInput = { ...input };
  const childTurn = searchParams.get("childTurn")?.trim().toLowerCase();
  if (childTurn === "stateless") {
    next.statelessSubAgentModelTurn = true;
  } else if (childTurn === "normal") {
    next.statelessSubAgentModelTurn = false;
  }
  if (truthyQuery(searchParams.get("disableSharedWorkspaceTools"))) {
    next.debugDisableSharedWorkspaceTools = true;
  }
  const maxIt = searchParams.get("maxIterations")?.trim();
  if (maxIt != null && maxIt !== "") {
    const n = parseInt(maxIt, 10);
    if (!Number.isNaN(n)) {
      next.maxIterations = n;
    }
  }
  return next;
}
