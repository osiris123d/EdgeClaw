# Model Orchestration Layer
## Flexible, Provider-Agnostic Model Selection for Cloudflare Think Agents

## Overview

The model orchestration layer provides intelligent, context-aware model selection across multiple providers and model types. It enables:

- **Dynamic model selection** based on task requirements
- **Provider abstraction** (Workers AI, AI Gateway, or custom providers)
- **Scoring algorithm** that considers capabilities, cost, latency, and task fit
- **Fallback mechanisms** for robustness
- **Extensibility** for custom models and routers

## Architecture

### Three Core Components

#### 1. **ModelConfig** (types.ts)
Describes a single model's capabilities and metadata:

```typescript
interface ModelConfig {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  provider: Provider;            // Where it comes from
  modelId: string;              // Provider-specific ID
  costTier: CostTier;          // Pricing category
  capabilities: {
    reasoning: boolean;
    toolUse: boolean;
    longContext: boolean;
    functionCalling: boolean;
    vision?: boolean;
    coding?: boolean;
  };
  contextWindow: number;
  maxOutputTokens: number;
  // ... latency, cost, optimization metadata
}
```

#### 2. **ModelContext** (types.ts)
Describes the current task requirements:

```typescript
interface ModelContext {
  taskType: TaskType;                    // "reasoning" | "code" | "content" | ...
  estimatedComplexity: EstimatedComplexity;  // "simple" | "moderate" | "complex" | "expert"
  expectsToolUse: boolean;
  latencySensitivity: LatencySensitivity;
  costSensitivity: CostSensitivity;
  agentRole: AgentRole;                 // "general" | "research" | "execution" | ...
  // ... optional overrides and constraints
}
```

#### 3. **ModelRouter** (router.ts)
Makes intelligent routing decisions:

```typescript
class ModelRouter implements IModelRouter {
  async selectModel(context: ModelContext): Promise<ModelSelectionResult>;
  registerModel(model: ModelConfig): void;
  getModel(modelId: string): ModelConfig | undefined;
  getAllModels(): ModelConfig[];
  getModelsForTask(taskType: TaskType): ModelConfig[];
}
```

## Routing Decision Process

The router uses a multi-stage evaluation:

### Stage 1: Force/Override Checks
- If `forceModel` specified, use that immediately
- Check for excluded models
- Verify deprecated status (avoid unless forced)

### Stage 2: Capability Filtering
Filter by requirements:
- **Provider preferences** — only consider preferred providers
- **Tool use** — must support tools if `expectsToolUse === true`
- **Context window** — must accommodate `estimatedPromptTokens + estimatedOutputTokens`
- **Long context** — if `estimatedPromptTokens > 16k` and not explicitly long-context capable, exclude

### Stage 3: Scoring (0-100)
Score remaining models on:

| Factor | Weight | Notes |
|--------|--------|-------|
| Task Optimization | +20 | Bonus if model is `optimizedFor` this task type |
| Capabilities Match | +10 | Bonus for tool use + function calling |
| Long Context | +15 | Bonus if task needs long context and model supports it |
| Complexity Match | +0/+5/+10/+15 | Higher bonus for complex tasks if model has strong reasoning |
| Latency Fit | ±5 to ±15 | Penalty/bonus based on `latencySensitivity` |
| Cost Fit | ±5 to ±20 | Penalty for expensive models if `costSensitivity === "high"` |

**Example scoring:**

```
Claude Opus (complex reasoning task):
  Base: 50
  + Task optimization (reasoning): 20
  + Capabilities (tools + functions): 10
  + Long context capability: 15
  + Complexity match (expert): 15
  = Score: 110 → Clamped to 100

Claude Haiku (quick, cheap task):
  Base: 50
  + Fast response (latency-sensitive): 10
  + Cost match (high cost-sensitivity): 15
  = Score: 75
```

### Stage 4: Selection
- Select highest-scoring model
- Include top 3 alternatives with reasoning
- Add gateway URL if using AI Gateway
- Add warnings if applicable

## Integration Points

### AI Gateway

When using AI Gateway, the router:
1. Reads `AIGatewayConfig` from environment
2. Constructs gateway URLs using model's `modelId` or `gatewayRoute`
3. Includes optional authentication headers
4. Enables caching with configurable TTL

**Example:**

```typescript
const config = {
  aiGateway: {
    baseUrl: "https://gateway.ai.cloudflare.com/account/YOUR_ID/gateway/YOUR_SLUG",
    enableCaching: true,
    cacheTtlSeconds: 3600
  }
};

const router = new ModelRouter(config);
// Router now returns gateway URLs in selection results
```

### Workers AI (Direct)

For direct Workers AI binding:
1. Router still tracks models (for scoring and context)
2. `gatewayUrl` is undefined in results
3. Application uses `env.AI` binding directly
4. Model selection is still valuable for deciding _which_ model to use

### Custom Providers

To support custom providers:
1. Register models with `provider: "external"`
2. Application implements provider-specific handler
3. Router provides selection logic, not execution

## Usage Patterns

### Pattern 1: Simple Default Selection
```typescript
const agent = new MainAgent(env);
const selection = await agent.selectModel({
  taskType: "general",
  estimatedComplexity: "moderate",
  expectsToolUse: false,
  latencySensitivity: "medium",
  costSensitivity: "medium",
  agentRole: "general"
});
```

### Pattern 2: Task-Specific Selection
```typescript
// Logic can change model choice based on task analysis
const selection = await agent.selectModel({
  taskType: userInput.taskType,
  estimatedComplexity: analyzeComplexity(userInput.prompt),
  expectsToolUse: userInput.tools.length > 0,
  latencySensitivity: userInput.interactive ? "high" : "low",
  costSensitivity: userInput.budget ? "high" : "low",
  agentRole: agent.type
});
```

### Pattern 3: Sub-Agent Specialization
```typescript
// ResearchAgent wraps base router to increase complexity/quality
export class ResearchAgent extends MainAgent {
  async selectModel(context: ModelContext) {
    return baseRouter.selectModel({
      ...context,
      estimatedComplexity: max(context.estimatedComplexity, "moderate"),
      expectsToolUse: true,
      costSensitivity: "low" // Prioritize quality
    });
  }
}

// ExecutionAgent wraps to prioritize speed
export class ExecutionAgent extends MainAgent {
  async selectModel(context: ModelContext) {
    return baseRouter.selectModel({
      ...context,
      latencySensitivity: "high",
      costSensitivity: isProductionCost ? "high" : "medium"
    });
  }
}
```

### Pattern 4: Custom Router
```typescript
// Create specialized router for unique requirements
const customRouter = new ModelRouter({
  costWeightFactor: 2.0,    // Heavily penalize expensive models
  latencyWeightFactor: 1.0,
  enableDetailedLogging: true
});

customRouter.registerModel(customFineTunedModel);

const agent = new MainAgent(env, { modelRouter: customRouter });
```

## Built-In Router Factories

### `createStandardRouter(config)`
General-purpose router with Claude models (Opus, Sonnet, Haiku).
- Good default weights
- Balanced for most tasks

### `createResearchRouter(config)`
Optimized for research and analysis.
- `costWeightFactor: 0.5` (allow expensive models)
- Prefers Opus for deep reasoning

### `createCostOptimizedRouter(config)`
Budget-conscious routing.
- `costWeightFactor: 2.0` (heavily penalize expense)
- Strongly prefers Haiku and Sonnet

### `createSpeedOptimizedRouter(config)`
Latency-critical applications.
- `latencyWeightFactor: 2.0` (heavily prefer fast models)
- Minimizes p95/p99 latency

## Configuration Options

### RouterConfig

```typescript
interface RouterConfig {
  aiGateway?: AIGatewayConfig;
  allowFallback?: boolean;
  costWeightFactor?: number;      // Default: 1.0
  latencyWeightFactor?: number;    // Default: 1.0
  enableDetailedLogging?: boolean;
}
```

### AIGatewayConfig

```typescript
interface AIGatewayConfig {
  baseUrl: string;                // Gateway endpoint
  authToken?: string;             // Optional auth
  routePrefix?: string;           // Path prefix if needed
  fallbackModelId?: string;       // Fallback on error
  enableCaching?: boolean;
  cacheTtlSeconds?: number;
}
```

## Extending the Layer

### Adding a New Model

```typescript
const router = new ModelRouter(config);

router.registerModel({
  id: "llama-70b",
  name: "Llama 2 70B",
  provider: "ai-gateway",
  modelId: "llama-2-70b-chat",
  costTier: "standard",
  capabilities: {
    reasoning: true,
    toolUse: false,
    longContext: true,
    functionCalling: false,
  },
  contextWindow: 4096,
  maxOutputTokens: 2048,
  optimizedFor: ["code", "reasoning"],
  estimatedLatencyMs: { p50: 1500, p95: 3000, p99: 5000 },
  estimatedCostPer1MInputTokens: 0.5,
  estimatedCostPer1MOutputTokens: 1.5,
});
```

### Creating a Custom Router

```typescript
class BudgetRouter extends ModelRouter {
  async selectModel(context: ModelContext): Promise<ModelSelectionResult> {
    // Custom logic: only consider models under budget
    const budgetPerRequest = 0.01; // $0.01 max
    
    // Score models by cost only
    // ...
    
    return super.selectModel({
      ...context,
      costSensitivity: "high"
    });
  }
}
```

### Per-Agent Router Override

```typescript
class CustomAgent extends MainAgent {
  constructor(env: Env, config: MainAgentConfig) {
    const specialRouter = createCostOptimizedRouter();
    super(env, {
      ...config,
      modelRouter: specialRouter
    });
  }
}
```

## Selection Result

The `ModelSelectionResult` includes:

```typescript
interface ModelSelectionResult {
  selected: ModelConfig;           // Chosen model
  reason: string;                  // Why this model
  score: number;                   // Numerical score (0-100)
  alternatives: Array<{            // Top 3 alternatives
    model: ModelConfig;
    score: number;
    reason: string;
  }>;
  gatewayUrl?: string;            // Gateway URL if applicable
  warnings?: string[];            // Any concerns
}
```

## Best Practices

1. **Provide good context** — The more detailed the `ModelContext`, the better the decision
2. **Consider token counts** — When possible, estimate tokens to avoid context window issues
3. **Set agent roles** — Helps router understand agent capabilities and needs
4. **Use provider preferences** — If you have a preferred provider, specify it
5. **Monitor alternatives** — Check `alternatives` to understand other valid options
6. **Handle warnings** — Pay attention to warnings about cost, latency, or capability concerns
7. **Test with different weights** — Adjust router factors to match your requirements
8. **Track selection metrics** — Log which models are selected for analysis and optimization

## Architecture Decisions

### Why Sub-Agent Routers Wrap?
Instead of modifying the base router, sub-agents wrap it to:
- Preserve original router for reuse
- Enable composition and chaining
- Allow runtime router changes
- Support sub-agent-specific optimizations

### Why Scoring vs Rule-Based?
Scoring enables:
- Nuanced tradeoffs between factors
- Graceful degradation (avoids hard failure states)
- Consistent "best effort" decisions
- Easy tuning via weight factors

### Why Async selectModel?
Asynchronous design allows future:
- Network calls for model availability
- Dynamic cost lookups
- External policy checks
- Real-time latency monitoring

### Why Multiple Provider Types?
Multi-provider support enables:
- Vendor independence
- Cost optimization (switch providers)
- Fallback strategies
- Future support for new providers

## Limitations & Future Work

### Current Limitations
- Scoring weights are static (not ML-based)
- No real-time latency monitoring
- No automatic fallback on model unavailability
- No cost budgeting across user/account

### Planned Improvements
- Dynamic weight learning from selection outcomes
- Real-time latency data from gateway
- Automatic fallback via gateway circuit breakers
- Fine-grained cost tracking and budgeting
- A/B testing framework for model evaluation

## Related Documentation

- [MainAgent](../agents/README.md) — Agent base class
- [Sub-agents](../agents/subagents/README.md) — Research and Execution agents
- [Tool Approval](../tools/approval.ts) — Tool execution policies
- [Session Configuration](../session/README.md) — Memory and context setup
