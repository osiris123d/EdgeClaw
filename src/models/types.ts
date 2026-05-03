/**
 * Comprehensive type definitions for flexible model orchestration
 * Supports multiple providers, dynamic selection, and AI Gateway routing
 */

/**
 * Model provider types
 * - ai-gateway: Routed through Cloudflare AI Gateway `/compat`
 * - external: Custom external provider (if implementing your own handler)
 */
export type Provider = "workers-ai" | "ai-gateway" | "external";

/**
 * Thin application-level route class labels.
 *
 * The app chooses one of these labels per turn and maps it to a dynamic
 * AI Gateway route model string (e.g. `dynamic/agent-router`).
 */
export type RouteClass = "utility" | "tools" | "reasoning" | "vision";

/**
 * Model pricing/cost tier for budget-aware routing
 */
export type CostTier = "free" | "standard" | "premium" | "ultra";

/**
 * Task types that models can be optimized for
 */
export type TaskType =
  | "reasoning" // Complex logical problems
  | "code" // Code generation and analysis
  | "content" // Writing and generation
  | "tool_use" // Function/tool calling
  | "search" // Search and retrieval
  | "analysis" // Data analysis and synthesis
  | "general"; // General conversational

/**
 * Complexity estimation used for model selection
 */
export type EstimatedComplexity = "simple" | "moderate" | "complex" | "expert";

/**
 * Latency requirements for model selection
 * - low: Sub-second acceptable, can use more capable models
 * - medium: Few seconds acceptable
 * - high: Sub-second desired, prefer faster models
 * - critical: <500ms required
 */
export type LatencySensitivity = "low" | "medium" | "high" | "critical";

/**
 * Cost sensitivity for budget-aware routing
 */
export type CostSensitivity = "low" | "medium" | "high";

/**
 * Agent role or specialization
 * Helps router understand context beyond just task type
 */
export type AgentRole =
  | "general" // Multi-purpose
  | "research" // Information gathering and analysis
  | "execution" // Task execution and automation
  | "analysis" // Data-driven analysis
  | "creative" // Creative tasks like writing
  | "code"; // Code-focused work

/**
 * Comprehensive model configuration
 * Describes a single model's capabilities and how to access it
 */
export interface ModelConfig {
  /** Unique identifier for this model configuration */
  id: string;

  /** Display name for logging/UI */
  name: string;

  /** Where the model is hosted/accessed from */
  provider: Provider;

  /**
   * Model identifier sent to the OpenAI-compatible API.
   * For dynamic routing this is expected to be `dynamic/<route-name>`.
   */
  modelId: string;

  /** Thin app-level route class label for this model entry. */
  routeClass?: RouteClass;

  /** Pricing tier for budget-aware decisions */
  costTier: CostTier;

  /** What this model can do */
  capabilities: {
    /** Complex reasoning and logic tasks */
    reasoning: boolean;
    /** Function calling / tool use */
    toolUse: boolean;
    /** Long context windows (32k+) */
    longContext: boolean;
    /** Function calling / structured output */
    functionCalling: boolean;
    /** Vision/image understanding */
    vision?: boolean;
    /** Code generation quality */
    coding?: boolean;
  };

  /** Maximum input context window in tokens */
  contextWindow: number;

  /** Maximum output tokens per request */
  maxOutputTokens: number;

  /** Supports streaming responses */
  supportsStreaming?: boolean;

  /**
   * Custom AI Gateway route if different from modelId
   * If provided, overrides modelId for gateway routing
   * Example: "models/claude-3-5-sonnet"
   */
  gatewayRoute?: string;

  /**
   * Whether this model should be considered deprecated
   * Router will avoid using deprecated models unless explicitly requested
   */
  deprecated?: boolean;

  /**
   * Approximate latency profile in milliseconds
   * Used for latency-sensitive decisions
   */
  estimatedLatencyMs?: {
    p50: number; // 50th percentile
    p95: number; // 95th percentile
    p99: number; // 99th percentile
  };

  /**
   * Estimated cost per 1M input tokens (in USD)
   * Used for cost-aware routing
   */
  estimatedCostPer1MInputTokens?: number;

  /**
   * Estimated cost per 1M output tokens (in USD)
   */
  estimatedCostPer1MOutputTokens?: number;

  /**
   * Task types this model is particularly strong at
   */
  optimizedFor?: TaskType[];

  /**
   * Task types this model should avoid
   */
  avoidFor?: TaskType[];

}

/**
 * Context describing the current task and requirements
 * Used by the router to select the best model
 */
export interface ModelContext {
  /** Type of task being performed */
  taskType: TaskType;

  /** Estimated complexity of the task */
  estimatedComplexity: EstimatedComplexity;

  /** Whether the task will use tools/functions */
  expectsToolUse: boolean;

  /** How quickly the response is needed */
  latencySensitivity: LatencySensitivity;

  /** Budget constraints for this request */
  costSensitivity: CostSensitivity;

  /** What type of agent is making this decision */
  agentRole: AgentRole;

  /**
   * Estimated token count for the prompt
   * Used to determine if model's context window is sufficient
   */
  estimatedPromptTokens?: number;

  /**
   * Expected output token count
   * Used to ensure model can handle the output
   */
  estimatedOutputTokens?: number;

  /**
   * Preferred provider(s), in order of preference
   * If not specified, all providers are considered
   */
  preferredProviders?: Provider[];

  /**
   * Disable specific models by ID for this request
   * E.g., ["legacy-model", "too-expensive"]
   */
  excludeModels?: string[];

  /**
   * Force specific model by ID (overrides all routing logic)
   * Used for debugging or explicit model selection
   */
  forceModel?: string;

  /**
   * Request ID for tracing and logging
   */
  requestId?: string;
}

/**
 * Result of model selection
 * Includes the selected model and reasoning
 */
export interface ModelSelectionResult {
  /** The selected model configuration */
  selected: ModelConfig;

  /** Reason why this model was selected */
  reason: string;

  /** Score given to the selected model (0-100) */
  score: number;

  /** Alternative models that could work (in preference order) */
  alternatives: Array<{
    model: ModelConfig;
    score: number;
    reason: string;
  }>;

  /**
   * Gateway URL if using AI Gateway
   * Null if using direct Workers AI or external provider
   */
  gatewayUrl?: string;

  /**
   * Any warnings or notes about this selection
   * E.g., "Model may have high latency", "Cost may exceed budget"
   */
  warnings?: string[];

  /** Route class selected by app-level orchestration. */
  selectedRouteClass?: RouteClass;

  /** Dynamic AI Gateway model string sent as `model`. */
  dynamicRouteModel?: string;

  /** AI Gateway `/compat` base URL used for this selection. */
  gatewayBaseUrl?: string;
}

/**
 * Runtime bindings passed to resolveLanguageModel.
 *
 * Keeps the model resolver independent of the full Env type so
 * src/models/ does not import src/lib/env.ts (avoids circular deps).
 */
export interface ModelBindings {
  /** Optional AI Gateway access token (Cloudflare secret). */
  aiGatewayToken?: string;
  /**
   * JSON string for the `cf-aig-metadata` request header (AI Gateway custom metadata, max 5 keys).
   * Built by {@link buildModelBindingsForAiGateway} in `src/lib/agentObservability.ts`.
   */
  aiGatewayMetadataJson?: string;
}

/**
 * Configuration for AI Gateway integration
 */
export interface AIGatewayConfig {
  /** Base URL of AI Gateway instance */
  baseUrl: string;

  /** Optional: API token/auth for gateway */
  authToken?: string;

  /**
   * Optional: Default route prefix for models
   * E.g., "models/claude-3-5-sonnet" vs just "claude-3-5-sonnet"
   */
  routePrefix?: string;

  /**
   * Fallback model to use if primary selection fails
   * E.g., use cheaper model on gateway errors
   */
  fallbackModelId?: string;

  /**
   * Whether to enable gateway caching
   */
  enableCaching?: boolean;

  /**
   * Cache TTL in seconds
   */
  cacheTtlSeconds?: number;
}

/**
 * Configuration for the model router
 */
export interface RouterConfig {
  /** AI Gateway configuration */
  aiGateway?: AIGatewayConfig;

  /**
   * Central mapping from route class labels to AI Gateway dynamic route model strings.
   * Defaults are:
   *   utility   -> dynamic/agent-router (default)
   *   tools     -> dynamic/agent-router (default)
   *   reasoning -> dynamic/agent-router (default)
   *   vision    -> dynamic/agent-router (default)
   */
  routeClassModelMap?: Partial<Record<RouteClass, string>>;

  /**
   * Whether to allow fallback to cheaper models
   * when preferred model is unavailable
   */
  allowFallback?: boolean;

  /**
   * Multiply costs by this factor for scoring
   * Default: 1.0
   * >1.0: Penalizes expensive models more
   * <1.0: Allows expensive models more often
   */
  costWeightFactor?: number;

  /**
   * Multiply latency estimates by this factor for scoring
   * Default: 1.0
   */
  latencyWeightFactor?: number;

  /**
   * Log model selection decisions (useful for debugging)
   * @deprecated Prefer `obs` with level "debug" for structured logging.
   */
  enableDetailedLogging?: boolean;

  /**
   * Structured observability emitter. When provided, the router emits a
   * `model.selected` event after every call to `selectModel()`.
   * Import `createObservability` from `"../lib/observability"` to create one.
   */
  obs?: import("../lib/observability").Observability;
}

/**
 * Interface for custom model routers.
 * Implement this to override routing decisions per agent or per task.
 *
 * Sub-agents use createDelegatingRouter to wrap a base router and modify
 * context before forwarding — no need to re-implement this interface.
 */
export interface IModelRouter {
  /**
   * Select a model based on context
   */
  selectModel(context: ModelContext): Promise<ModelSelectionResult>;

  /**
   * Get the default model for this router
   */
  getDefaultModel(): ModelConfig;

  /**
   * Register a new model
   */
  registerModel(model: ModelConfig): void;

  /**
   * Get a model by ID
   */
  getModel(modelId: string): ModelConfig | undefined;

  /**
   * Get all registered models
   */
  getAllModels(): ModelConfig[];

  /**
   * Get models suitable for a specific task
   */
  getModelsForTask(taskType: TaskType): ModelConfig[];
}
