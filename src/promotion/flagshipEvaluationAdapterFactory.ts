import type { Env } from "../lib/env";
import type { FlagshipEvaluationAdapter } from "./flagshipTypes";
import { createBindingFlagshipEvaluationAdapter } from "./flagshipBinding";
import { createHttpFlagshipEvaluationAdapter } from "./flagshipHttp";
import { createNoopFlagshipEvaluationAdapter } from "./flagshipNoop";

function isFlagshipHttpExplicitlyDisabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_FLAGSHIP_HTTP ?? env.ENABLE_FLAGSHIP_HTTP;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "false" || n === "0" || n === "off";
}

function isFlagshipBindingExplicitlyEnabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_FLAGSHIP_BINDING ?? env.ENABLE_FLAGSHIP_BINDING;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

function getFlagshipEvaluationUrl(env: Env): string | undefined {
  const u = env.Variables?.FLAGSHIP_EVALUATION_URL ?? env.FLAGSHIP_EVALUATION_URL;
  if (typeof u === "string" && u.trim()) {
    return u.trim();
  }
  return undefined;
}

function getFlagshipAuthToken(env: Env): string | undefined {
  const t = env.Variables?.FLAGSHIP_EVALUATION_AUTH_TOKEN ?? env.FLAGSHIP_EVALUATION_AUTH_TOKEN;
  if (typeof t === "string" && t.trim()) {
    return t.trim();
  }
  return undefined;
}

function parseTimeoutMs(env: Env): number | undefined {
  const raw = env.Variables?.FLAGSHIP_HTTP_TIMEOUT_MS ?? env.FLAGSHIP_HTTP_TIMEOUT_MS;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getReleaseGateFlagKey(env: Env): string {
  const k = env.Variables?.FLAGSHIP_RELEASE_GATE_FLAG_KEY ?? env.FLAGSHIP_RELEASE_GATE_FLAG_KEY;
  if (typeof k === "string" && k.trim()) {
    return k.trim();
  }
  return "edgeclaw-release-gate";
}

/** Branch chosen by {@link resolveFlagshipEvaluationAdapter} — safe introspection only. */
export type FlagshipEvaluationBranch = "binding" | "http" | "noop";

/**
 * Describes Flagship adapter branch — mirrors {@link resolveFlagshipEvaluationAdapter} precedence.
 */
export function describeFlagshipEvaluationBranch(env: Env): FlagshipEvaluationBranch {
  if (isFlagshipBindingExplicitlyEnabled(env) && env.FLAGS) {
    return "binding";
  }
  if (!isFlagshipHttpExplicitlyDisabled(env)) {
    const url = getFlagshipEvaluationUrl(env);
    if (url) {
      return "http";
    }
  }
  return "noop";
}

/**
 * Orchestrator wiring (priority) — **binding over HTTP** when both could apply:
 * 1. Cloudflare Flagship **Workers binding** when `ENABLE_FLAGSHIP_BINDING` is on and `FLAGS` is bound.
 * 2. HTTP policy endpoint when `FLAGSHIP_EVALUATION_URL` is set and `ENABLE_FLAGSHIP_HTTP` is not off.
 * 3. Noop.
 *
 * Path labels: **Canonical** — binding adapter. **Compatibility / fallback** — HTTP POST for external policy or migration.
 * **Fallback** — noop.
 *
 * Migration: enable binding + `ENABLE_FLAGSHIP_BINDING=true` to cut over; set `ENABLE_FLAGSHIP_HTTP=false` to forbid HTTP fallback.
 * @see `docs/coding-platform-architecture.md` (factory precedence).
 */
export function resolveFlagshipEvaluationAdapter(env: Env): FlagshipEvaluationAdapter {
  const branch = describeFlagshipEvaluationBranch(env);
  if (branch === "binding") {
    return createBindingFlagshipEvaluationAdapter(env.FLAGS!, {
      outcomeFlagKey: getReleaseGateFlagKey(env),
    });
  }
  if (branch === "http") {
    const url = getFlagshipEvaluationUrl(env)!;
    const timeoutMs = parseTimeoutMs(env);
    return createHttpFlagshipEvaluationAdapter({
      evaluationUrl: url,
      bearerToken: getFlagshipAuthToken(env),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  return createNoopFlagshipEvaluationAdapter();
}
