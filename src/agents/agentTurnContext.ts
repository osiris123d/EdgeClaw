import type {
  CostSensitivity,
  EstimatedComplexity,
  LatencySensitivity,
  TaskType,
} from "../models";
import type { EdgeClawGatewayAgentName } from "../lib/agentObservability";

/**
 * Optional ids merged into AI Gateway `cf-aig-metadata` (max 5 keys on the wire;
 * `sessionId` is intentionally omitted from Gateway metadata).
 */
export interface AgentTurnAiGatewayObservability {
  agent?: EdgeClawGatewayAgentName;
  projectId?: string;
  taskId?: string;
  runId?: string;
}

/**
 * Runtime hints for per-turn model selection (Think + ModelRouter).
 * Shared by {@link MainAgent} and {@link BaseSubAgentThink}.
 */
export interface AgentTurnContext {
  message?: string;
  taskType?: TaskType;
  estimatedComplexity?: EstimatedComplexity;
  latencySensitivity?: LatencySensitivity;
  costSensitivity?: CostSensitivity;
  likelyToolUsage?: boolean;
  estimatedPromptTokens?: number;
  estimatedOutputTokens?: number;
  /** Merged into `cf-aig-metadata` for ai-gateway model fetches on this turn. */
  aiGatewayObservability?: AgentTurnAiGatewayObservability;
}
