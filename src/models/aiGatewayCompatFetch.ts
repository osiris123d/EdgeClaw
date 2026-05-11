/**
 * Instrumented fetch for AI Gateway `/compat` calls — lifecycle logs only (no bodies, auth, or prompts).
 */

export type GatewayFetchLogContext = {
  requestId?: string;
  streamId?: string;
};

export type AiGatewayFetchLifecycleSink = (line: string) => void;

function abortSignalLabel(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "aborted" : "live";
}

/**
 * Returns a `fetch` implementation that logs phases around the real network call and response body.
 * The response body is wrapped so first-chunk / close / cancel / stream errors are visible in logs.
 */
export function createAiGatewayCompatInstrumentedFetch(
  baseFetch: typeof fetch,
  logCtx: GatewayFetchLogContext | undefined,
  sink: AiGatewayFetchLifecycleSink = (msg) => console.info(msg)
): typeof fetch {
  return async (input, init) => {
    const requestId = logCtx?.requestId?.trim() || "(none)";
    const streamId = logCtx?.streamId?.trim() || "(none)";
    const t0 = Date.now();
    const signal = init?.signal;

    sink(
      `[EdgeClaw][aig-fetch] phase=before_dispatch requestId=${requestId} streamId=${streamId} ` +
        `abortSignal=${abortSignalLabel(signal)} elapsedMs=0`
    );

    let res: Response;
    try {
      res = await baseFetch(input, init);
    } catch (e) {
      const name = e instanceof Error ? e.constructor.name : typeof e;
      sink(
        `[EdgeClaw][aig-fetch] phase=fetch_rejected requestId=${requestId} streamId=${streamId} ` +
          `abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0} err=${name}`
      );
      throw e;
    }

    sink(
      `[EdgeClaw][aig-fetch] phase=headers_ok requestId=${requestId} streamId=${streamId} ` +
        `status=${res.status} abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0}`
    );

    if (!res.body) {
      sink(
        `[EdgeClaw][aig-fetch] phase=final_cleanup requestId=${requestId} streamId=${streamId} ` +
          `emptyBody=1 abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0}`
      );
      return res;
    }

    const reader = res.body.getReader();
    let sawFirstChunk = false;

    const wrapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            sink(
              `[EdgeClaw][aig-fetch] phase=stream_close requestId=${requestId} streamId=${streamId} ` +
                `firstChunkSeen=${sawFirstChunk ? "yes" : "no"} abortSignal=${abortSignalLabel(
                  signal
                )} elapsedMs=${Date.now() - t0}`
            );
            sink(
              `[EdgeClaw][aig-fetch] phase=final_cleanup requestId=${requestId} streamId=${streamId} ` +
                `abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0}`
            );
            controller.close();
            return;
          }
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            const byteLength = value?.byteLength ?? 0;
            sink(
              `[EdgeClaw][aig-fetch] phase=first_chunk requestId=${requestId} streamId=${streamId} ` +
                `byteLength=${byteLength} abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0}`
            );
          }
          controller.enqueue(value);
        } catch (e) {
          const name = e instanceof Error ? e.constructor.name : typeof e;
          sink(
            `[EdgeClaw][aig-fetch] phase=stream_error requestId=${requestId} streamId=${streamId} ` +
              `abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0} err=${name}`
          );
          controller.error(e);
        }
      },
      cancel(reason) {
        const reasonTag =
          reason === undefined
            ? "undefined"
            : typeof reason === "string"
              ? reason.slice(0, 80)
              : typeof reason === "object" && reason !== null && "name" in reason
                ? String((reason as { name?: unknown }).name).slice(0, 80)
                : typeof reason;
        sink(
          `[EdgeClaw][aig-fetch] phase=stream_cancel requestId=${requestId} streamId=${streamId} ` +
            `abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0} reason=${reasonTag}`
        );
        return reader.cancel(reason);
      },
    });

    sink(
      `[EdgeClaw][aig-fetch] phase=body_wrapped requestId=${requestId} streamId=${streamId} ` +
        `abortSignal=${abortSignalLabel(signal)} elapsedMs=${Date.now() - t0}`
    );

    return new Response(wrapped, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
