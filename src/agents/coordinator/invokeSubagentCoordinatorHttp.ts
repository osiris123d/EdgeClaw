/**
 * MainAgent → SubagentCoordinatorThink over `stub.fetch` (plain JSON bodies only).
 * Matches the safe Worker→DO forwarding pattern (no client Request handles on the wire).
 */
import type { Env } from "../../lib/env";
import type {
  CodingCollaborationLoopInput,
  CodingCollaborationLoopResult,
} from "../codingLoop/codingLoopTypes";
import type { DelegationOptions, SubAgentResult } from "../delegation";

const INTERNAL_ORIGIN = "https://subagent-coordinator.internal";

interface CoordinatorNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

function sanitizeInstanceName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 200);
  return s.length > 0 ? s : "coord-default";
}

/** For MainAgent when choosing per-invocation coordinator DO names. */
export function sanitizeCoordinatorInstanceName(name: string): string {
  return sanitizeInstanceName(name);
}

function coordinatorStub(env: Env, instanceName: string) {
  const ns = env.SUBAGENT_COORDINATOR as unknown as CoordinatorNamespace | undefined;
  if (!ns) {
    throw new Error("SUBAGENT_COORDINATOR binding is not configured on this Worker.");
  }
  return ns.get(ns.idFromName(sanitizeInstanceName(instanceName)));
}

async function readJsonOrThrow(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text || `Coordinator returned HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === "string" && j.error.trim()) {
        detail = j.error;
      }
    } catch {
      /* keep detail */
    }
    console.error(
      "coordinator_http_non_ok",
      JSON.stringify({
        label,
        httpStatus: res.status,
        errorDetail: detail.length > 4000 ? `${detail.slice(0, 4000)}…` : detail,
        rawBodyPreview: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
      })
    );
    throw new Error(detail);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    console.error(
      "coordinator_http_invalid_json",
      JSON.stringify({ label, httpStatus: res.status, bodyPreview: snippet })
    );
    throw new Error(`Coordinator returned non-JSON: ${snippet}`);
  }
}

export async function invokeCoordinatorCodingLoop(
  env: Env,
  coordinatorInstanceName: string,
  input: CodingCollaborationLoopInput
): Promise<CodingCollaborationLoopResult> {
  const stub = coordinatorStub(env, coordinatorInstanceName);
  const res = await stub.fetch(
    new Request(`${INTERNAL_ORIGIN}/coordinator/coding-loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    })
  );
  return (await readJsonOrThrow(res, `coding-loop:${coordinatorInstanceName}`)) as CodingCollaborationLoopResult;
}

export async function invokeCoordinatorDelegateCoder(
  env: Env,
  coordinatorInstanceName: string,
  message: string,
  options: DelegationOptions = {}
): Promise<SubAgentResult> {
  const stub = coordinatorStub(env, coordinatorInstanceName);
  const res = await stub.fetch(
    new Request(`${INTERNAL_ORIGIN}/coordinator/delegate-coder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, options }),
    })
  );
  return (await readJsonOrThrow(res, `delegate-coder:${coordinatorInstanceName}`)) as SubAgentResult;
}

export async function invokeCoordinatorDelegateTester(
  env: Env,
  coordinatorInstanceName: string,
  message: string,
  options: DelegationOptions = {}
): Promise<SubAgentResult> {
  const stub = coordinatorStub(env, coordinatorInstanceName);
  const res = await stub.fetch(
    new Request(`${INTERNAL_ORIGIN}/coordinator/delegate-tester`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, options }),
    })
  );
  return (await readJsonOrThrow(res, `delegate-tester:${coordinatorInstanceName}`)) as SubAgentResult;
}

/** Single coordinator DO: smoke coder delegation (debug chain step 2). */
export async function invokeCoordinatorSmokeCoder(
  env: Env,
  coordinatorInstanceName: string,
  message: string
): Promise<SubAgentResult> {
  const stub = coordinatorStub(env, coordinatorInstanceName);
  const res = await stub.fetch(
    new Request(`${INTERNAL_ORIGIN}/coordinator/smoke-coder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    })
  );
  return (await readJsonOrThrow(res, `smoke-coder:${coordinatorInstanceName}`)) as SubAgentResult;
}
