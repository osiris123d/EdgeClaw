/**
 * types.ts
 * Shared TypeScript interfaces and types for the Cloudflare agent system
 */

/**
 * Represents a user request to be processed by the agent system
 */
export interface AgentRequest {
  id: string;
  type: "analyze" | "draft" | "audit" | "generic";
  userId: string;
  timestamp: number;
  context: Record<string, unknown>;
  data?: string | Record<string, unknown>;
  metadata?: RequestMetadata;
}

/**
 * Metadata attached to requests
 */
export interface RequestMetadata {
  source?: string;
  correlationId?: string;
  priority?: "low" | "normal" | "high";
  timeout?: number; // milliseconds
}

/**
 * Dispatcher routing decision
 */
export interface DispatcherDecision {
  targetAgent: "analyst" | "drafting" | "audit" | "dispatcher";
  confidence: number; // 0.0 - 1.0
  context: AgentContext;
  reason: string;
}

/**
 * Context passed through the agent pipeline
 */
export interface AgentContext {
  requestId: string;
  userId: string;
  agentChain: string[]; // Trail of agents that processed this
  metadata: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

/**
 * Result from an agent execution
 */
export interface AgentResult {
  agentType: string;
  status: "success" | "error" | "partial";
  output: unknown;
  executionTime: number;
  error?: AgentError;
  metadata?: Record<string, unknown>;
}

/**
 * Agent execution error
 */
export interface AgentError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Audit result from validation layer
 */
export interface AuditResult {
  approved: boolean;
  risks: RiskAssessment[];
  score: number; // 0.0 - 1.0
  feedback: string;
  timestamp: number;
}

/**
 * Risk assessment for audit outputs
 */
export interface RiskAssessment {
  level: "low" | "medium" | "high" | "critical";
  category: string;
  description: string;
  recommendation: string;
}

/**
 * Task state in Durable Objects
 */
export interface TaskState {
  taskId: string;
  requestId: string;
  userId: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  agentChain: string[];
  createdAt: number;
  updatedAt: number;
  result?: AgentResult;
  error?: AgentError;
}

/**
 * Work log entry for R2 persistence
 */
export interface WorkLogEntry {
  id: string;
  taskId: string;
  requestId: string;
  timestamp: number;
  agent: string;
  action: string;
  result: unknown;
  error?: AgentError;
  executionTimeMs: number;
}

/**
 * AI Gateway request
 */
export interface AIGatewayRequest {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * AI Gateway response
 */
export interface AIGatewayResponse {
  result: {
    response: string;
    finish_reason: string;
  };
}

/**
 * Configuration for environment
 */
export interface AgentConfig {
  environment: "development" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  aiGateway: {
    accountId: string;
    authToken: string;
    smallModelRoute: string;
    largeModelRoute: string;
    fallbackRoute: string;
  };
  r2: {
    artifactsBucket: string;
    memoryBucket: string;
  };
  durable: {
    taskCoordinatorId: string;
    workLogId: string;
  };
  limits: {
    maxConcurrentTasks: number;
    maxExecutionTimeMs: number;
    maxRetries: number;
  };
}

/**
 * Workflow task definition
 */
export interface WorkflowTask {
  id: string;
  name: string;
  steps: WorkflowStep[];
  state: Record<string, unknown>;
}

/**
 * Individual workflow step
 */
export interface WorkflowStep {
  id: string;
  type: "agent" | "wait" | "branch" | "merge";
  agentType?: string;
  params?: Record<string, unknown>;
  timeout?: number;
}
