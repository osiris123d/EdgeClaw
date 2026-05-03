import { isDebugOrchestrationEnvEnabled } from "./debugOrchestrationWorkerGate";
import type { Env } from "../lib/env";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface DebugDelegatedPingRunner {
  env: Env;
  delegateToDebugPingChildTransportProbe(): Promise<{ ok: boolean; who: string }>;
}

/**
 * MainAgent DO handler for `/debug/delegated-ping` (rewritten from `/api/debug/delegated-ping`).
 * Transport-only: {@link DebugDelegatedPingRunner#delegateToDebugPingChildTransportProbe}.
 */
export async function handleDebugDelegatedPingDoRequest(
  request: Request,
  runner: DebugDelegatedPingRunner
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!isDebugOrchestrationEnvEnabled(runner.env)) {
    return json(
      { error: "Debug delegated ping disabled (ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true required)." },
      503
    );
  }

  console.info(
    "debug_delegated_ping_do_handler_enter",
    JSON.stringify({ method: request.method, pathname: url.pathname })
  );

  try {
    const ping = await runner.delegateToDebugPingChildTransportProbe();
    return json(
      {
        debug: true,
        entry: "http",
        probe: "main_delegated_child_ping_transport",
        ping,
      },
      200
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg, debug: true, entry: "http" }, 500);
  }
}
