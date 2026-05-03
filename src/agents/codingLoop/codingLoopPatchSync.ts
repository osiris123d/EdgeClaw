import type { SharedWorkspaceGateway } from "../../workspace/sharedWorkspaceTypes";

export async function listPendingPatchIds(
  gateway: SharedWorkspaceGateway,
  projectId: string
): Promise<string[]> {
  const r = await gateway.listPatchProposals("orchestrator", projectId);
  if ("error" in r) {
    return [];
  }
  return r.patches.filter((p) => p.status === "pending").map((p) => p.patchId);
}

export function diffNewPending(before: readonly string[], after: readonly string[]): string[] {
  const setBefore = new Set(before);
  return after.filter((id) => !setBefore.has(id));
}
