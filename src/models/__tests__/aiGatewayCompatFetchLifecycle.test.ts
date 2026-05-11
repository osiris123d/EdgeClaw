/**
 * AI Gateway compat fetch lifecycle instrumentation (Node regression tests).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createAiGatewayCompatInstrumentedFetch } from "../aiGatewayCompatFetch";

test("instrumented fetch: headers_ok, zero-byte stream closes with firstChunkSeen=no", async () => {
  const lines: string[] = [];
  const sink = (msg: string) => lines.push(msg);

  const baseFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  const inst = createAiGatewayCompatInstrumentedFetch(baseFetch, { requestId: "rid-a", streamId: "sid-b" }, sink);
  const res = await inst("http://example.invalid/compat/v1/chat/completions", {
    method: "POST",
    signal: undefined,
  });

  assert.equal(res.status, 200);
  await res.arrayBuffer();

  assert.ok(lines.some((l) => l.includes("phase=before_dispatch") && l.includes("requestId=rid-a")));
  assert.ok(lines.some((l) => l.includes("phase=headers_ok")));
  assert.ok(lines.some((l) => l.includes("phase=first_chunk")) === false);
  assert.ok(lines.some((l) => l.includes("phase=stream_close") && l.includes("firstChunkSeen=no")));
  assert.ok(lines.some((l) => l.includes("phase=final_cleanup")));
});

test("instrumented fetch: abort signal rejects fetch before headers", async () => {
  const lines: string[] = [];
  const ac = new AbortController();

  const baseFetch: typeof fetch = async (_input, init) => {
    const s = init?.signal;
    await new Promise<void>((_, reject) => {
      if (!s) {
        reject(new Error("expected_abort_signal"));
        return;
      }
      if (s.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      s.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return new Response("");
  };

  const inst = createAiGatewayCompatInstrumentedFetch(baseFetch, { requestId: "r2", streamId: "s2" }, (m) =>
    lines.push(m)
  );

  const p = inst("http://example.invalid/x", { method: "POST", signal: ac.signal });
  ac.abort();

  await assert.rejects(p);
  assert.ok(lines.some((l) => l.includes("phase=before_dispatch")));
  assert.ok(lines.some((l) => l.includes("phase=fetch_rejected")));
});

test("instrumented fetch: first chunk then close", async () => {
  const lines: string[] = [];
  const baseFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([65]));
          controller.close();
        },
      }),
      { status: 200 }
    );

  const inst = createAiGatewayCompatInstrumentedFetch(baseFetch, { requestId: "r3", streamId: "s3" }, (m) =>
    lines.push(m)
  );
  const res = await inst("http://example.invalid/y", { method: "POST" });
  await res.arrayBuffer();

  assert.ok(lines.some((l) => l.includes("phase=first_chunk") && l.includes("byteLength=1")));
  assert.ok(lines.some((l) => l.includes("phase=stream_close") && l.includes("firstChunkSeen=yes")));
});
