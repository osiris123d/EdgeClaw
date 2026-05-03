/**
 * LiveConnectionBadge
 *
 * Subtle pill indicator for the live-update connection state shown in the
 * Runs toolbar.  Renders nothing when disconnected (fallback: user can refresh
 * manually).
 */

import type { LiveConnectionState } from "../../lib/workflowRunUpdates";

interface LiveConnectionBadgeProps {
  state: LiveConnectionState;
}

export function LiveConnectionBadge({ state }: LiveConnectionBadgeProps) {
  if (state === "disconnected") return null;

  const isReconnecting = state === "reconnecting";

  return (
    <span
      className={`wf-live-badge${isReconnecting ? " wf-live-badge--reconnecting" : ""}`}
      title={isReconnecting ? "Connection interrupted — reconnecting…" : "Receiving live run updates"}
      aria-label={isReconnecting ? "Reconnecting to live updates" : "Live updates connected"}
    >
      <span className="wf-live-dot" aria-hidden="true" />
      {isReconnecting ? "Reconnecting…" : "Live"}
    </span>
  );
}
