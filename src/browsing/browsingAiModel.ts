/**
 * AI Gateway model selection for Agent Browsing (EdgeclawBrowsingAgent).
 * Uses the same dynamic route map as the main app router (`dynamic/agent-router` by default).
 */
import { getRuntimeConfig } from "../lib/env";
import type { Env } from "../lib/env";
import type { ModelConfig, ModelSelectionResult, RouteClass } from "../models/types";
import { getDefaultRouteClassModelMap } from "../models/router";

const BROWSING_ROUTE_CLASS: RouteClass = "tools";

/**
 * Builds a {@link ModelSelectionResult} for `resolveLanguageModel` so browsing
 * hits the gateway `agent-router` pipeline with `metadata.agent: BrowserAgent`.
 */
export function buildBrowsingGatewayModelSelection(env: Env): ModelSelectionResult {
  const rt = getRuntimeConfig(env);
  const routeMap = getDefaultRouteClassModelMap();
  const modelId = routeMap[BROWSING_ROUTE_CLASS];

  const selected: ModelConfig = {
    id: "browsing-gateway-tools",
    name: "AI Gateway agent-router (browsing)",
    provider: "ai-gateway",
    routeClass: BROWSING_ROUTE_CLASS,
    modelId,
    costTier: "premium",
    capabilities: {
      reasoning: true,
      toolUse: true,
      longContext: true,
      functionCalling: true,
      coding: true,
    },
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    optimizedFor: ["tool_use", "code", "analysis"],
  };

  return {
    selected,
    reason: "Agent Browsing — AI Gateway dynamic route (tools / agent-router)",
    score: 100,
    alternatives: [],
    selectedRouteClass: BROWSING_ROUTE_CLASS,
    dynamicRouteModel: modelId,
    gatewayBaseUrl: rt.aiGatewayBaseUrl,
  };
}
