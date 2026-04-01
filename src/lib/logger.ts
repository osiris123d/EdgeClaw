/**
 * lib/logger.ts
 * Minimal structured logging helper for production runtime events.
 */

import { Env } from "./types";

type AgentRole = "dispatcher" | "analyst" | "audit";
type AgentEvent = "start" | "complete" | "error";

export function logAgentEvent(
  env: Env,
  role: AgentRole,
  event: AgentEvent,
  details: {
    taskId?: string;
    message?: string;
    data?: Record<string, unknown>;
  } = {}
): void {
  if (!shouldLog(env)) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: event === "error" ? "error" : "info",
    event,
    agentRole: role,
  };

  if (details.taskId) entry.taskId = details.taskId;
  if (details.message) entry.message = details.message;
  if (details.data && Object.keys(details.data).length > 0) {
    entry.data = details.data;
  }

  const line = JSON.stringify(entry);
  if (event === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function shouldLog(env: Env): boolean {
  const vars = env as unknown as Record<string, unknown>;
  return vars.ENVIRONMENT === "production";
}
