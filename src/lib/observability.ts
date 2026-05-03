/**
 * Structured observability for model routing and agent decisions.
 *
 * Design goals
 * ────────────
 * - Zero secrets: arg values, prompt text, and tool results are never emitted.
 * - Structured JSON: every event is a plain object — easy to ship to Logpush,
 *   Workers Analytics Engine, or any external sink.
 * - Level-gated: callers check `obs.isEnabled(level)` before building events
 *   so expensive work is skipped when the level is "off".
 * - Pluggable sink: the default sink writes compact JSON to `console.log`.
 *   Pass a custom `ObsSink` to route events elsewhere (e.g. Logpush, D1).
 *
 * Levels
 * ──────
 * | Level   | What is emitted                                             |
 * |---------|-------------------------------------------------------------|
 * | off     | Nothing                                                     |
 * | error   | model.fallback only                                         |
 * | info    | model.selected, model.fallback, turn.summary  (default)     |
 * | debug   | All of the above + alternatives[] in model.selected          |
 *
 * Usage
 * ─────
 * ```typescript
 * // In MainAgent constructor or factory:
 * const obs = createObservability("MainAgent", env.Variables.OBSERVABILITY_LEVEL);
 *
 * // Pass to router:
 * const router = createStandardRouter({ obs });
 *
 * // Emit a turn summary from an onChatResponse hook:
 * obs.emit({
 *   event: "turn.summary",
 *   requestId: ctx.requestId,
 *   durationMs: Date.now() - turnStart,
 *   status: ctx.status,
 *   toolCallCount: 3,
 *   stepCount: 2,
 *   totalInputTokens: 1200,
 *   totalOutputTokens: 400,
 *   modelId: "claude-sonnet",
 * });
 * ```
 */

// ── Level ─────────────────────────────────────────────────────────────────────

/**
 * Verbosity level for observability events.
 * Set via the `OBSERVABILITY_LEVEL` environment variable.
 *
 * - `"off"`   — no events emitted
 * - `"error"` — model.fallback only
 * - `"info"`  — model.selected, model.fallback, turn.summary
 * - `"debug"` — all of the above, plus alternatives array in model.selected
 */
export type ObsLevel = "off" | "error" | "info" | "debug";

const LEVEL_ORDER: Record<ObsLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

function parseLevel(raw: string | undefined): ObsLevel {
  if (raw === "off" || raw === "error" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "info";
}

// ── Event shapes ──────────────────────────────────────────────────────────────

/**
 * Emitted once per router `selectModel` call.
 * The `alternatives` array is only populated at `"debug"` level.
 */
export interface ModelSelectedEvent {
  event: "model.selected";
  ts: string;
  requestId?: string;
  agentName: string;
  /** Internal router model ID (e.g. `"claude-sonnet"`). */
  modelId: string;
  /** Human-readable model name. */
  modelName: string;
  /** Provider used: `"workers-ai"` | `"ai-gateway"` | `"external"`. */
  provider: string;
  /** Routing score (0–100). */
  score: number;
  /** Human-readable explanation of why this model was chosen. */
  reason: string;
  /** Whether an AI Gateway URL was generated for this selection. */
  gatewayUsed: boolean;
  /** Task type hint used during routing. */
  taskType?: string;
  /** Thin app-level route class label selected for this turn. */
  routeClass?: string;
  /** Dynamic route model string sent to AI Gateway (e.g. dynamic/agent-router). */
  dynamicRouteModel?: string;
  /** AI Gateway `/compat` base URL (never includes secrets). */
  gatewayBaseUrl?: string;
  /**
   * Top runner-up models (populated at `"debug"` level only).
   * Scores and model IDs only — no sensitive routing details.
   */
  alternatives?: Array<{ modelId: string; score: number }>;
  /** Non-fatal warnings produced by the router (e.g. "model is deprecated"). */
  warnings?: string[];
}

/**
 * Emitted when a model call fails and the router falls back to the default.
 */
export interface ModelFallbackEvent {
  event: "model.fallback";
  ts: string;
  requestId?: string;
  agentName: string;
  /** ID of the model that failed (if known). */
  failedModelId?: string;
  /** ID of the model that will be used instead. */
  fallbackModelId: string;
  /** Truncated error message (max 200 chars — never contains prompt text). */
  errorSummary: string;
}

/**
 * Emitted once per agent turn, after the chat response is finalized.
 * Provides latency, token usage, and tool-call statistics for the full turn.
 */
export interface TurnSummaryEvent {
  event: "turn.summary";
  ts: string;
  requestId?: string;
  agentName: string;
  /** Wall-clock duration from `beforeTurn` to `onChatResponse`. */
  durationMs: number;
  /** Think's `onChatResponse` status: `"success"` | `"error"` | `"aborted"`. */
  status: string;
  /** Number of tool calls made during this turn. */
  toolCallCount: number;
  /** Number of LLM steps (inference passes) in this turn. */
  stepCount: number;
  /** Total input tokens across all steps in this turn. */
  totalInputTokens: number;
  /** Total output tokens across all steps in this turn. */
  totalOutputTokens: number;
  /** The router model ID used for this turn (if captured). */
  modelId?: string;
  /** Whether AI Gateway routing was used. */
  gatewayUsed?: boolean;
  /** Selected app-level route class label for this turn. */
  routeClass?: string;
  /** Dynamic route model string sent to AI Gateway for this turn. */
  dynamicRouteModel?: string;
  /** Optional AI Gateway response metadata header value. */
  gatewayModel?: string;
  /** Optional AI Gateway response metadata header value. */
  gatewayProvider?: string;
}

/** Discriminated union of all emittable observability events. */
export type ObsEvent = ModelSelectedEvent | ModelFallbackEvent | TurnSummaryEvent;

/** Sink function that receives every emitted event. */
export type ObsSink = (event: ObsEvent) => void;

// ── Observability class ───────────────────────────────────────────────────────

/**
 * Lightweight observability emitter passed to the model router and agent.
 *
 * Instantiate with `createObservability()` rather than `new Observability()`
 * so the level is parsed from the raw env string.
 */
export class Observability {
  private readonly _level: ObsLevel;
  readonly agentName: string;
  private readonly _sink: ObsSink;

  constructor(agentName: string, level: ObsLevel = "info", sink: ObsSink = defaultConsoleSink) {
    this.agentName = agentName;
    this._level = level;
    this._sink = sink;
  }

  /**
   * Returns `true` if the given level is at or below the configured level.
   * Use this to gate expensive event construction:
   * ```typescript
   * if (obs.isEnabled("debug")) {
   *   obs.emit({ event: "model.selected", alternatives: [...], ... });
   * }
   * ```
   */
  isEnabled(level: ObsLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this._level];
  }

  /** Emit an event if the level is enabled. Always a no-op when level is "off". */
  emit(event: ObsEvent): void {
    if (this._level === "off") return;

    // Gate each event type to the appropriate minimum level.
    const minLevel = eventMinLevel(event.event);
    if (LEVEL_ORDER[minLevel] > LEVEL_ORDER[this._level]) return;

    this._sink(event);
  }

  /** Current configured level. */
  get level(): ObsLevel {
    return this._level;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an `Observability` instance, parsing the level from an optional env string.
 *
 * @param agentName  Used as the `agentName` field on every event.
 * @param rawLevel   Value of `env.Variables.OBSERVABILITY_LEVEL` (or `undefined`).
 *                   Falls back to `"info"` if absent or unrecognised.
 * @param sink       Custom sink. Defaults to a compact-JSON `console.log` writer.
 */
export function createObservability(
  agentName: string,
  rawLevel?: string,
  sink?: ObsSink
): Observability {
  return new Observability(agentName, parseLevel(rawLevel), sink);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function eventMinLevel(eventName: ObsEvent["event"]): ObsLevel {
  switch (eventName) {
    case "model.fallback":
      return "error";
    case "model.selected":
    case "turn.summary":
      return "info";
  }
}

function defaultConsoleSink(event: ObsEvent): void {
  console.log(`[EdgeClaw:obs] ${JSON.stringify(event)}`);
}
