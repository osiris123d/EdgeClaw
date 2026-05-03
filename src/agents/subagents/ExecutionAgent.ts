/**
 * Execution Agent (Sub-agent)
 * Specialized for task execution, tool use, and state management
 */

import { Env } from "../../lib/env";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  createSpeedOptimizedRouter,
  ModelContext,
} from "../../models";
import { getRuntimeConfig } from "../../lib/env";
import type { Session } from "@cloudflare/think";
import {
  configureSession as applySessionConfiguration,
  type SessionConfigurationOptions,
} from "../../session/configureSession";
import { registerCustomTool } from "../../tools";
import type { AgentTurnContext } from "../agentTurnContext";
import { MainAgent, type MainAgentConfig } from "../MainAgent";

/**
 * Execution Agent
 * Optimized for reliable, fast task execution
 */
export class ExecutionAgent extends MainAgent {
  constructor(ctx: DurableObjectState, env: Env, config: MainAgentConfig = {}) {
    const runtime = getRuntimeConfig(env);
    const modelRouter = config.modelRouter ?? createSpeedOptimizedRouter({
      aiGateway: runtime.aiGatewayBaseUrl
        ? { baseUrl: runtime.aiGatewayBaseUrl, authToken: env.AI_GATEWAY_TOKEN, enableCaching: true, cacheTtlSeconds: 1800 }
        : undefined,
      enableDetailedLogging: runtime.environment !== "production",
    });

    super(ctx, env, { ...config, modelRouter });
  }

  /**
   * Execution-specific runtime routing hints.
   *
   * This keeps routing centralized by only shaping ModelContext; all scoring
   * and provider/model selection still happen inside ModelRouter.selectModel().
   */
  protected override getRoleModelContextOverrides(
    turn: AgentTurnContext
  ): Partial<ModelContext> {
    const text = (turn.message || "").toLowerCase();
    const structuredIntent = /\b(json|schema|structured|fields|format)\b/.test(text);

    return {
      agentRole: "execution",
      taskType: structuredIntent ? "tool_use" : "code",
      expectsToolUse: turn.likelyToolUsage ?? true,
      estimatedComplexity: turn.estimatedComplexity || "moderate",
      latencySensitivity: turn.latencySensitivity === "low" ? "high" : turn.latencySensitivity || "high",
      costSensitivity: turn.costSensitivity || "medium",
    };
  }

  /**
   * Override session configuration for execution context
   */
  override configureSession(session: Session): Session {
    const options: SessionConfigurationOptions = {
      soulPrompt:
        "You are an execution-focused agent optimized for reliable, fast task execution. " +
        "Execute instructions precisely. Use tools effectively. Report results clearly. " +
        "Handle errors gracefully and suggest fallbacks. Be deterministic and avoid unnecessary complexity.",
      memoryDescription: "Durable execution facts, decisions, and constraints to reuse in later turns.",
      memoryMaxTokens: 4500,
      additionalContexts: [
        {
          label: "execution_state",
          options: {
            description: "Current task status, progress, and state transitions",
            maxTokens: 3000,
          },
        },
        {
          label: "task_results",
          options: {
            description: "Results and artifacts from executed tasks and tool calls",
            maxTokens: 4000,
          },
        },
        {
          label: "error_log",
          options: {
            description: "Errors encountered and attempted recovery actions",
            maxTokens: 2000,
          },
        },
      ],
      compaction: {
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: 110_000,
      },
    };

    return applySessionConfiguration(session, options);
  }

  /**
   * Get execution-optimized tools
   */
  override getTools(): ToolSet {
    const baseTools = super.getTools();

    return {
      ...baseTools,
      ...registerCustomTool("execute_task", {
        description: "Execute a specific task with retry metadata.",
        inputSchema: z.object({
          task: z.string().min(1),
          retryCount: z.number().int().min(0).optional(),
        }),
        execute: async ({
          task,
          retryCount = 0,
        }: {
          task: string;
          retryCount?: number;
        }) => ({
          status: "executed",
          task,
          attempt: retryCount + 1,
        }),
      }),
      ...registerCustomTool("report_result", {
        description: "Report task execution result with optional metrics.",
        inputSchema: z.object({
          success: z.boolean(),
          details: z.string().min(1),
          metrics: z.record(z.string(), z.unknown()).optional(),
        }),
        execute: async ({
          success,
          details,
          metrics,
        }: {
          success: boolean;
          details: string;
          metrics?: Record<string, unknown>;
        }) => ({
          status: "reported",
          success,
          details,
          metrics,
        }),
      }),
      ...registerCustomTool("retry_on_failure", {
        description: "Retry a failed task with adjusted parameters.",
        inputSchema: z.object({
          task: z.string().min(1),
          adjustedParams: z.record(z.string(), z.unknown()),
        }),
        execute: async ({
          task,
          adjustedParams,
        }: {
          task: string;
          adjustedParams: Record<string, unknown>;
        }) => ({
          status: "retrying",
          task,
          params: adjustedParams,
        }),
      }),
      ...registerCustomTool("verify_completion", {
        description: "Verify that a task completed successfully.",
        inputSchema: z.object({
          task: z.string().min(1),
        }),
        execute: async ({ task }: { task: string }) => ({ status: "verified", task }),
      }),
    };
  }
}
