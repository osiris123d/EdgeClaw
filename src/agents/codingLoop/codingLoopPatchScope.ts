/**
 * Resolve which patch ids the tester should focus on for this iteration.
 */

export function resolveActivePatchIdsForVerification(input: {
  /** When set, tester verifies exactly this set (manager-scoped). */
  focusPatchIds?: readonly string[];
  /** When true (default), prefer ids introduced this iteration over full pending list. */
  scopeTesterToNewPatchesOnly: boolean;
  newPendingPatchIds: readonly string[];
  pendingAfterCoder: readonly string[];
}): string[] {
  if (input.focusPatchIds != null && input.focusPatchIds.length > 0) {
    const allow = new Set(input.pendingAfterCoder);
    return [...input.focusPatchIds].filter((id) => allow.has(id));
  }
  if (input.scopeTesterToNewPatchesOnly && input.newPendingPatchIds.length > 0) {
    return [...input.newPendingPatchIds];
  }
  return [...input.pendingAfterCoder];
}
