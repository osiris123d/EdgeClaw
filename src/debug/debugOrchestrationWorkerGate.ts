import type { Env } from "../lib/env";
import type { Variables } from "../lib/env";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readVar(env: Env, key: keyof Variables): string | undefined {
  const nested = env.Variables?.[key];
  if (typeof nested === "string") return nested;
  const top = env[key as keyof Env];
  return typeof top === "string" ? top : undefined;
}

function isExplicitTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = value.trim().toLowerCase();
  return n === "true" || n === "1" || n === "yes" || n === "on";
}

/** Same enable check as the Worker gate — defense in depth inside the MainAgent DO. */
export function isDebugOrchestrationEnvEnabled(env: Env): boolean {
  return isExplicitTrue(readVar(env, "ENABLE_DEBUG_ORCHESTRATION_ENDPOINT"));
}

/** When `DEBUG_ORCHESTRATION_TOKEN` is unset, any caller is allowed (HTTP gate + RPC). */
export function debugOrchestrationSecretMatches(env: Env, providedSecret: string | undefined): boolean {
  const token = readVar(env, "DEBUG_ORCHESTRATION_TOKEN")?.trim();
  if (!token) return true;
  return (providedSecret ?? "").trim() === token;
}

/**
 * DEBUG ONLY — edge Worker gate for `/api/debug/orchestrate`.
 * Returns a Response when the request must not reach the DO (disabled, wrong method, auth).
 * Returns `null` when the caller should forward to MainAgent.
 *
 * TODO(hardening): Remove or narrow before any public exposure.
 */
export function gateDebugOrchestrationAtWorker(request: Request, env: Env): Response | null {
  if (!isDebugOrchestrationEnvEnabled(env)) {
    return json({ error: "Not found" }, 404);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const token = readVar(env, "DEBUG_ORCHESTRATION_TOKEN")?.trim();
  if (token) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  return null;
}
