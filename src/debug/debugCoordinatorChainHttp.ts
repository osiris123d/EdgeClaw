import { isDebugOrchestrationEnvEnabled } from "./debugOrchestrationWorkerGate";
import type { Env } from "../lib/env";
import {
  invokeCoordinatorSmokeCoder,
  sanitizeCoordinatorInstanceName,
} from "../agents/coordinator/invokeSubagentCoordinatorHttp";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * DEBUG — proves MainAgent → `stub.fetch(SubagentCoordinatorThink)` → `delegateToCoder` chain.
 * Requires `SUBAGENT_COORDINATOR` binding + `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT`.
 */
export async function handleDebugCoordinatorChainDoRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!isDebugOrchestrationEnvEnabled(env)) {
    return json(
      { error: "Debug coordinator chain disabled (ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true required)." },
      503
    );
  }
  if (!env.SUBAGENT_COORDINATOR) {
    return json(
      {
        error: "SUBAGENT_COORDINATOR binding is not configured.",
        hint: "Add SubagentCoordinatorThink to wrangler durable_objects + migrations, then bind SUBAGENT_COORDINATOR.",
      },
      503
    );
  }

  const runId = crypto.randomUUID();
  const instance = sanitizeCoordinatorInstanceName(`dbg-chain-${runId}`);
  console.info(
    "debug_coordinator_chain_main_enter",
    JSON.stringify({ coordinatorInstance: instance })
  );

  try {
    const coordinatorToCoder = await invokeCoordinatorSmokeCoder(
      env,
      instance,
      "[smoke] coordinator-chain probe from MainAgent HTTP"
    );
    const body = {
      debug: true,
      probe: "main_agent_http_to_coordinator_to_coder",
      coordinatorInstance: instance,
      mainToCoordinator: { ok: true, transport: "stub.fetch_json" },
      coordinatorToCoder,
    };
    console.info("debug_coordinator_chain_main_ok", JSON.stringify({ instance }));
    return json(body, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("debug_coordinator_chain_main_err", JSON.stringify({ instance, msg }));
    return json({ error: msg, debug: true, coordinatorInstance: instance }, 500);
  }
}
