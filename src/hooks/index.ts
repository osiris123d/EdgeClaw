/**
 * Think Lifecycle Hooks
 *
 * Composable hook middleware for observability, policy enforcement, and
 * debugging — wired directly into Think's lifecycle method signatures.
 *
 * Architecture
 * ────────────
 * Each Think lifecycle method (`beforeTurn`, `beforeToolCall`, `afterToolCall`,
 * `onStepFinish`, `onChunk`, `onChatResponse`) has a corresponding typed
 * context interface and a `HookPipeline` that runs registered handlers in
 * registration order. Handlers are fire-and-forget (observational) unless they
 * return a value, in which case the last non-null return wins.
 *
 * Policy layer
 * ────────────
 * `ToolPolicyRule` handlers run inside `beforeToolCall` and can return:
 *   - `{ action: "allow" }` — proceed (optionally with rewritten args)
 *   - `{ action: "block",    reason }` — abort the call, surface reason to LLM
 *   - `{ action: "substitute", output }` — skip execution, return synthetic output
 *
 * Logging
 * ────────
 * `createStructuredLogger()` produces a safe, composable logger that:
 *   - Never logs arg/result values (prevents secret leakage)
 *   - Logs tool names, durations, and status codes only
 *   - Emits JSON-serializable log entries prefixed with `[EdgeClaw]`
 *
 * Extending hooks
 * ───────────────
 * ```typescript
 * // Register a custom beforeTurn observer:
 * agent.hooks.beforeTurn.add((ctx) => {
 *   console.log("turn started:", ctx.requestId);
 * });
 *
 * // Register a tool policy rule (can block or rewrite):
 * agent.hooks.toolPolicy.add({
 *   toolName: "delete_project_note",
 *   handler: async (ctx) => {
 *     if (isSensitivePath((ctx.input as { noteId?: string }).noteId)) {
 *       return { action: "block", reason: "Protected note — deletion not allowed." };
 *     }
 *   },
 * });
 * ```
 */

import type {
  TurnContext,
  TurnConfig,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  StepContext,
  ChunkContext,
  ChatResponseResult,
} from "@cloudflare/think";

// ── Re-export Think hook types ────────────────────────────────────────────────

export type {
  TurnContext,
  TurnConfig,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  StepContext,
  ChunkContext,
  ChatResponseResult,
};

// ─────────────────────────────────────────────────────────────────────────────
// HookPipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed, ordered list of async handlers for one lifecycle hook.
 *
 * Handlers fire in registration order. Each handler can return:
 *   - `void` — observational, no effect on the turn.
 *   - A value `R` — the **last** non-null/undefined return wins and is
 *     returned from `run()` to the Think lifecycle method.
 *
 * Errors inside handlers are caught and logged; they never abort the pipeline.
 */
export class HookPipeline<Ctx, R = void> {
  private readonly _handlers: Array<(ctx: Ctx) => R | Promise<R> | void | Promise<void>> = [];
  private readonly _label: string;

  constructor(label: string) {
    this._label = label;
  }

  /** Register a handler at the end of the pipeline. */
  add(handler: (ctx: Ctx) => R | Promise<R> | void | Promise<void>): this {
    this._handlers.push(handler);
    return this;
  }

  /** Remove a previously registered handler by reference. */
  remove(handler: (ctx: Ctx) => R | Promise<R> | void | Promise<void>): boolean {
    const idx = this._handlers.indexOf(handler);
    if (idx !== -1) {
      this._handlers.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Run all handlers, returning the last non-null/undefined result.
   * Handler errors are caught and logged; the pipeline always completes.
   */
  async run(ctx: Ctx): Promise<R | undefined> {
    let last: R | undefined;
    for (const handler of this._handlers) {
      try {
        const result = await Promise.resolve(handler(ctx));
        if (result !== undefined && result !== null) {
          last = result as R;
        }
      } catch (err) {
        console.error(`[EdgeClaw][hooks] ${this._label} handler threw:`, err);
      }
    }
    return last;
  }

  get size(): number {
    return this._handlers.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool policy layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enriched context passed to policy rule handlers (`ToolCallContext` + agent metadata).
 * Think 0.2+ uses `ToolCallContext` as a conditional type; it cannot be `extend`ed from.
 */
export type PolicyCallContext = ToolCallContext & {
  /** Agent class name for multi-agent setups. */
  agentName: string;
  /** Correlation ID for tracing across turns and agents. */
  requestId: string;
};

/**
 * A policy rule targeting a specific tool (or all tools via wildcard `"*"`).
 */
export interface ToolPolicyRule {
  /**
   * Tool name this rule applies to, or `"*"` to match every tool call.
   *
   * Rules run in registration order. If any returns a non-allow decision the
   * remaining rules are skipped and the decision is returned immediately.
   */
  toolName: string;

  /**
   * Return `undefined`/`void` to pass, `{ action: "allow" }` to short-circuit
   * remaining rules, or `{ action: "block" | "substitute", ... }` to intercept.
   */
  handler: (ctx: PolicyCallContext) => ToolCallDecision | void | Promise<ToolCallDecision | void>;
}

/**
 * Centralized policy registry for tool calls.
 *
 * Runs before Think's built-in approval check so hard blocks can be enforced
 * independently of the user-facing approval flow.
 *
 * @example
 * ```typescript
 * agent.hooks.toolPolicy.add({
 *   toolName: "*",
 *   handler: (ctx) => {
 *     if (typeof ctx.input === "object" && ctx.input !== null && "__proto__" in ctx.input) {
 *       return { action: "block", reason: "Prototype pollution blocked." };
 *     }
 *   },
 * });
 * ```
 */
export class ToolPolicyRegistry {
  private readonly _rules: ToolPolicyRule[] = [];

  add(rule: ToolPolicyRule): this {
    this._rules.push(rule);
    return this;
  }

  remove(rule: ToolPolicyRule): boolean {
    const idx = this._rules.indexOf(rule);
    if (idx !== -1) {
      this._rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Evaluate all matching rules. Returns the first intercepting decision,
   * or `undefined` (allow) if all rules pass.
   */
  async evaluate(ctx: PolicyCallContext): Promise<ToolCallDecision | undefined> {
    for (const rule of this._rules) {
      if (rule.toolName !== "*" && rule.toolName !== ctx.toolName) continue;
      try {
        const decision = await Promise.resolve(rule.handler(ctx));
        if (decision && decision.action !== "allow") return decision;
        if (decision && decision.action === "allow") return undefined; // explicit pass
      } catch (err) {
        console.error(`[EdgeClaw][policy] rule for "${rule.toolName}" threw:`, err);
      }
    }
    return undefined;
  }

  get size(): number {
    return this._rules.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured logger
// ─────────────────────────────────────────────────────────────────────────────

/** Enriched afterToolCall context (Think result + optional EdgeClaw fields). */
export type AfterToolCallCtx = ToolCallResultContext & {
  requestId?: string;
  ok?: boolean;
};

/**
 * Structured log entry emitted by the built-in logger.
 * Arg values and result values are intentionally omitted to prevent
 * accidental secret leakage.
 */
export interface AgentLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  agentName: string;
  requestId?: string;
  tool?: string;
  durationMs?: number;
  ok?: boolean;
  stepType?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  errorSummary?: string;
}

export type LogSink = (entry: AgentLogEntry) => void;

/**
 * Factory for composable structured logger handlers.
 * Returns objects you can pass directly to `.add()` on each pipeline.
 *
 * Safe by design:
 *   - Arg values are never logged (only tool name).
 *   - Result values are never logged.
 *   - Error messages are truncated at 200 chars.
 */
export function createStructuredLogger(agentName: string, sink: LogSink = defaultConsoleSink) {
  function log(entry: Omit<AgentLogEntry, "ts" | "agentName">) {
    sink({ ...entry, ts: new Date().toISOString(), agentName });
  }

  return {
    beforeTurn(ctx: TurnContext & { requestId?: string }) {
      log({ level: "info", event: "turn.start", requestId: ctx.requestId });
    },
    beforeToolCall(ctx: ToolCallContext & { requestId?: string }) {
      log({ level: "info", event: "tool.before", requestId: ctx.requestId, tool: ctx.toolName });
    },
    afterToolCall(ctx: AfterToolCallCtx) {
      log({
        level: (ctx.ok ?? ctx.success) === false ? "warn" : "info",
        event: "tool.after",
        requestId: ctx.requestId,
        tool: ctx.toolName,
        durationMs: ctx.durationMs,
        ok: ctx.ok ?? ctx.success,
      });
    },
    onStepFinish(ctx: StepContext & { requestId?: string }) {
      log({
        level: "info",
        event: "step.finish",
        requestId: ctx.requestId,
        stepType: String(ctx.finishReason ?? ""),
        inputTokens: ctx.usage.inputTokens,
        outputTokens: ctx.usage.outputTokens,
      });
    },
    onChatResponse(ctx: ChatResponseResult & { requestId?: string }) {
      log({
        level: ctx.status === "error" ? "error" : "info",
        event: "chat.response",
        requestId: ctx.requestId,
        status: ctx.status,
        errorSummary:
          ctx.status === "error" && ctx.error ? ctx.error.substring(0, 200) : undefined,
      });
    },
  } as const;
}

function defaultConsoleSink(entry: AgentLogEntry): void {
  console.log(`[EdgeClaw] ${JSON.stringify(entry)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentHooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All lifecycle hook pipelines and tool policy registry for one agent.
 *
 * | Pipeline           | Think method       | Return used?            |
 * |--------------------|--------------------|-------------------------|
 * | `beforeTurn`       | `beforeTurn()`     | Yes — last `TurnConfig` |
 * | `beforeToolCall`   | `beforeToolCall()` | Only from `toolPolicy`  |
 * | `afterToolCall`    | `afterToolCall()`  | No                      |
 * | `onStepFinish`     | `onStepFinish()`   | No                      |
 * | `onChunk`          | `onChunk()`        | No                      |
 * | `onChatResponse`   | `onChatResponse()` | No                      |
 */
export interface AgentHooks {
  beforeTurn: HookPipeline<TurnContext & { requestId?: string }, TurnConfig>;
  beforeToolCall: HookPipeline<ToolCallContext & { requestId?: string }>;
  afterToolCall: HookPipeline<AfterToolCallCtx>;
  onStepFinish: HookPipeline<StepContext & { requestId?: string }>;
  onChunk: HookPipeline<ChunkContext & { requestId?: string }>;
  onChatResponse: HookPipeline<ChatResponseResult & { requestId?: string }>;
  toolPolicy: ToolPolicyRegistry;
}

/**
 * Create a fresh `AgentHooks` instance with the structured logger
 * pre-attached (observational only). Pass `enableDefaultLogging: false`
 * to start with a fully empty set of pipelines.
 */
export function createAgentHooks(agentName: string, enableDefaultLogging = true): AgentHooks {
  const hooks: AgentHooks = {
    beforeTurn: new HookPipeline<TurnContext & { requestId?: string }, TurnConfig>("beforeTurn"),
    beforeToolCall: new HookPipeline<ToolCallContext & { requestId?: string }>("beforeToolCall"),
    afterToolCall: new HookPipeline<AfterToolCallCtx>("afterToolCall"),
    onStepFinish: new HookPipeline<StepContext & { requestId?: string }>("onStepFinish"),
    onChunk: new HookPipeline<ChunkContext & { requestId?: string }>("onChunk"),
    onChatResponse: new HookPipeline<ChatResponseResult & { requestId?: string }>("onChatResponse"),
    toolPolicy: new ToolPolicyRegistry(),
  };

  if (enableDefaultLogging) {
    const logger = createStructuredLogger(agentName);
    hooks.beforeTurn.add(logger.beforeTurn);
    hooks.beforeToolCall.add(logger.beforeToolCall);
    hooks.afterToolCall.add(logger.afterToolCall);
    hooks.onStepFinish.add(logger.onStepFinish);
    hooks.onChatResponse.add(logger.onChatResponse);
  }

  return hooks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat shim — still used by MainAgent.initialize() / shutdown()
// ─────────────────────────────────────────────────────────────────────────────

export enum HookType {
  BEFORE_MESSAGE = "beforeMessage",
  AFTER_MESSAGE = "afterMessage",
  BEFORE_TOOL = "beforeTool",
  AFTER_TOOL = "afterTool",
  ON_INIT = "onInit",
  ON_SHUTDOWN = "onShutdown",
  ON_ERROR = "onError",
  ON_MEMORY_REFRESH = "onMemoryRefresh",
  ON_STATE_CHANGE = "onStateChange",
}

export interface HookContext {
  agentName: string;
  timestamp: Date;
  [key: string]: unknown;
}

export type HookHandler = (context: HookContext) => Promise<void> | void;

export interface HookConfig {
  name: HookType;
  handler: HookHandler;
  priority?: number;
}

export class HookRegistry {
  private hooks: Map<HookType, HookHandler[]> = new Map();

  register(config: HookConfig): void {
    const hooks = this.hooks.get(config.name) || [];
    hooks.push(config.handler);
    this.hooks.set(config.name, hooks);
  }

  async execute(hookType: HookType, context: HookContext): Promise<void> {
    const handlers = this.hooks.get(hookType) || [];
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(context));
      } catch (error) {
        console.error(`Hook ${hookType} failed:`, error);
      }
    }
  }

  clear(hookType?: HookType): void {
    if (hookType) {
      this.hooks.delete(hookType);
    } else {
      this.hooks.clear();
    }
  }

  get(hookType: HookType): HookHandler[] {
    return this.hooks.get(hookType) || [];
  }
}
