/**
 * Intelligent model routing with support for multiple providers
 * Centralizes all model orchestration decisions
 *
 * Routing strategy:
 * 1. Check for forced model (overrides everything)
 * 2. Filter by context requirements (capabilities, context window, etc.)
 * 3. Eliminate excluded models and deprecated models
 * 4. Score remaining models on:
 *    - Task optimization (boosted if optimizedFor matches)
 *    - Latency sensitivity (prefer faster models if critical latency)
 *    - Cost sensitivity (prefer cheaper models if high cost sensitivity)
 *    - Capabilities match (tool use, long context, etc.)
 * 5. Return top-scoring model with alternatives
 * 6. Include gateway URL if using AI Gateway
 */

import {
  ModelConfig,
  ModelContext,
  ModelSelectionResult,
  ModelBindings,
  IModelRouter,
  RouterConfig,
  AIGatewayConfig,
  RouteClass,
} from "./types";
import type { Observability } from "../lib/observability";

/**
 * AI SDK imports for OpenAI-compatible AI Gateway `/compat` routing.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/** Default AI Gateway dynamic route: all route classes hit `dynamic/agent-router` unless overridden via `routeClassModelMap`. */
const DEFAULT_ROUTE_CLASS_MODEL_MAP: Record<RouteClass, string> = {
  utility: "dynamic/agent-router",
  tools: "dynamic/agent-router",
  reasoning: "dynamic/agent-router",
  vision: "dynamic/agent-router",
};

export function getDefaultRouteClassModelMap(): Record<RouteClass, string> {
  return { ...DEFAULT_ROUTE_CLASS_MODEL_MAP };
}

function isDynamicRouteModel(model: string): boolean {
  return /^dynamic\/[a-z0-9][a-z0-9-]*$/i.test(model);
}

function ensureCompatGatewayBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!/\/compat$/i.test(normalized)) {
    throw new Error(
      `AI_GATEWAY_BASE_URL must point to the OpenAI-compatible /compat endpoint (got: ${baseUrl}).`
    );
  }
  return normalized;
}

/**
 * Flexible model router supporting multiple providers
 * Can select from pool of registered models based on task context
 *
 * Usage:
 *   const router = new ModelRouter(config);
 *   router.registerModel(claudeOpusModel);
 *   router.registerModel(claudeSonnetModel);
 *   const selection = await router.selectModel(context);
 */
export class ModelRouter implements IModelRouter {
  private models: Map<string, ModelConfig> = new Map();
  private config: RouterConfig;
  private defaultModelId: string | null = null;

  constructor(config: RouterConfig = {}) {
    const normalizedGateway = config.aiGateway?.baseUrl
      ? {
          ...config.aiGateway,
          baseUrl: ensureCompatGatewayBaseUrl(config.aiGateway.baseUrl),
        }
      : undefined;

    this.config = {
      aiGateway: normalizedGateway,
      allowFallback: true,
      costWeightFactor: 1.0,
      latencyWeightFactor: 1.0,
      enableDetailedLogging: false,
      ...config,
      ...(normalizedGateway ? { aiGateway: normalizedGateway } : {}),
    };
  }

  /**
   * Register a model in the router
   * Can be called multiple times to build model pool
   */
  registerModel(model: ModelConfig): void {
    if (this.models.size === 0) {
      this.defaultModelId = model.id;
    }
    this.models.set(model.id, model);

    if (this.config.enableDetailedLogging) {
      console.log(`[ModelRouter] Registered model: ${model.name} (${model.id})`);
    }
  }

  /**
   * Register multiple models at once
   */
  registerModels(models: ModelConfig[]): void {
    for (const model of models) {
      this.registerModel(model);
    }
  }

  /**
   * Get model by ID
   */
  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId);
  }

  /**
   * Get all registered models
   */
  getAllModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  /**
   * Get default model for fallback scenarios
   */
  getDefaultModel(): ModelConfig {
    if (!this.defaultModelId) {
      throw new Error("No models registered");
    }
    const model = this.models.get(this.defaultModelId);
    if (!model) {
      throw new Error(`Default model ${this.defaultModelId} not found`);
    }
    return model;
  }

  /**
   * Get models suitable for a specific task type
   */
  getModelsForTask(taskType: string): ModelConfig[] {
    return Array.from(this.models.values()).filter((model) => {
      // Include models optimized for this task
      if (model.optimizedFor?.includes(taskType as any)) {
        return true;
      }
      // Exclude models marked to avoid this task
      if (model.avoidFor?.includes(taskType as any)) {
        return false;
      }
      // Include general models
      return true;
    });
  }

  /**
   * Core model selection logic
   * Evaluates context and returns best-fitting model with reasoning
   */
  async selectModel(context: ModelContext): Promise<ModelSelectionResult> {
    const requestId = context.requestId || `req-${Date.now()}`;

    // 1. Check for forced model (overrides all logic)
    if (context.forceModel) {
      const forced = this.models.get(context.forceModel);
      if (forced) {
        if (this.config.enableDetailedLogging) {
          console.log(`[ModelRouter:${requestId}] Forced model: ${forced.name}`);
        }
        const result = this.buildSelectionResult(forced, "Explicitly forced", 100, context);
        if (this.config.obs) this.emitModelSelected(result, context, this.config.obs);
        return result;
      }
      console.warn(
        `[ModelRouter:${requestId}] Forced model not found: ${context.forceModel}`
      );
    }

    // 2. Filter candidates based on requirements
    const candidates = this.getCandidateModels(context);

    if (candidates.length === 0) {
      throw new Error(
        `[ModelRouter:${requestId}] No suitable models found for context: ` +
          JSON.stringify(context)
      );
    }

    // 3. Score each candidate
    const scored = candidates.map((model) => ({
      model,
      score: this.scoreModel(model, context),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const [bestScore, ...alternatives] = scored;

    if (this.config.enableDetailedLogging) {
      console.log(
        `[ModelRouter:${requestId}] Selection scores:`,
        scored.map((s) => `${s.model.name}=${s.score.toFixed(1)}`).join(", ")
      );
    }

    const result = this.buildSelectionResult(
      bestScore.model,
      this.getSelectionReason(bestScore.model, context),
      bestScore.score,
      context,
      alternatives.slice(0, 3).map((alt) => ({
        model: alt.model,
        score: alt.score,
        reason: this.getSelectionReason(alt.model, context),
      }))
    );

    if (this.config.obs) this.emitModelSelected(result, context, this.config.obs);

    return result;
  }

  /**
   * Emit a structured `model.selected` event if an `Observability` instance
   * was supplied in the router config. Called right after `selectModel` resolves.
   */
  private emitModelSelected(
    result: ModelSelectionResult,
    context: ModelContext,
    obs: Observability
  ): void {
    const isDebug = obs.isEnabled("debug");
    obs.emit({
      event: "model.selected",
      ts: new Date().toISOString(),
      requestId: context.requestId,
      agentName: obs.agentName,
      modelId: result.selected.id,
      modelName: result.selected.name,
      provider: result.selected.provider,
      score: result.score,
      reason: result.reason,
      gatewayUsed: result.selected.provider === "ai-gateway",
      taskType: context.taskType,
      routeClass: result.selectedRouteClass,
      dynamicRouteModel: result.dynamicRouteModel,
      gatewayBaseUrl: result.gatewayBaseUrl,
      // Alternatives only at debug level — keeps info-level logs concise.
      alternatives: isDebug
        ? result.alternatives?.map((a) => ({ modelId: a.model.id, score: a.score }))
        : undefined,
      warnings: result.warnings,
    });
  }

  /**
   * Filter models to get candidates based on context requirements
   */
  private getCandidateModels(context: ModelContext): ModelConfig[] {
    return Array.from(this.models.values()).filter((model) => {
      // Skip excluded models
      if (context.excludeModels?.includes(model.id)) {
        return false;
      }

      // Skip deprecated models unless explicitly forced
      if (model.deprecated && !context.forceModel) {
        return false;
      }

      // Filter by provider preference
      if (context.preferredProviders && context.preferredProviders.length > 0) {
        if (!context.preferredProviders.includes(model.provider)) {
          return false;
        }
      }

      // Verify context window is sufficient
      const totalTokens =
        (context.estimatedPromptTokens || 1000) +
        (context.estimatedOutputTokens || 1000);
      if (totalTokens > model.contextWindow) {
        return false;
      }

      // Verify tool use capability if needed
      if (context.expectsToolUse && !model.capabilities.toolUse) {
        return false;
      }

      // Verify long context if needed
      if (
        context.estimatedPromptTokens &&
        context.estimatedPromptTokens > 16000 &&
        !model.capabilities.longContext
      ) {
        return false;
      }

      return true;
    });
  }

  /**
   * Score a single model against the context
   * Higher score = better fit (0-100)
   */
  private scoreModel(model: ModelConfig, context: ModelContext): number {
    let score = 50; // Base score

    // Task optimization bonus
    if (model.optimizedFor?.includes(context.taskType)) {
      score += 20;
    }

    // Capabilities match
    if (
      context.expectsToolUse &&
      model.capabilities.toolUse &&
      model.capabilities.functionCalling
    ) {
      score += 10;
    }

    // Long context capability
    if (
      context.estimatedPromptTokens &&
      context.estimatedPromptTokens > 8000 &&
      model.capabilities.longContext
    ) {
      score += 15;
    }

    // Latency sensitivity scoring
    const latencyScore = this.scoreLatency(model, context);
    score += latencyScore;

    // Cost sensitivity scoring
    const costScore = this.scoreCost(model, context);
    score += costScore;

    // Complexity match scoring
    const complexityScore = this.scoreComplexityMatch(model, context);
    score += complexityScore;

    return Math.min(100, Math.max(0, score)); // Clamp to 0-100
  }

  /**
   * Score latency fit for the context
   */
  private scoreLatency(model: ModelConfig, context: ModelContext): number {
    if (!model.estimatedLatencyMs) {
      return 0; // No latency info
    }

    const factor = this.config.latencyWeightFactor || 1.0;

    switch (context.latencySensitivity) {
      case "critical":
        // Strongly prefer fast models
        if (model.estimatedLatencyMs.p95 < 500) return 15 * factor;
        if (model.estimatedLatencyMs.p95 < 1000) return 5 * factor;
        return -10 * factor;

      case "high":
        // Prefer fast models
        if (model.estimatedLatencyMs.p95 < 1000) return 10 * factor;
        if (model.estimatedLatencyMs.p95 < 3000) return 0;
        return -5 * factor;

      case "medium":
        // Neutral
        return 0;

      case "low":
        // No penalty for slower models, allows more capable models
        return 0;

      default:
        return 0;
    }
  }

  /**
   * Score cost fit for the context
   */
  private scoreCost(model: ModelConfig, context: ModelContext): number {
    const factor = this.config.costWeightFactor || 1.0;

    switch (context.costSensitivity) {
      case "high":
        // Strongly prefer cheap models
        if (model.costTier === "free" || model.costTier === "standard") {
          return 15 * factor;
        }
        if (model.costTier === "premium") {
          return -5 * factor;
        }
        return -20 * factor;

      case "medium":
        // Slight preference for cheaper models
        if (model.costTier === "free" || model.costTier === "standard") {
          return 5 * factor;
        }
        if (model.costTier === "ultra") {
          return -5 * factor;
        }
        return 0;

      case "low":
        // Cost doesn't matter, use more capable models if available
        if (model.costTier === "premium" || model.costTier === "ultra") {
          return 5;
        }
        return 0;

      default:
        return 0;
    }
  }

  /**
   * Score how well model's capabilities match task complexity
   */
  private scoreComplexityMatch(
    model: ModelConfig,
    context: ModelContext
  ): number {
    switch (context.estimatedComplexity) {
      case "simple":
        // Any model works fine
        return 0;

      case "moderate":
        // Prefer models with reasoning
        return model.capabilities.reasoning ? 5 : -5;

      case "complex":
        // Need strong reasoning capability
        return model.capabilities.reasoning ? 10 : -15;

      case "expert":
        // Need the strongest reasoning models
        return model.capabilities.reasoning ? 15 : -25;

      default:
        return 0;
    }
  }

  /**
   * Construct the selection result with gateway URL if applicable
   */
  private buildSelectionResult(
    selected: ModelConfig,
    reason: string,
    score: number,
    context: ModelContext,
    alternatives: Array<{
      model: ModelConfig;
      score: number;
      reason: string;
    }> = []
  ): ModelSelectionResult {
    const result: ModelSelectionResult = {
      selected,
      reason,
      score,
      alternatives,
      selectedRouteClass: selected.routeClass,
      dynamicRouteModel: selected.modelId,
    };

    // Add gateway URL if model uses AI Gateway
    if (selected.provider === "ai-gateway" && this.config.aiGateway) {
      result.gatewayUrl = this.getGatewayUrl(selected, this.config.aiGateway);
      result.gatewayBaseUrl = this.config.aiGateway.baseUrl;
    }

    // Add warnings if applicable
    const warnings: string[] = [];

    // Warn if model is deprecated
    if (selected.deprecated) {
      warnings.push("Selected model is deprecated");
    }

    // Warn if cost might be high
    if (
      context.costSensitivity === "high" &&
      selected.costTier === "ultra"
    ) {
      warnings.push("Selected model is expensive for high cost-sensitivity");
    }

    // Warn if latency might be high
    if (
      context.latencySensitivity === "critical" &&
      selected.estimatedLatencyMs?.p95 &&
      selected.estimatedLatencyMs.p95 > 1000
    ) {
      warnings.push(
        `Model may not meet ${context.latencySensitivity} latency requirements`
      );
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    return result;
  }

  /**
   * Get human-readable reason for model selection
   */
  private getSelectionReason(
    model: ModelConfig,
    context: ModelContext
  ): string {
    const reasons: string[] = [];

    // Task optimization
    if (model.optimizedFor?.includes(context.taskType)) {
      reasons.push(`optimized for ${context.taskType}`);
    }

    // Capability match
    if (context.expectsToolUse && model.capabilities.toolUse) {
      reasons.push("supports tool use");
    }

    // Complexity
    if (model.capabilities.reasoning && context.estimatedComplexity !== "simple") {
      reasons.push(`handles ${context.estimatedComplexity} complexity`);
    }

    // Cost
    if (context.costSensitivity === "high" && model.costTier === "standard") {
      reasons.push("cost-effective");
    }

    // Latency
    if (
      context.latencySensitivity === "critical" &&
      model.estimatedLatencyMs?.p95 &&
      model.estimatedLatencyMs.p95 < 500
    ) {
      reasons.push("meets latency requirements");
    }

    return reasons.length > 0
      ? reasons.join(", ")
      : `${model.name} is suitable for this task`;
  }

  /**
   * Construct AI Gateway URL for a model
   */
  private getGatewayUrl(
    model: ModelConfig,
    gatewayConfig: AIGatewayConfig
  ): string {
    const route = model.gatewayRoute || model.modelId;
    return `${gatewayConfig.baseUrl}/${route}`;
  }

  /**
   * Get the current AI Gateway configuration
   */
  getGatewayConfig(): AIGatewayConfig | undefined {
    return this.config.aiGateway;
  }

  /**
   * Update router configuration at runtime
   */
  updateConfig(config: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Create a standard router with common models
 * This factory includes popular models and is ready to use
 */
export function createStandardRouter(
  config: RouterConfig = {}
): ModelRouter {
  const router = new ModelRouter(config);

  const routeMap: Record<RouteClass, string> = {
    ...getDefaultRouteClassModelMap(),
    ...(config.routeClassModelMap ?? {}),
  };

  router.registerModels([
    {
      id: "utility",
      name: "Utility Route",
      provider: "ai-gateway",
      routeClass: "utility",
      modelId: routeMap.utility,
      costTier: "standard",
      capabilities: {
        reasoning: false,
        toolUse: false,
        longContext: false,
        functionCalling: true,
      },
      contextWindow: 128000,
      maxOutputTokens: 2048,
      optimizedFor: ["general", "content"],
      estimatedLatencyMs: { p50: 250, p95: 600, p99: 1200 },
    },
    {
      id: "tools",
      name: "Tools Route",
      provider: "ai-gateway",
      routeClass: "tools",
      modelId: routeMap.tools,
      costTier: "premium",
      capabilities: {
        reasoning: true,
        toolUse: true,
        longContext: true,
        functionCalling: true,
        coding: true,
      },
      contextWindow: 200000,
      maxOutputTokens: 4096,
      optimizedFor: ["tool_use", "code", "analysis"],
      estimatedLatencyMs: { p50: 450, p95: 1200, p99: 2200 },
    },
    {
      id: "reasoning",
      name: "Reasoning Route",
      provider: "ai-gateway",
      routeClass: "reasoning",
      modelId: routeMap.reasoning,
      costTier: "premium",
      capabilities: {
        reasoning: true,
        toolUse: true,
        longContext: true,
        functionCalling: true,
        coding: true,
      },
      contextWindow: 200000,
      maxOutputTokens: 4096,
      optimizedFor: ["reasoning", "analysis", "code"],
      estimatedLatencyMs: { p50: 700, p95: 1600, p99: 2800 },
    },
    {
      id: "vision",
      name: "Vision Route",
      provider: "ai-gateway",
      routeClass: "vision",
      modelId: routeMap.vision,
      costTier: "premium",
      capabilities: {
        reasoning: true,
        toolUse: false,
        longContext: true,
        functionCalling: true,
        vision: true,
      },
      contextWindow: 128000,
      maxOutputTokens: 4096,
      optimizedFor: ["analysis", "general"],
      estimatedLatencyMs: { p50: 650, p95: 1600, p99: 3000 },
    },
  ]);

  return router;
}

/**
 * Create a router optimized for research tasks
 */
export function createResearchRouter(config: RouterConfig = {}): ModelRouter {
  const router = createStandardRouter({
    costWeightFactor: 0.5, // Allow expensive models for better research
    ...config,
  });
  return router;
}

/**
 * Create a router optimized for cost
 */
export function createCostOptimizedRouter(config: RouterConfig = {}): ModelRouter {
  const router = createStandardRouter({
    costWeightFactor: 2.0, // Heavily penalize expensive models
    ...config,
  });
  return router;
}

/**
 * Create a router optimized for speed
 */
export function createSpeedOptimizedRouter(config: RouterConfig = {}): ModelRouter {
  return createStandardRouter({
    latencyWeightFactor: 2.0, // Heavily prefer fast models
    ...config,
  });
}

/**
 * Create a delegating router that transforms context before forwarding to a base router.
 *
 * Use this in sub-agents to override routing behavior without reimplementing
 * the full IModelRouter interface. The transform function receives the incoming
 * context and returns a modified version; all other IModelRouter methods are
 * delegated unchanged to the base router.
 *
 * @example
 *   const researchRouter = createDelegatingRouter(baseRouter, (ctx) => ({
 *     ...ctx,
 *     agentRole: "research",
 *     estimatedComplexity: ctx.estimatedComplexity === "simple" ? "moderate" : ctx.estimatedComplexity,
 *   }));
 */
export function createDelegatingRouter(
  base: IModelRouter,
  transformContext: (context: ModelContext) => ModelContext
): IModelRouter {
  return {
    selectModel: (context) => base.selectModel(transformContext(context)),
    getDefaultModel: () => base.getDefaultModel(),
    registerModel: (model) => base.registerModel(model),
    getModel: (id) => base.getModel(id),
    getAllModels: () => base.getAllModels(),
    getModelsForTask: (taskType) => base.getModelsForTask(taskType),
  };
}

// ---------------------------------------------------------------------------
// AI SDK resolver
// ---------------------------------------------------------------------------

/**
 * Convert a ModelSelectionResult into an OpenAI-compatible AI Gateway model.
 *
 * This integration path follows Cloudflare AI Gateway `/compat` dynamic routes:
 * - baseURL  = AI_GATEWAY_BASE_URL (must end with /compat)
 * - apiKey   = non-empty placeholder required by AI SDK OpenAI client initialization
 * - headers  = { "cf-aig-authorization": "Bearer <AI_GATEWAY_TOKEN>" }
 * - model    = dynamic/<route-name>
 */
export function resolveLanguageModel(
  selection: ModelSelectionResult,
  bindings: ModelBindings = {}
): LanguageModel {
  const { selected, gatewayBaseUrl } = selection;
  const selectedRouteClass = selection.selectedRouteClass ?? selected.routeClass;
  const dynamicRouteModel = selection.dynamicRouteModel ?? selected.modelId;

  if (selected.provider !== "ai-gateway") {
    throw new Error(
      `[resolveLanguageModel] Unsupported provider "${selected.provider}" for dynamic route resolution.`
    );
  }

  if (!gatewayBaseUrl) {
    throw new Error(
      `[resolveLanguageModel] Missing AI Gateway base URL for model "${selected.id}".`
    );
  }

  const compatBaseUrl = ensureCompatGatewayBaseUrl(gatewayBaseUrl);

  if (!isDynamicRouteModel(dynamicRouteModel)) {
    throw new Error(
      `[resolveLanguageModel] Invalid dynamic route model string "${dynamicRouteModel}" ` +
      `(routeClass=${selectedRouteClass ?? "unknown"}). Expected model to match dynamic/<route-name>.`
    );
  }

  if (!bindings.aiGatewayToken) {
    throw new Error(
      "[resolveLanguageModel] Missing AI_GATEWAY_TOKEN for AI Gateway /compat integration."
    );
  }

  const gatewayAuthConfigured = Boolean(bindings.aiGatewayToken.trim());

  console.info(
    `[EdgeClaw][aig] preparing compat request routeClass=${selectedRouteClass ?? "unknown"} ` +
      `model=${dynamicRouteModel} baseURL=${compatBaseUrl} ` +
      `cf-aig-authorization=${gatewayAuthConfigured ? "configured" : "missing"}`
  );

  return createOpenAI({
    baseURL: compatBaseUrl,
    // AI SDK OpenAI provider requires a non-empty apiKey at initialization time.
    // Actual gateway auth is sent via cf-aig-authorization.
    apiKey: "cf-aig-placeholder",
    headers: {
      "cf-aig-authorization": `Bearer ${bindings.aiGatewayToken}`,
    },
    fetch: async (input, init) => {
      const outgoingHeaders = new Headers(init?.headers);
      const hadAuthorizationHeader = outgoingHeaders.has("authorization");
      outgoingHeaders.delete("authorization");

      console.info(
        `[EdgeClaw][aig] compat fetch wrapper cf-aig-authorization=${outgoingHeaders.has("cf-aig-authorization") ? "configured" : "missing"} ` +
          `authorizationStripped=${hadAuthorizationHeader ? "yes" : "no"}`
      );

      if (bindings.aiGatewayMetadataJson?.trim()) {
        outgoingHeaders.set("cf-aig-metadata", bindings.aiGatewayMetadataJson.trim());
      }

      return fetch(input, {
        ...init,
        headers: outgoingHeaders,
      });
    },
  }).chat(dynamicRouteModel);
}
