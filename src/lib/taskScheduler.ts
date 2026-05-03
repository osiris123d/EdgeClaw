/**
 * taskScheduler.ts
 *
 * Adapter functions that translate UI task schedule fields into the correct
 * Cloudflare Agents SDK scheduling calls.
 *
 * ── Cloudflare Agents scheduling primitives ───────────────────────────────────
 *
 * The Agent base class exposes two scheduling methods (verified against
 * node_modules/agents/dist/index-D49HdAiY.d.ts):
 *
 *   this.schedule(when, callbackName, payload?, options?)
 *     → Promise<Schedule<T>>
 *     `when` is one of:
 *       Date   — fire once at a specific wall-clock time
 *       string — recurring cron expression (5-field, e.g. "0 9 * * 1-5")
 *       number — fire once after N seconds from now (delayed)
 *
 *   this.scheduleEvery(intervalSeconds, callbackName, payload?, options?)
 *     → Promise<Schedule<T>>
 *     Fires repeatedly at a fixed interval.
 *     Idempotent by default: same callback + intervalSeconds + payload
 *     returns the existing schedule handle instead of creating a duplicate.
 *
 *   this.getSchedules(criteria?): Schedule<T>[]   ← synchronous, NOT a Promise
 *
 *   this.cancelSchedule(id): Promise<boolean>      ← returns boolean
 *
 * NOTE: There is NO `{ every: number }` or `{ cron: string }` object shape
 * accepted by `schedule()`. Those shapes do not exist in the real SDK.
 * Intervals MUST use `scheduleEvery()`; cron MUST pass the expression string
 * directly to `schedule()`.
 *
 * ── Interval expression format ────────────────────────────────────────────────
 *
 * The UI stores interval schedules as human-readable strings, e.g.:
 *   "every 5m"  |  "every 2h"  |  "every 1d"  |  "every 30s"
 *   "every 5 minutes"  |  "every 2 hours"  |  "every 1 day"
 *
 * `parseIntervalSeconds()` converts these to a second count for CF Agents.
 * `secondsToIntervalExpression()` does the reverse for chat-created tasks.
 */

import type { PersistedTask, ScheduleType } from "./taskPersistence";

// ── SDK-compatible types ───────────────────────────────────────────────────────

/**
 * The shape returned by `this.schedule()`, `this.scheduleEvery()`, and
 * elements yielded by `this.getSchedules()`.
 *
 * Mirrors the `Schedule<T>` generic from the `agents` package.
 * Only `id` and `type` are required for our purposes; other fields may vary.
 */
export interface ScheduleHandle {
  id: string;
  callback: string;
  /** SDK-defined schedule type — matches the method used to create it. */
  type: "scheduled" | "delayed" | "cron" | "interval";
  /** Unix timestamp (ms) of the next planned execution. */
  time: number;
  payload?: unknown;
}

/**
 * Subset of the `Agent` class scheduling surface used by MainAgent task methods.
 *
 * Signatures verified against the real agents SDK typings.
 * Cast `this` to this interface at call sites:
 *   const scheduler = this as unknown as SchedulingAgent;
 */
export interface SchedulingAgent {
  /** Fire once at a Date, once after N seconds, or repeatedly on a cron string. */
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { retry?: unknown; idempotent?: boolean }
  ): Promise<ScheduleHandle>;

  /** Fire repeatedly at a fixed interval of `intervalSeconds` seconds. */
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: unknown,
    options?: { retry?: unknown; _idempotent?: boolean }
  ): Promise<ScheduleHandle>;

  /** List scheduled tasks — synchronous, returns an array directly. */
  getSchedules(criteria?: {
    id?: string;
    type?: "scheduled" | "delayed" | "cron" | "interval";
    timeRange?: { start?: Date; end?: Date };
  }): ScheduleHandle[];

  /** Cancel a scheduled task by ID. Returns true if found and cancelled. */
  cancelSchedule(id: string): Promise<boolean>;
}

// ── Schedule instruction (discriminated union) ─────────────────────────────────

/**
 * Instruction returned by `buildScheduleInstruction()`.
 *
 * Use the `method` field to decide which Agent SDK primitive to call:
 *
 *   "schedule"      → await scheduler.schedule(when, callback, payload)
 *   "scheduleEvery" → await scheduler.scheduleEvery(intervalSeconds, callback, payload)
 *
 * This separation is necessary because `schedule()` and `scheduleEvery()` are
 * distinct SDK methods — there is no `{ every: n }` object shape in the API.
 */
export type ScheduleInstruction =
  | { method: "schedule"; when: Date | string }
  | { method: "scheduleEvery"; intervalSeconds: number };

// ── Interval parsing ───────────────────────────────────────────────────────────

/**
 * Multipliers keyed by unit alias.
 * Longest aliases first so the regex matches "minutes" before "m".
 */
const UNIT_MAP: Array<[pattern: RegExp, seconds: number]> = [
  [/^(seconds?|secs?|s)$/i, 1],
  [/^(minutes?|mins?|m)$/i, 60],
  [/^(hours?|hrs?|h)$/i, 3_600],
  [/^(days?|d)$/i, 86_400],
  [/^(weeks?|w)$/i, 604_800],
];

/**
 * Parse a human-readable interval expression into whole seconds.
 *
 * Accepted formats:
 *   "every 30s"   "every 5m"   "every 2h"   "every 1d"   "every 2w"
 *   "every 30 seconds"  "every 5 minutes"  "every 2 hours"  etc.
 *   Bare integers (e.g. "3600") are interpreted as seconds.
 *
 * Returns null when the expression is unrecognised.
 */
export function parseIntervalSeconds(expression: string): number | null {
  const trimmed = expression.trim().toLowerCase();

  // Accept bare numbers (interpreted as seconds).
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? n : null;
  }

  // Accept "every <n> <unit>" or "every <n><unit>".
  const match = /^every\s+(\d+)\s*([a-z]+)$/i.exec(trimmed);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  const unit = match[2];

  for (const [pattern, multiplier] of UNIT_MAP) {
    if (pattern.test(unit)) {
      return n > 0 ? n * multiplier : null;
    }
  }

  return null;
}

// ── Interval formatting ────────────────────────────────────────────────────────

/**
 * Convert a raw second count to a compact human-readable interval expression
 * compatible with `parseIntervalSeconds()`.
 *
 * Used when chat-created tasks supply a numeric interval directly.
 *
 * Examples:
 *   3600   → "every 1h"
 *   86400  → "every 1d"
 *   604800 → "every 1w"
 *   90     → "every 90s"
 */
export function secondsToIntervalExpression(seconds: number): string {
  if (seconds % 604_800 === 0) return `every ${seconds / 604_800}w`;
  if (seconds % 86_400 === 0)  return `every ${seconds / 86_400}d`;
  if (seconds % 3_600 === 0)   return `every ${seconds / 3_600}h`;
  if (seconds % 60 === 0)      return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

// ── Schedule instruction builder ───────────────────────────────────────────────

/**
 * Translate a task's schedule fields into a `ScheduleInstruction` that tells
 * the caller which Agent SDK method to invoke and with what arguments.
 *
 *   "once"     → { method: "schedule",      when: Date          }
 *   "cron"     → { method: "schedule",      when: string        }  (cron expr)
 *   "interval" → { method: "scheduleEvery", intervalSeconds: n  }
 *
 * Returns null when the expression is invalid so callers can surface a
 * validation error rather than registering a broken schedule.
 */
export function buildScheduleInstruction(
  scheduleType: ScheduleType,
  scheduleExpression: string
): ScheduleInstruction | null {
  const expr = scheduleExpression.trim();
  if (!expr) return null;

  switch (scheduleType) {
    case "once": {
      const d = new Date(expr);
      return isNaN(d.getTime()) ? null : { method: "schedule", when: d };
    }

    case "interval": {
      const seconds = parseIntervalSeconds(expr);
      return seconds !== null
        ? { method: "scheduleEvery", intervalSeconds: seconds }
        : null;
    }

    case "cron": {
      // Minimal validation: must have at least 5 space-separated fields.
      const parts = expr.split(/\s+/);
      return parts.length >= 5
        ? { method: "schedule", when: expr }
        : null;
    }
  }
}

// ── Next-run estimation ────────────────────────────────────────────────────────

/**
 * Best-effort ISO timestamp for when a newly scheduled task will first fire.
 *
 * Stored in the task record for display purposes only.  It is NOT a live
 * countdown — it drifts from the real next-fire time as the agent runs.
 * Call `nextRunAtAfterFire()` inside `onTaskFired` to refresh after each run.
 *
 * For cron schedules, the next run cannot be computed without a full cron
 * parser; returns null in that case (UI shows "Calculated at runtime").
 *
 * PLACEHOLDER: Install a lightweight cron parser (e.g. `cronstrue` or a
 * hand-rolled next-date calculator) to provide live countdown for cron tasks.
 */
export function estimateNextRunAt(
  scheduleType: ScheduleType,
  scheduleExpression: string
): string | null {
  switch (scheduleType) {
    case "once": {
      const d = new Date(scheduleExpression.trim());
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    case "interval": {
      const seconds = parseIntervalSeconds(scheduleExpression);
      if (seconds === null) return null;
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
    case "cron":
      // PLACEHOLDER: no inline cron-next-date logic.
      return null;
  }
}

/**
 * Recompute `nextRunAt` after a task fires (for interval tasks only).
 * Pass the current task record; returns the new nextRunAt value.
 */
export function nextRunAtAfterFire(task: PersistedTask): string | null {
  if (!task.enabled) return null;
  return estimateNextRunAt(task.scheduleType, task.scheduleExpression);
}
