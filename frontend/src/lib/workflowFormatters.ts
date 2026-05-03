/**
 * workflowFormatters.ts
 *
 * Pure date / duration formatting utilities shared across workflow components:
 *   - DefinitionRow
 *   - WorkflowRunRow
 *   - WorkflowRunDrawer
 *   - WorkflowTimeline
 *
 * All functions return a dash ("—") on missing or invalid input.
 */

import type { WorkflowRunStatus } from "../types/workflows";

// ── Millisecond → human duration ──────────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms < 1_000)     return `${ms}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60)         return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ── ISO → relative "X ago" ────────────────────────────────────────────────────

export function fmtRelative(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m  = Math.floor(ms / 60_000);
    if (m < 1)  return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 7 ? `${d}d ago` : fmtAbsolute(iso);
  } catch {
    return "—";
  }
}

// ── ISO → absolute locale string ──────────────────────────────────────────────

export function fmtAbsolute(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ── Run elapsed time (for active runs shown in the drawer) ────────────────────

export function fmtElapsed(startedAt: string): string {
  try {
    const ms = Date.now() - new Date(startedAt).getTime();
    return ms < 0 ? "—" : `${fmtMs(ms)} elapsed`;
  } catch {
    return "—";
  }
}

// ── Run wall-clock duration (table column / drawer overview) ──────────────────

/**
 * Formats the wall-clock duration of a run.
 *
 * For active runs (`status` in ["running","waiting","paused"]) the duration
 * grows in real-time — pass `status` so the function knows to use `Date.now()`
 * as the end time.  For terminal runs, `completedAt` is used.
 */
const ACTIVE_RUN_STATUSES: ReadonlyArray<WorkflowRunStatus> = ["running", "waiting", "paused"];

export function fmtRunDuration(
  startedAt:   string,
  completedAt?: string | null,
  status?:      WorkflowRunStatus,
): string {
  const end = completedAt
    ? new Date(completedAt).getTime()
    : status && ACTIVE_RUN_STATUSES.includes(status)
      ? Date.now()
      : null;
  if (!end) return "—";
  try {
    const ms = end - new Date(startedAt).getTime();
    return ms < 0 ? "—" : fmtMs(ms);
  } catch {
    return "—";
  }
}

/**
 * Formats a completed run's total duration from `startedAt` → `completedAt`.
 * Returns "—" when `completedAt` is absent.
 */
export function fmtCompletedDuration(
  startedAt:  string,
  completedAt?: string | null,
): string {
  if (!completedAt) return "—";
  try {
    const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return ms < 0 ? "—" : fmtMs(ms);
  } catch {
    return "—";
  }
}
