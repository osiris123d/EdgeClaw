/**
 * Comprehensive model orchestration exports
 * Public API for flexible model selection and routing
 */

// Type exports
export type {
  ModelConfig,
  ModelContext,
  ModelSelectionResult,
  ModelBindings,
  IModelRouter,
  RouterConfig,
  AIGatewayConfig,
} from "./types";

export type {
  Provider,
  RouteClass,
  CostTier,
  TaskType,
  EstimatedComplexity,
  LatencySensitivity,
  CostSensitivity,
  AgentRole,
} from "./types";

// Router exports
export { ModelRouter } from "./router";

export {
  createStandardRouter,
  createResearchRouter,
  createCostOptimizedRouter,
  createSpeedOptimizedRouter,
  createDelegatingRouter,
  // AI SDK resolver — converts ModelSelectionResult → LanguageModel
  resolveLanguageModel,
} from "./router";

// Re-export LanguageModel type so callers don't need a direct "ai" import
export type { LanguageModel } from "ai";
