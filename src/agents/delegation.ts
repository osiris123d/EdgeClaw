/**
 * Sub-agent Delegation Patterns
 *
 * Implements the parent-child streaming delegation pattern for Think agents.
 *
 * How it works
 * ────────────
 * Think agents can delegate turns to named child agents via `this.subAgent()`,
 * which is inherited from the Cloudflare `Agent` base class. Each child agent
 * gets its own Durable Object instance with isolated SQLite storage, session
 * memory, tools, and conversation history.
 *
 * **Production (optional):** when the Worker binds `SUBAGENT_COORDINATOR` to
 * {@link SubagentCoordinatorThink}, `MainAgent` routes coder/tester delegation
 * (`delegateToCoder` / `delegateToTester` / `runCodingCollaborationLoop`) over
 * `stub.fetch` + JSON into that lightweight Think parent, which then calls
 * `subAgent(CoderAgent|TesterAgent)` — matching the minimal-parent pattern from
 * Cloudflare Agents sub-agent design (see `design/rfc-sub-agents.md`).
 *
 * The parent normally calls `childStub.rpcCollectChatTurn(message)` (see {@link MainAgent.rpcCollectChatTurn}),
 * which runs a buffered Think `saveMessages` turn inside the child DO (no `StreamCallback` / `chat()`
 * streaming callback on the RPC path). For **debug orchestration isolation**, the parent may instead
 * invoke `rpcCollectStatelessModelTurn` (see {@link DelegationOptions.statelessSubAgentModelTurn}), which
 * uses `generateText` directly and skips `saveMessages` / `getMessages`. Passing a parent-owned streaming
 * callback into `stub.chat()` across facets can trigger Workers “Cannot perform I/O on behalf of a
 * different Durable Object (I/O type: Native)”.
 *
 * For in-process use (same DO), you may still call `this.chat(message, callback, options)` with a
 * plain `StreamCallback` object or a {@link StreamCollector}.
 *
 * Isolation boundaries
 * ────────────────────
 * - Each child holds its own SQLite-backed Workspace and Session (separate DO).
 * - The parent never directly reads the child's message history or session blocks.
 * - Workspace files written by a child are scoped to that child's DO storage.
 * - Shared project collaboration uses SharedWorkspaceGateway + `SharedWorkspaceStorage` (KV adapter optional via
 *   `SHARED_WORKSPACE_KV`), not the parent's Think workspace — see `src/workspace/` and `DelegationOptions.sharedProjectId`.
 * - The streaming channel between parent and child is the `StreamCallback` RPC boundary.
 *
 * Streaming behavior
 * ──────────────────
 * - `StreamCollector` extends `RpcTarget`; pass the instance to `stub.chat()` (not a plain object) — see Cloudflare Agents “Callback streaming”.
 * - `StreamCollector.result()` resolves when `onDone` fires, returning the
 *   full concatenated text and any parsed event array.
 * - `createRelayCallback(emit)` can be used to forward child events upstream
 *   to a parent's own StreamCallback or WebSocket stream in real time.
 *
 * Adding more child agents
 * ────────────────────────
 * 1. Create your class extending MainAgent in `src/agents/subagents/`.
 * 2. Export it from your Worker entry point (`server.ts`) so Think can resolve
 *    it by class name through `ctx.exports`.
 * 3. Add a typed `delegateTo<YourAgent>(YourAgent, ...)` call in `MainAgent`.
 *    See `delegateToCoder`, `delegateToTester`, `delegateToResearch`, `delegateToExecution`.
 * 4. Optionally add a named shortcut method (e.g. `delegateToQA`).
 */

import type { StreamCallback as ThinkStreamCallback } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { RpcTarget } from "cloudflare:workers";

// ── Public Types ─────────────────────────────────────────────────────────────

/**
 * Parent-side options for naming and shared-workspace context.
 * Cross-DO RPC sends only a **string** `message` to `rpcCollectChatTurn` or `rpcCollectStatelessModelTurn` —
 * do not rely on passing `AbortSignal`, `Request`, streams, or callbacks through this object for sub-agent calls.
 */
export interface DelegationOptions {
  /**
   * When set, appends to the default child DO name (`coder-${requestId}-…`, `tester-${requestId}-…`)
   * so orchestration loops can isolate turns per iteration without colliding chat history.
   */
  subAgentInstanceSuffix?: string;
  /**
   * When set, the delegated message is prefixed with a shared-workspace envelope so the
   * child knows which logical `projectId` and role apply for `shared_workspace_*` tools.
   */
  sharedProjectId?: string;
  /** Control-plane project id for envelope + AI Gateway metadata (may match shared workspace id). */
  controlPlaneProjectId?: string;
  /** Control-plane task id when task-backed orchestration runs. */
  controlPlaneTaskId?: string;
  /** Control-plane persisted run id when known; otherwise coding-loop host `loopRunId` is used. */
  controlPlaneRunId?: string;
  /**
   * When true, the parent calls the child's `rpcCollectStatelessModelTurn` instead of `rpcCollectChatTurn`.
   * Skips Think **session message persistence** (`saveMessages` / `getMessages`) and runs one-shot
   * `generateText` with the child's tools — for debug orchestration isolation only (CoderAgent/TesterAgent).
   */
  statelessSubAgentModelTurn?: boolean;
  /**
   * DEBUG only (requires `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT` on Worker): parent prepends an internal
   * message flag so the child omits `shared_workspace_*` tools for that delegation.
   */
  debugDisableSharedWorkspaceTools?: boolean;
  /**
   * Additional tools to merge into the child's tool set for this turn.
   * These are passed as `callerTools` and have the highest merge priority.
   *
   * Note: cross-DO RPC may not propagate arbitrary `tool()` closures — prefer registering
   * shared workspace tools on the child (`CoderAgent` / `TesterAgent`) + KV backend.
   */
  tools?: ToolSet;
  /**
   * Called for each raw event JSON string as it arrives from the child.
   * Use this to forward chunks upstream in real time.
   * If omitted, chunks are collected and returned in `SubAgentResult`.
   */
  onEvent?: (json: string) => void | Promise<void>;
}

/**
 * Structured result returned after a delegated sub-agent turn completes.
 */
export interface SubAgentResult {
  /** Plain assistant text for this turn (from persisted messages after a buffered inference). */
  text: string;
  /**
   * Legacy stream-chunk JSON strings; empty when the turn used `saveMessages` instead of `chat()`.
   */
  events: string[];
  /** Whether the turn completed normally (vs. aborted or errored). */
  ok: boolean;
  /** Error message if `ok` is false. */
  error?: string;
}

/**
 * Cross-DO `@callable()` RPC responses that are too large can surface as a generic
 * `internal error; reference = …` from the Workers runtime (after the handler returns).
 * Proposed patches live in the shared workspace; the orchestrator does not need megabytes of echo text.
 */
export const MAX_SUBAGENT_RPC_TEXT_CHARS = 350_000;

export function clampSubAgentResultForRpc(r: SubAgentResult): SubAgentResult {
  const events = Array.isArray(r.events) ? r.events : [];
  let text = typeof r.text === "string" ? r.text : "";
  if (text.length > MAX_SUBAGENT_RPC_TEXT_CHARS) {
    text =
      text.slice(0, MAX_SUBAGENT_RPC_TEXT_CHARS) +
      "\n\n[…assistant text truncated for sub-agent RPC size limit; proposed patches may still be in the shared workspace.]";
  }
  const maxEvents = 200;
  const evOut = events.length > maxEvents ? events.slice(0, maxEvents) : events;
  const maxErr = 8_000;
  const err =
    typeof r.error === "string" && r.error.length > 0
      ? r.error.length > maxErr
        ? `${r.error.slice(0, maxErr)}…`
        : r.error
      : undefined;
  return {
    text,
    events: evOut,
    ok: r.ok,
    ...(err !== undefined ? { error: err } : {}),
  };
}

/**
 * Inbound argument to `rpcCollectChatTurn` / `rpcCollectStatelessModelTurn` across parent → child DO RPC.
 * If the string is too large, the runtime can fail **before** `@callable` runs (tail shows `rpcMethod: ""`,
 * `wallTimeMs: 0`) with a generic internal error.
 */
/** Tunable: Workers cross-DO RPC inbound `message` limit is undocumented; lower if `rpcMethod: ""` persists. */
export const MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS = 120_000;

export function truncateMessageForSubagentRpcInbound(message: string): string {
  const s = typeof message === "string" ? message : String(message ?? "");
  if (s.length <= MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS) return s;
  console.warn(
    `[EdgeClaw][subagent-rpc] inbound delegation message truncated for RPC limit (${s.length} → ${MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS} chars)`
  );
  return (
    s.slice(0, MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS) +
    "\n\n[…delegation message truncated for cross-DO RPC inbound size limit; reduce blueprint/context size or split work.]"
  );
}

// ── StreamCollector ───────────────────────────────────────────────────────────

/**
 * Collects streaming events from a child agent into a resolved `SubAgentResult`.
 * Extends {@link RpcTarget} so Think `chat()` can stream across facet boundaries
 * (Cloudflare Agents sub-agent “Callback streaming” pattern).
 *
 * **Cross-facet (parent → child DO):** the parent must call `stub.rpcCollectChatTurn(message)`
 * (see `MainAgent`) instead of `stub.chat(..., collector)`.
 *
 * Usage (same DO only)
 * --------------------
 * ```typescript
 * const collector = new StreamCollector(options?.onEvent);
 * await this.chat(message, collector, {});
 * const result = await collector.result();
 * ```
 */
export class StreamCollector extends RpcTarget {
  private readonly _events: string[] = [];
  private _resolve!: (result: SubAgentResult) => void;
  private _done = false;
  private readonly _onEvent?: (json: string) => void | Promise<void>;

  /** The promise that resolves when `onDone` fires. */
  private readonly _promise: Promise<SubAgentResult>;

  constructor(onEvent?: (json: string) => void | Promise<void>) {
    super();
    this._onEvent = onEvent;
    this._promise = new Promise<SubAgentResult>((resolve) => {
      this._resolve = resolve;
    });
  }

  async onEvent(json: string): Promise<void> {
    if (this._done) return;
    this._events.push(json);
    if (this._onEvent) {
      await this._onEvent(json);
    }
  }

  async onDone(): Promise<void> {
    if (this._done) return;
    this._done = true;
    this._resolve({
      text: extractTextFromEvents(this._events),
      events: [...this._events],
      ok: true,
    });
  }

  async onError(error: string): Promise<void> {
    if (this._done) return;
    this._done = true;
    this._resolve({
      text: extractTextFromEvents(this._events),
      events: [...this._events],
      ok: false,
      error,
    });
  }

  /**
   * Wait for the child turn to complete and return the collected result.
   * Must be awaited after `stub.chat(message, collector, ...)`.
   */
  result(): Promise<SubAgentResult> {
    return this._promise;
  }

  /**
   * Abort the collection — resolves immediately with any events gathered so far.
   * Call this if external cancellation should resolve the collector early (same-DO use).
   */
  abort(reason = "aborted"): void {
    if (!this._done) {
      this._done = true;
      this._resolve({
        text: extractTextFromEvents(this._events),
        events: [...this._events],
        ok: false,
        error: reason,
      });
    }
  }
}

// ── Relay helper ─────────────────────────────────────────────────────────────

/**
 * Create a `StreamCallback` that immediately forwards each event to the
 * provided `emit` function. Use this when the parent is itself streaming
 * to a client and wants to pipe child events upstream in real time.
 *
 * @param emit   Called for each event JSON string from the child.
 * @param onDone Optional completion callback.
 *
 * @example
 * ```typescript
 * // Same DO only — do not use with `subAgent` stub RPC:
 * const relay = createRelayCallback(
 *   (json) => parentCallback.onEvent(json),
 *   ()     => parentCallback.onDone()
 * );
 * await this.chat(message, relay, {});
 * ```
 *
 * Do not pass this relay to `stub.chat()` across sub-agent facets — use {@link StreamCollector} instead.
 */
export function createRelayCallback(
  emit: (json: string) => void | Promise<void>,
  onDone?: () => void | Promise<void>,
  onError?: (error: string) => void | Promise<void>
): ThinkStreamCallback {
  return {
    onEvent: emit,
    onDone: onDone ?? (() => undefined),
    onError,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Extract plain text content from raw UIMessageChunk event JSON strings.
 *
 * The Think streaming protocol emits `UIMessageChunk` objects. Most text
 * arrives as `{ type: "text-delta", textDelta: "..." }` events. This helper
 * concatenates those deltas to produce the final assistant text.
 */
/** Used by {@link StreamCollector} and {@link MainAgent.rpcCollectChatTurn} for consistent text extraction. */
export function extractTextFromEvents(events: string[]): string {
  let text = "";

  for (const raw of events) {
    try {
      const chunk = JSON.parse(raw) as Record<string, unknown>;
      if (chunk.type === "text-delta" && typeof chunk.textDelta === "string") {
        text += chunk.textDelta;
      }
    } catch {
      // Non-JSON events (unlikely in production) are silently skipped.
    }
  }

  return text;
}
