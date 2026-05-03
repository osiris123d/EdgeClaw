/**
 * Model Orchestration Examples
 * Demonstrates flexible model selection for different scenarios
 */

import { Env } from "../lib/env";
import {
  createStandardRouter,
  createCostOptimizedRouter,
  createSpeedOptimizedRouter,
} from "../models";
import { MainAgent, MainAgentConfig } from "../agents/MainAgent";
import { ResearchAgent } from "../agents/subagents/ResearchAgent";
import { ExecutionAgent } from "../agents/subagents/ExecutionAgent";

/**
 * EXAMPLE 1: Basic model selection with default router
 *
 * The simplest way to use flexible model selection:
 * Create an agent and let it choose models based on task context
 */
export async function example_basicModelSelection(env: Env) {
  const agent = new MainAgent(env);

  // Select a model for a research task
  const researchSelection = await agent.selectModel({
    taskType: "analysis",
    estimatedComplexity: "complex",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "low", // Don't mind spending more for quality
    agentRole: "general",
  });

  console.log(`Selected: ${researchSelection.selected.name}`);
  console.log(`Reason: ${researchSelection.reason}`);
  console.log(`Score: ${researchSelection.score}`);

  // Select a model for a quick, cost-sensitive task
  const quickSelection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "simple",
    expectsToolUse: false,
    latencySensitivity: "high", // Need fast response
    costSensitivity: "high", // Watch the budget
    agentRole: "general",
  });

  console.log(`Quick task model: ${quickSelection.selected.name}`);
}

/**
 * EXAMPLE 2: Using specialized agent routers
 *
 * Sub-agents (ResearchAgent, ExecutionAgent) automatically wrap
 * their routing to optimize for their specialty
 */
export async function example_specializedAgents(env: Env) {
  // Research agent automatically selects powerful models
  const researchAgent = new ResearchAgent(env);
  const researchSelection = await researchAgent.selectModel({
    taskType: "analysis", // Any task type...
    estimatedComplexity: "moderate",
    expectsToolUse: true,
    latencySensitivity: "low",
    costSensitivity: "low",
    agentRole: "research",
  });
  console.log(
    `Research agent picks: ${researchSelection.selected.name} (optimized for depth)`
  );

  // Execution agent automatically selects fast models
  const executionAgent = new ExecutionAgent(env);
  const executionSelection = await executionAgent.selectModel({
    taskType: "tool_use",
    estimatedComplexity: "simple",
    expectsToolUse: true,
    latencySensitivity: "high",
    costSensitivity: "medium",
    agentRole: "execution",
  });
  console.log(
    `Execution agent picks: ${executionSelection.selected.name} (optimized for speed)`
  );
}

/**
 * EXAMPLE 3: Custom router for specific requirements
 *
 * Create a custom router that only uses cost-optimized models
 * Useful for budget-constrained deployments
 */
export async function example_customRouter(env: Env) {
  const costOptimizedRouter = createCostOptimizedRouter({
    aiGateway: env.Variables?.AI_GATEWAY_URL
      ? {
          baseUrl: env.Variables.AI_GATEWAY_URL,
          enableCaching: true,
        }
      : undefined,
    enableDetailedLogging: true,
  });

  // Create agent with custom router
  const config: MainAgentConfig = {
    modelRouter: costOptimizedRouter,
  };
  const agent = new MainAgent(env, config);

  const selection = await agent.selectModel({
    taskType: "content",
    estimatedComplexity: "moderate",
    expectsToolUse: false,
    latencySensitivity: "low",
    costSensitivity: "high", // Strongly prefer cheap option
    agentRole: "creative",
  });

  console.log(`Cost-optimized choice: ${selection.selected.name}`);
  console.log(`Cost tier: ${selection.selected.costTier}`);
}

/**
 * EXAMPLE 4: Speed-optimized router
 *
 * For applications where latency is critical
 */
export async function example_speedOptimized(env: Env) {
  const speedRouter = createSpeedOptimizedRouter({
    aiGateway: env.Variables?.AI_GATEWAY_URL
      ? {
          baseUrl: env.Variables.AI_GATEWAY_URL,
        }
      : undefined,
  });

  const agent = new MainAgent(env, { modelRouter: speedRouter });

  const selection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "simple",
    expectsToolUse: false,
    latencySensitivity: "critical", // <500ms needed
    costSensitivity: "low", // Cost doesn't matter
    agentRole: "general",
  });

  console.log(`Speed-optimized: ${selection.selected.name}`);
  console.log(
    `Expected p95 latency: ${selection.selected.estimatedLatencyMs?.p95}ms`
  );
}

/**
 * EXAMPLE 5: Registering custom models
 *
 * Add your own models to the router (e.g., fine-tuned models)
 */
export async function example_customModels(env: Env) {
  const router = createStandardRouter();

  // Register a custom model
  router.registerModel({
    id: "my-finetuned-model",
    name: "My Fine-Tuned Claude",
    provider: "ai-gateway",
    modelId: "my-account/finetuned-claude-v1",
    costTier: "premium",
    capabilities: {
      reasoning: true,
      toolUse: true,
      longContext: true,
      functionCalling: true,
      coding: true,
    },
    contextWindow: 100000,
    maxOutputTokens: 4096,
    optimizedFor: ["code", "reasoning"],
    estimatedLatencyMs: { p50: 1000, p95: 2000, p99: 3000 },
    estimatedCostPer1MInputTokens: 5,
    estimatedCostPer1MOutputTokens: 20,
  });

  const agent = new MainAgent(env, { modelRouter: router });

  const selection = await agent.selectModel({
    taskType: "code",
    estimatedComplexity: "expert",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "low",
    agentRole: "code",
  });

  console.log(`Selected custom model: ${selection.selected.name}`);
}

/**
 * EXAMPLE 6: Forcing a specific model
 *
 * Override routing decisions by forcing a specific model
 * Useful for debugging or A/B testing
 */
export async function example_forceModel(env: Env) {
  const agent = new MainAgent(env);

  // Force use of a specific model regardless of context
  const selection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "simple",
    expectsToolUse: false,
    latencySensitivity: "low",
    costSensitivity: "high",
    agentRole: "general",
    forceModel: "claude-opus", // Always use this model
  });

  console.log(`Forced model: ${selection.selected.name}`);
  console.log(`Reason: ${selection.reason}`);
}

/**
 * EXAMPLE 7: Excluding models
 *
 * Prevent certain models from being selected
 * Useful for excluding deprecated or problematic models
 */
export async function example_excludeModels(env: Env) {
  const agent = new MainAgent(env);

  const selection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "moderate",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "medium",
    agentRole: "general",
    excludeModels: ["claude-haiku"], // Don't use this model
  });

  console.log(`Selected (excluding haiku): ${selection.selected.name}`);
}

/**
 * EXAMPLE 8: Provider preferences
 *
 * Route through specific providers in order of preference
 */
export async function example_providerPreference(env: Env) {
  const agent = new MainAgent(env);

  // Prefer Workers AI, fall back to AI Gateway
  const selection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "moderate",
    expectsToolUse: false,
    latencySensitivity: "medium",
    costSensitivity: "medium",
    agentRole: "general",
    preferredProviders: ["workers-ai", "ai-gateway"],
  });

  console.log(`Selected from ${selection.selected.provider}: ${selection.selected.name}`);
  if (selection.gatewayUrl) {
    console.log(`Gateway URL: ${selection.gatewayUrl}`);
  }
}

/**
 * EXAMPLE 9: Examining alternatives
 *
 * Get multiple model options instead of just the top choice
 */
export async function example_alternatives(env: Env) {
  const agent = new MainAgent(env);

  const selection = await agent.selectModel({
    taskType: "reasoning",
    estimatedComplexity: "complex",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "low",
    agentRole: "general",
  });

  console.log(`Primary: ${selection.selected.name} (score: ${selection.score})`);
  console.log("Alternatives:");
  for (const alt of selection.alternatives) {
    console.log(`  - ${alt.model.name} (score: ${alt.score}): ${alt.reason}`);
  }

  // Check for warnings
  if (selection.warnings?.length) {
    console.log("Warnings:");
    for (const warning of selection.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

/**
 * EXAMPLE 10: Get all available models
 *
 * List all models the router knows about
 */
export async function example_listModels(env: Env) {
  const agent = new MainAgent(env);
  const router = agent.getModelRouter();

  const allModels = router.getAllModels();
  console.log(`Available models (${allModels.length}):`);

  for (const model of allModels) {
    const capabilities = Object.entries(model.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");

    console.log(
      `  ${model.name}: ${model.costTier} (context: ${model.contextWindow}, capabilities: ${capabilities})`
    );
  }

  // Get models optimized for specific task
  const codingModels = router.getModelsForTask("code");
  console.log(`Models optimized for coding (${codingModels.length}):`);
  for (const model of codingModels) {
    console.log(`  - ${model.name}`);
  }
}

/**
 * EXAMPLE 11: Request tracking
 *
 * Use request IDs for tracing and debugging
 */
export async function example_requestTracking(env: Env) {
  const agent = new MainAgent(env);

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const selection = await agent.selectModel({
    taskType: "general",
    estimatedComplexity: "moderate",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "medium",
    agentRole: "general",
    requestId, // Include for logging/tracing
  });

  console.log(`Request ${requestId}: Selected ${selection.selected.name}`);
}

/**
 * EXAMPLE 12: Dynamic model switching based on complexity
 *
 * Adjust model selection based on runtime analysis
 */
export async function example_dynamicSwitch(env: Env) {
  const agent = new MainAgent(env);

  // First, try with moderate complexity
  let selection = await agent.selectModel({
    taskType: "reasoning",
    estimatedComplexity: "moderate",
    expectsToolUse: true,
    latencySensitivity: "medium",
    costSensitivity: "medium",
    agentRole: "general",
  });

  console.log(`Initial selection: ${selection.selected.name}`);

  // If task turns out to be complex, upgrade
  if (selection.selected.id === "claude-sonnet") {
    selection = await agent.selectModel({
      taskType: "reasoning",
      estimatedComplexity: "complex", // Upgrade
      expectsToolUse: true,
      latencySensitivity: "medium",
      costSensitivity: "low", // Less cost-sensitive for important task
      agentRole: "general",
    });

    console.log(`Upgraded to: ${selection.selected.name}`);
  }
}

/**
 * EXAMPLE 13: Context window validation
 *
 * Ensure selected model has enough context for the task
 */
export async function example_contextWindow(env: Env) {
  const agent = new MainAgent(env);

  // Task with large prompt
  const estimatedPromptTokens = 50000;
  const estimatedOutputTokens = 10000;

  const selection = await agent.selectModel({
    taskType: "analysis",
    estimatedComplexity: "complex",
    expectsToolUse: true,
    latencySensitivity: "low",
    costSensitivity: "low",
    agentRole: "general",
    estimatedPromptTokens,
    estimatedOutputTokens,
  });

  const totalTokens = estimatedPromptTokens + estimatedOutputTokens;
  console.log(`Task needs ${totalTokens} tokens`);
  console.log(
    `Selected model context window: ${selection.selected.contextWindow}`
  );
  console.log(
    `Fits: ${totalTokens <= selection.selected.contextWindow ? "✓" : "✗"}`
  );
}
