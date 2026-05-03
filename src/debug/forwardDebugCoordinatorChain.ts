import type { Env } from "../lib/env";
import { recordLastCoordinatorChainSuccess } from "../coordinatorControlPlane/coordinatorHealth";

/**
 * Forward `GET|POST /api/debug/coordinator-chain` to MainAgent DO as `/debug/coordinator-chain`.
 * MainAgent handler issues `SUBAGENT_COORDINATOR.stub.fetch` (JSON only).
 */
export async function forwardToAgentDebugCoordinatorChain(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const session = url.searchParams.get("session") ?? "default";

  if (session.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(session)) {
    return new Response(
      JSON.stringify({
        error:
          "Invalid session identifier. Use alphanumerics, hyphens, underscores, or dots (max 128 chars).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  interface PlainDONamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
  }

  const ns = env.MAIN_AGENT as unknown as PlainDONamespace;
  const stub = ns.get(ns.idFromName(session));

  const doUrl = new URL(url.toString());
  doUrl.pathname = doUrl.pathname.replace(/^\/api/, "");

  const method = request.method.toUpperCase() === "POST" ? "POST" : "GET";
  const hasBody = request.body !== null && method === "POST";

  const outgoingHeaders = new Headers();
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    body = await request.arrayBuffer();
    const contentType = request.headers.get("Content-Type");
    if (contentType) {
      outgoingHeaders.set("Content-Type", contentType);
    } else {
      outgoingHeaders.set("Content-Type", "application/json");
    }
  }

  const doRequest = new Request(doUrl.toString(), {
    method,
    headers: outgoingHeaders,
    ...(body !== undefined ? { body } : {}),
  });

  console.info(
    "debug_coordinator_chain_stub_fetch_start",
    JSON.stringify({ session, method, path: doUrl.pathname })
  );

  try {
    const res = await stub.fetch(doRequest);
    console.info(
      "debug_coordinator_chain_stub_fetch_done",
      JSON.stringify({ session, status: res.status, ok: res.ok })
    );
    if (res.ok) {
      void recordLastCoordinatorChainSuccess(env, session, res.status);
    }
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      "debug_coordinator_chain_stub_fetch_error",
      JSON.stringify({ session, message: msg })
    );
    return new Response(
      JSON.stringify({
        error: msg,
        debug: true,
        hint: "stub.fetch to MainAgent failed at the Worker edge.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
