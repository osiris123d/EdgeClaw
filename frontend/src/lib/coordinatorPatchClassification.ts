/**
 * Classification helpers for shared-workspace patch ids (control plane + UI).
 * Keep in sync with `src/coordinatorControlPlane/patchClassification.ts`.
 */
export function isDebugSystemPatchId(patchId: string): boolean {
  const id = patchId.trim().toLowerCase();
  return id.startsWith("debug-orch");
}
