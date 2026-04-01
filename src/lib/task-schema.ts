/**
 * lib/task-schema.ts
 * Runtime validation and normalization for task creation requests.
 */

import { TaskKind, TaskRequest } from "./types";

const KNOWN_KINDS: TaskKind[] = ["analyze", "draft", "audit"];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateTaskRequest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["Body must be a JSON object."] };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.userId !== "string" || obj.userId.trim().length === 0) {
    errors.push("userId is required and must be a non-empty string.");
  }

  if (!obj.input || typeof obj.input !== "object") {
    errors.push("input is required and must be an object.");
  } else {
    const inputObj = obj.input as Record<string, unknown>;
    if (typeof inputObj.objective !== "string" || inputObj.objective.trim().length === 0) {
      errors.push("input.objective is required and must be a non-empty string.");
    }
    if (!inputObj.payload || typeof inputObj.payload !== "object") {
      errors.push("input.payload is required and must be an object.");
    }
  }

  if (obj.kind !== undefined && (!KNOWN_KINDS.includes(obj.kind as TaskKind))) {
    errors.push("kind must be one of: analyze, draft, audit.");
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeTaskRequest(input: unknown): TaskRequest {
  const obj = input as Record<string, unknown>;
  const inputObj = obj.input as Record<string, unknown>;

  return {
    userId: String(obj.userId),
    kind: (obj.kind as TaskKind | undefined) ?? undefined,
    input: {
      objective: String(inputObj.objective),
      payload: (inputObj.payload as Record<string, unknown>) ?? {},
      hints: Array.isArray(inputObj.hints)
        ? inputObj.hints.filter((item: unknown) => typeof item === "string") as string[]
        : undefined,
    },
    metadata: asStringMap(obj.metadata),
  };
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
