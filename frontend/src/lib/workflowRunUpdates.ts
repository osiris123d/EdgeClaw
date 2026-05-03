/**
 * workflowRunUpdates.ts
 *
 * Transport-agnostic client for receiving live workflow run updates.
 *
 * The UI depends only on `createRunLiveClient` and `LiveConnectionState` —
 * the underlying transport (SSE in production, polling interval in the mock
 * adapter) is hidden behind this abstraction.
 *
 * SSE event shape emitted by the backend:
 *   data: {"type":"run.update","run":{...WorkflowRun}}
 *   data: {"type":"ping"}
 */

import type { WorkflowRun } from "../types/workflows";

// ── Public types ───────────────────────────────────────────────────────────────

export type LiveConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface RunLiveClientOptions {
  /** Full URL of the SSE endpoint, e.g. "/api/workflows/runs/stream". */
  url: string;
  /** Called whenever a run update event arrives. */
  onUpdate: (run: WorkflowRun) => void;
  /** Called whenever the connection state changes. */
  onStateChange?: (state: LiveConnectionState) => void;
}

export interface RunLiveClient {
  /** Tear down the connection and stop all reconnect attempts. */
  close(): void;
  /** Current connection state (snapshot at call time). */
  readonly state: LiveConnectionState;
}

// ── SSE client implementation ──────────────────────────────────────────────────

/**
 * Create a live run updates client backed by a browser `EventSource`.
 *
 * The client auto-reconnects on transient drops (the browser handles this
 * natively for `EventSource`).  Call `close()` to permanently stop.
 */
export function createRunLiveClient(options: RunLiveClientOptions): RunLiveClient {
  const { url, onUpdate, onStateChange } = options;

  let currentState: LiveConnectionState = "connecting";
  let closed = false;
  let es: EventSource | null = null;

  function setState(s: LiveConnectionState) {
    if (currentState === s) return;
    currentState = s;
    onStateChange?.(s);
  }

  function connect() {
    if (closed) return;
    es = new EventSource(url);

    es.onopen = () => {
      setState("connected");
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          type: string;
          run?: WorkflowRun;
        };
        if (data.type === "run.update" && data.run) {
          onUpdate(data.run);
        }
        // Ignore "ping" events silently.
      } catch {
        // Malformed event — ignore.
      }
    };

    es.onerror = () => {
      if (closed) return;
      // EventSource reconnects automatically; we just update the state label.
      setState("reconnecting");
    };
  }

  connect();

  return {
    close() {
      closed = true;
      es?.close();
      es = null;
      setState("disconnected");
    },
    get state() {
      return currentState;
    },
  };
}

// ── Mock / polling implementation ──────────────────────────────────────────────

/**
 * Create a mock live client that periodically re-fetches runs via a supplied
 * fetch function.  Used when the real SSE transport is unavailable (mock mode).
 *
 * @param fetchRuns   Async function returning the current list of runs.
 * @param onUpdate    Called for each run returned by `fetchRuns`.
 * @param onStateChange Called on connection state changes.
 * @param intervalMs  How often to poll (default: 30 000 ms).
 */
export function createMockRunLiveClient(
  fetchRuns: () => Promise<WorkflowRun[]>,
  onUpdate: (run: WorkflowRun) => void,
  onStateChange?: (state: LiveConnectionState) => void,
  intervalMs = 30_000,
): RunLiveClient {
  let currentState: LiveConnectionState = "connecting";
  let timer: ReturnType<typeof setInterval> | null = null;
  // Guard flag: prevents in-flight async polls from emitting updates after
  // close() is called (avoids state updates on unmounted components).
  let closed = false;

  function setState(s: LiveConnectionState) {
    if (currentState === s) return;
    currentState = s;
    onStateChange?.(s);
  }

  async function poll() {
    try {
      const runs = await fetchRuns();
      if (closed) return;  // discard result if client was closed while fetching
      setState("connected");
      for (const run of runs) onUpdate(run);
    } catch {
      if (!closed) setState("reconnecting");
    }
  }

  // Initial fetch then start interval.
  setState("connecting");
  void poll();
  timer = setInterval(() => void poll(), intervalMs);

  return {
    close() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      setState("disconnected");
    },
    get state() {
      return currentState;
    },
  };
}
