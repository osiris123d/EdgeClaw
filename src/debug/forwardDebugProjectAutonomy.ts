import type { Env } from "../lib/env";

/**
 * Forward `/api/debug/project-autonomy` → MainAgent DO `/debug/project-autonomy`.
 * Same session / header safety rules as {@link forwardToAgentDebugOrchestration}.
 */
export async function forwardToAgentDebugProjectAutonomy(
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
    "debug_project_autonomy_stub_fetch_start",
    JSON.stringify({ session, method, path: doUrl.pathname })
  );

  try {
    const res = await stub.fetch(doRequest);
    const status = res.status;
    const contentType = res.headers.get("Content-Type") ?? "application/json";
    const text = await res.text();
    console.info(
      "debug_project_autonomy_stub_fetch_done",
      JSON.stringify({ session, status, ok: status >= 200 && status < 300 })
    );
    if (status < 200 || status >= 300) {
      const snippet = text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
      console.error(
        "debug_project_autonomy_do_non_ok",
        JSON.stringify({ session, status, bodySnippet: snippet })
      );
    }
    return new Response(text, {
      status,
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      "debug_project_autonomy_stub_fetch_error",
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
