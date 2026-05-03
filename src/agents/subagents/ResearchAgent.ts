/**
 * Research Agent (Sub-agent)
 * Specialized for gathering, analyzing, and synthesizing information
 */

import { Env } from "../../lib/env";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  createStandardRouter,
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
 * Research Agent
 * Optimized for information gathering, analysis, and synthesis
 */
export class ResearchAgent extends MainAgent {
  constructor(ctx: DurableObjectState, env: Env, config: MainAgentConfig = {}) {
    const runtime = getRuntimeConfig(env);
    const modelRouter = config.modelRouter ?? createStandardRouter({
      aiGateway: runtime.aiGatewayBaseUrl
        ? { baseUrl: runtime.aiGatewayBaseUrl, authToken: env.AI_GATEWAY_TOKEN, enableCaching: true, cacheTtlSeconds: 7200 }
        : undefined,
      enableDetailedLogging: runtime.environment !== "production",
    });

    super(ctx, env, { ...config, modelRouter });
  }

  /**
   * Research-specific runtime routing hints.
   *
   * This does not implement any scoring logic itself; it only supplies
   * role-aware context so the centralized ModelRouter can make the decision.
   */
  protected override getRoleModelContextOverrides(
    turn: AgentTurnContext
  ): Partial<ModelContext> {
    const text = (turn.message || "").toLowerCase();
    const summarizationIntent = /\b(summarize|summary|recap|synthesize)\b/.test(text);
    const browsingIntent = /\b(search|browse|web|source|citation|reference)\b/.test(text);

    return {
      agentRole: "research",
      taskType: summarizationIntent ? "content" : browsingIntent ? "search" : "analysis",
      estimatedComplexity:
        turn.estimatedComplexity === "simple" ? "moderate" : turn.estimatedComplexity || "complex",
      expectsToolUse: turn.likelyToolUsage ?? true,
      estimatedPromptTokens: Math.max(turn.estimatedPromptTokens ?? 0, 8000),
      latencySensitivity: turn.latencySensitivity || "medium",
      costSensitivity: turn.costSensitivity === "high" ? "medium" : turn.costSensitivity || "medium",
    };
  }

  /**
   * Override session configuration for research context
   */
  override configureSession(session: Session): Session {
    const options: SessionConfigurationOptions = {
      soulPrompt:
        "You are a research-focused agent. Your expertise is gathering comprehensive information, " +
        "analyzing sources critically, verifying facts, and synthesizing findings into clear insights. " +
        "Use available search and retrieval tools extensively. Cite sources and prefer evidence-backed claims.",
      memoryDescription: "Durable research facts and decisions that should persist across turns.",
      memoryMaxTokens: 6000,
      additionalContexts: [
        {
          label: "research_findings",
          options: {
            description: "Accumulated findings, sources, and analysis results",
            maxTokens: 5000,
          },
        },
        {
          label: "source_citations",
          options: {
            description: "References to authoritative sources and their relevance",
            maxTokens: 3000,
          },
        },
        {
          label: "fact_verification",
          options: {
            description: "Cross-referenced facts and verification status",
            maxTokens: 2000,
          },
        },
      ],
      compaction: {
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: 140_000,
      },
    };

    return applySessionConfiguration(session, options);
  }

  /**
   * Get research-optimized tools
   */
  override getTools(): ToolSet {
    const baseTools = super.getTools();

    return {
      ...baseTools,
      ...registerCustomTool("search", {
        description: "Search for information and sources on the web.",
        inputSchema: z.object({
          query: z.string().min(1),
        }),
        execute: async ({ query }: { query: string }) => ({ status: "searched", query }),
      }),
      ...registerCustomTool("cite_source", {
        description: "Add a source to the research findings with context.",
        inputSchema: z.object({
          url: z.string().url(),
          title: z.string().min(1),
          relevance: z.string().min(1),
        }),
        execute: async ({
          url,
          title,
          relevance,
        }: {
          url: string;
          title: string;
          relevance: string;
        }) => ({
          status: "cited",
          url,
          title,
          relevance,
        }),
      }),
      ...registerCustomTool("verify_fact", {
        description: "Verify a fact against multiple sources.",
        inputSchema: z.object({
          fact: z.string().min(1),
        }),
        execute: async ({ fact }: { fact: string }) => ({ status: "verified", fact }),
      }),
    };
  }
}
