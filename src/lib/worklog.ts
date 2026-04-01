/**
 * lib/worklog.ts
 * Small helpers to create and sanitize OpenClaw-style worklog entries.
 */

import { AgentName, WorklogEntry } from "./types";

export function makeWorklog(
  taskId: string,
  agent: AgentName,
  step: string,
  details: Record<string, unknown>
): WorklogEntry {
  return {
    id: crypto.randomUUID(),
    taskId,
    agent,
    step,
    timestamp: new Date().toISOString(),
    details,
  };
}

export function summarizeWorklog(entries: WorklogEntry[]): string {
  if (entries.length === 0) {
    return "No worklog entries.";
  }

  return entries
    .map((entry: WorklogEntry) => `${entry.timestamp} [${entry.agent}] ${entry.step}`)
    .join("\n");
}
