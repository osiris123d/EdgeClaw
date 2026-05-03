/**
 * Minimal Think-based agent for delegated child DO facets (Coder / Tester).
 *
 * Intentionally does **not** extend {@link MainAgent}: the MainAgent constructor runs
 * browser-session auth wiring, voice STT/TTS, hook pipelines, and other orchestrator-only
 * startup that can touch native I/O during `_cf_initAsFacet` / `onStart`.
 */

import { Think, type Session } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { generateText } from "ai";
import { callable } from "agents";
import type { Workspace } from "@cloudflare/shell";
import {
  createStandardRouter,
  resolveLanguageModel,
  type IModelRouter,
  type LanguageModel,
  type ModelContext,
  type ModelSelectionResult,
  type RouteClass,
  type TaskType,
  type EstimatedComplexity,
  type CostSensitivity,
  type LatencySensitivity,
} from "../../models";
import { getRuntimeConfig } from "../../lib/env";
import type { Env } from "../../lib/env";
import {
  buildModelBindingsForAiGateway,
  edgeClawGatewayAgentFromConstructorName,
  gatewayObservabilityFromDelegatedUserMessage,
  type AgentObservabilityContext,
  type EdgeClawGatewayAgentName,
} from "../../lib/agentObservability";
import type { TurnConfig, TurnContext } from "../../hooks";
import {
  createAgentTools,
  defaultApprovalEvaluator,
  type WorkspaceLike,
} from "../../tools";
import { isBrowserIntentRequest } from "../browserToolAvailability";
import type { AgentTurnContext } from "../agentTurnContext";
import { clampSubAgentResultForRpc, type SubAgentResult } from "../delegation";
import { executeRpcCollectChatTurn } from "./rpcCollectChatTurnShared";
import { executeRpcCollectStatelessModelTurn } from "./statelessSubAgentModelTurn";
import { stripDebugChildNoSharedToolsPrefix } from "../../debug/debugChildDelegationPrefix";

export interface SubAgentThinkConfig {
  modelRouter?: IModelRouter;
  requestId?: string;
}

/**
 * Thin Think root for sub-agent facets — no MainAgent / voice / orchestrator startup.
 */
export abstract class BaseSubAgentThink extends Think {
  protected declare env: Env;
  protected modelRouter: IModelRouter;
  protected requestId: string;
  protected readonly aiGatewayBaseUrl: string | undefined;
  /** DEBUG: set for one rpcCollect* invocation when message carries the no-shared-tools prefix. */
  protected _debugOmitSharedWorkspaceTools = false;
  /**
   * Parsed delegation envelope for the in-flight `rpcCollect*` turn — merged into AI Gateway metadata.
   * Cleared in `finally` after each child RPC completes.
   */
  protected _rpcDelegationGatewayObs:
    | (Partial<AgentObservabilityContext> & { agent: EdgeClawGatewayAgentName })
    | null = null;

  constructor(ctx: DurableObjectState, env: Env, config: SubAgentThinkConfig = {}) {
    super(ctx, env);
    const runtime = getRuntimeConfig(env);
    this.waitForMcpConnections = false;
    this.chatRecovery = true;
    this.aiGatewayBaseUrl = runtime.aiGatewayBaseUrl;

    this.modelRouter =
      config.modelRouter ??
      createStandardRouter({
        aiGateway: runtime.aiGatewayBaseUrl
          ? {
              baseUrl: runtime.aiGatewayBaseUrl,
              authToken: env.AI_GATEWAY_TOKEN,
              enableCaching: true,
              cacheTtlSeconds: 3600,
            }
          : undefined,
        enableDetailedLogging: runtime.environment !== "production",
      });
    this.requestId = config.requestId ?? `req-${Date.now()}`;

    console.info(
      `[EdgeClaw][subagent-facet] ${this.constructor.name} ctor — no MainAgent browser/voice/MCP-oauth/TTS wiring`
    );
  }

  /**
   * Think runs `onStart` from the SDK (workspace, session, MCP restore from **Agent** base, etc.).
   * We do not add MainAgent `_mcpRestoreServers`, TTS storage restore, or OAuth callback HTML.
   */
  override async onStart(): Promise<void> {
    console.info(`[EdgeClaw][subagent-facet] ${this.constructor.name}.onStart → super() (Think+Agent SDK only)`);
    await super.onStart();
    console.info(
      `[EdgeClaw][subagent-facet] ${this.constructor.name}.onStart done — skipped MainAgent browser/MCP OAuth/aura TTS restore`
    );
  }

  abstract override configureSession(session: Session): Session;

  protected getWorkspace(): Workspace | undefined {
    return this.workspace as Workspace | undefined;
  }

  /** Role-specific routing hints — same contract as MainAgent. */
  protected abstract getRoleModelContextOverrides(turn: AgentTurnContext): Partial<ModelContext>;

  protected inferTaskType(turn: AgentTurnContext): TaskType {
    if (turn.taskType) {
      return turn.taskType;
    }
    const text = (turn.message || "").toLowerCase();
    if (/\b(search|browse|find|lookup|web|source|citation|summarize)\b/.test(text)) {
      return "search";
    }
    if (/\b(code|bug|fix|refactor|typescript|javascript|function|test)\b/.test(text)) {
      return "code";
    }
    if (/\b(analyze|analysis|compare|evaluate|reason|why)\b/.test(text)) {
      return "analysis";
    }
    if (/\b(tool|execute|run|command|terminal|file)\b/.test(text)) {
      return "tool_use";
    }
    if (/\b(write|draft|compose|edit|improve)\b/.test(text)) {
      return "content";
    }
    return "general";
  }

  protected inferLikelyToolUsage(turn: AgentTurnContext): boolean {
    if (typeof turn.likelyToolUsage === "boolean") {
      return turn.likelyToolUsage;
    }
    const text = (turn.message || "").toLowerCase();
    return /\b(search|browse|open|navigate|fetch|execute|run|read file|list|query)\b/.test(text);
  }

  protected inferComplexity(turn: AgentTurnContext): EstimatedComplexity {
    if (turn.estimatedComplexity) {
      return turn.estimatedComplexity;
    }
    const length = (turn.message || "").length;
    if (length > 2400) return "expert";
    if (length > 1200) return "complex";
    if (length > 400) return "moderate";
    return "simple";
  }

  protected classifyRouteClass(turn: AgentTurnContext): RouteClass {
    const text = (turn.message || "").toLowerCase();
    const likelyToolUse = this.inferLikelyToolUsage(turn);
    const complexity = this.inferComplexity(turn);

    if (isBrowserIntentRequest(text)) {
      return "tools";
    }
    if (/\b(image|vision|photo|diagram|ocr)\b/.test(text)) {
      return "vision";
    }
    if (likelyToolUse) {
      return "tools";
    }
    if (
      complexity === "complex" ||
      complexity === "expert" ||
      /\b(reason|analyz|compare|derive|prove|tradeoff|debug|refactor)\b/.test(text)
    ) {
      return "reasoning";
    }
    return "utility";
  }

  protected buildTurnModelContext(turn: AgentTurnContext): ModelContext {
    const routeClass = this.classifyRouteClass(turn);
    const inferredTaskType = this.inferTaskType(turn);
    const inferredComplexity = this.inferComplexity(turn);
    const inferredToolUse = this.inferLikelyToolUsage(turn);

    const inferredLatency: LatencySensitivity =
      turn.latencySensitivity || (inferredToolUse ? "high" : "medium");

    const inferredCost: CostSensitivity =
      turn.costSensitivity || (inferredComplexity === "expert" ? "low" : "medium");

    const estimatedPromptTokens =
      turn.estimatedPromptTokens ?? Math.max(128, Math.ceil(((turn.message || "").length || 0) / 4));

    const baseContext: ModelContext = {
      taskType: inferredTaskType,
      estimatedComplexity: inferredComplexity,
      expectsToolUse: inferredToolUse,
      latencySensitivity: inferredLatency,
      costSensitivity: inferredCost,
      agentRole: "general",
      estimatedPromptTokens,
      estimatedOutputTokens: turn.estimatedOutputTokens,
      requestId: this.requestId,
      forceModel: routeClass,
    };

    return {
      ...baseContext,
      ...this.getRoleModelContextOverrides(turn),
    };
  }

  async selectModel(context: Partial<ModelContext>): Promise<ModelSelectionResult> {
    const fullContext: ModelContext = {
      taskType: context.taskType || "general",
      estimatedComplexity: context.estimatedComplexity || "moderate",
      expectsToolUse: context.expectsToolUse ?? false,
      latencySensitivity: context.latencySensitivity || "medium",
      costSensitivity: context.costSensitivity || "medium",
      agentRole: context.agentRole || "general",
      requestId: context.requestId || this.requestId,
      ...context,
    };
    return this.modelRouter.selectModel(fullContext);
  }

  getModel(): LanguageModel {
    const fallback = this.modelRouter.getDefaultModel();
    const selection: ModelSelectionResult = {
      selected: fallback,
      reason: "Default model for Think runtime getModel()",
      score: 0,
      alternatives: [],
      selectedRouteClass: fallback.routeClass,
      dynamicRouteModel: fallback.modelId,
      gatewayBaseUrl: this.aiGatewayBaseUrl,
    };
    return resolveLanguageModel(
      selection,
      buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, {
        agent: edgeClawGatewayAgentFromConstructorName(this.constructor.name),
      })
    );
  }

  /**
   * Latest user text from Think's assembled messages (same shapes as {@link MainAgent} chat).
   * Used so {@link classifyRouteClass} / {@link buildTurnModelContext} see the real delegation body.
   */
  private extractLatestUserMessageTextFromTurnContext(
    messages: TurnContext["messages"] | undefined
  ): string {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as {
        role?: string;
        content?: unknown;
        parts?: unknown;
      };
      if (!message || typeof message !== "object") continue;
      if (message.role !== "user") continue;

      const parts = message.parts;
      if (Array.isArray(parts) && parts.length > 0) {
        const text = parts
          .map((p: unknown) => {
            const o = p as { type?: string; text?: string };
            return o.type === "text" && typeof o.text === "string" ? o.text : "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }

      const content = message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const pieces = content
          .map((part: unknown) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const t = (part as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          })
          .filter(Boolean);
        if (pieces.length > 0) return pieces.join(" ");
      }
    }
    return "";
  }

  /**
   * Ensures AI Gateway requests carry `cf-aig-metadata` (Think calls `getModel()` before `beforeTurn`;
   * we still override the model in {@link beforeTurn} for routed selection).
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const prior = await super.beforeTurn(ctx);
    const userText = this.extractLatestUserMessageTextFromTurnContext(ctx.messages);
    const model = await this.getModelForTurn({
      message: userText,
    });
    return { ...(prior && typeof prior === "object" ? prior : {}), model };
  }

  async getModelForTurn(turn: AgentTurnContext = {}): Promise<LanguageModel> {
    const selection = await this.selectModelForTurn(turn);
    const classAgent = edgeClawGatewayAgentFromConstructorName(this.constructor.name);
    const fromTurn = turn.aiGatewayObservability;
    const fromRpc = this._rpcDelegationGatewayObs;
    return resolveLanguageModel(
      selection,
      buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, {
        agent: fromTurn?.agent ?? fromRpc?.agent ?? classAgent,
        projectId: fromTurn?.projectId ?? fromRpc?.projectId,
        taskId: fromTurn?.taskId ?? fromRpc?.taskId,
        runId: fromTurn?.runId ?? fromRpc?.runId,
      })
    );
  }

  async selectModelForTurn(turn: AgentTurnContext = {}): Promise<ModelSelectionResult> {
    const context = this.buildTurnModelContext(turn);
    try {
      return await this.selectModel(context);
    } catch (err) {
      const errorSummary =
        err instanceof Error ? err.message.substring(0, 200) : String(err).substring(0, 200);
      console.warn(
        `[EdgeClaw][subagent-facet] ${this.constructor.name} selectModel fallback: ${errorSummary}`
      );
      const fallback = this.modelRouter.getDefaultModel();
      return {
        selected: fallback,
        reason: "Fallback to default — original selection failed",
        score: 0,
        alternatives: [],
        selectedRouteClass: fallback.routeClass,
        dynamicRouteModel: fallback.modelId,
        gatewayBaseUrl: this.aiGatewayBaseUrl,
        warnings: [`Model selection failed: ${errorSummary}`],
      };
    }
  }

  /**
   * Compaction summarizer — no MainAgent turn telemetry side effects.
   */
  protected createCompactionSummarizer(): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      const model = await this.getModelForTurn({
        taskType: "analysis",
        estimatedComplexity: "moderate",
        likelyToolUsage: false,
      });
      const result = await generateText({
        model,
        prompt:
          "Summarize the following older conversation segment for durable operational context. " +
          "Preserve only durable facts and important tool outcomes. Output concise bullet points only.\n\n" +
          prompt,
        maxOutputTokens: 500,
      });
      return result.text.trim();
    };
  }

  /**
   * Custom tools for sub-agents — project notes + search only (no browser, code exec, workflows, tasks).
   */
  getTools(): ToolSet {
    return createAgentTools({
      workspace: this.getWorkspace() as unknown as WorkspaceLike | undefined,
      approvalEvaluator: defaultApprovalEvaluator,
    });
  }

  @callable()
  async rpcCollectChatTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    try {
      const { message: effective, omitSharedWorkspaceTools } = stripDebugChildNoSharedToolsPrefix(
        this.env,
        raw
      );
      this._debugOmitSharedWorkspaceTools = omitSharedWorkspaceTools;
      this._rpcDelegationGatewayObs = gatewayObservabilityFromDelegatedUserMessage(
        effective,
        edgeClawGatewayAgentFromConstructorName(this.constructor.name)
      );
      return clampSubAgentResultForRpc(await executeRpcCollectChatTurn(this, effective));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[EdgeClaw][subagent-facet] ${this.constructor.name}.rpcCollectChatTurn failed`,
        msg
      );
      return clampSubAgentResultForRpc({ text: "", events: [], ok: false, error: msg });
    } finally {
      this._rpcDelegationGatewayObs = null;
      this._debugOmitSharedWorkspaceTools = false;
    }
  }

  /**
   * DEBUG / isolation — same RPC boundary as {@link rpcCollectChatTurn} but skips Think
   * `saveMessages` / `getMessages`; runs one-shot `generateText` with {@link getTools}.
   * Parent enables via `DelegationOptions.statelessSubAgentModelTurn` (see `delegation.ts`).
   */
  @callable()
  async rpcCollectStatelessModelTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    try {
      const { message: effective, omitSharedWorkspaceTools } = stripDebugChildNoSharedToolsPrefix(
        this.env,
        raw
      );
      this._debugOmitSharedWorkspaceTools = omitSharedWorkspaceTools;
      this._rpcDelegationGatewayObs = gatewayObservabilityFromDelegatedUserMessage(
        effective,
        edgeClawGatewayAgentFromConstructorName(this.constructor.name)
      );
      return clampSubAgentResultForRpc(await executeRpcCollectStatelessModelTurn(this, effective));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[EdgeClaw][subagent-facet] ${this.constructor.name}.rpcCollectStatelessModelTurn failed`,
        msg
      );
      return clampSubAgentResultForRpc({ text: "", events: [], ok: false, error: msg });
    } finally {
      this._rpcDelegationGatewayObs = null;
      this._debugOmitSharedWorkspaceTools = false;
    }
  }
}
