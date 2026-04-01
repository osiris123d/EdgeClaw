/**
 * dispatcher.ts
 * Routes incoming requests to appropriate specialized agents
 * Uses simple heuristics to classify intent
 * TODO: Replace with lightweight LLM classification if needed
 */

import { BaseAgent } from "./base-agent.js";
import {
  AgentContext,
  AgentResult,
  DispatcherDecision,
} from "../types.js";

export class DispatcherAgent extends BaseAgent {
  constructor(context: AgentContext) {
    super("dispatcher", context);
  }

  async execute(input: Record<string, unknown>): Promise<AgentResult> {
    try {
      this.validateInput(input, ["request"]);

      const { result: decision, executionTime } =
        await this.executeWithMetrics(async () => {
          const request = input.request as string;
          return this.classify(request);
        });

      this.log("info", "Dispatcher routing decision made", {
        targetAgent: decision.targetAgent,
        confidence: decision.confidence,
      });

      return {
        agentType: "dispatcher",
        status: "success",
        output: decision,
        executionTime,
      };
    } catch (error) {
      const err = this.createError(
        "DISPATCH_FAILED",
        error instanceof Error ? error.message : "Unknown dispatcher error"
      );
      return this.createErrorResult(err);
    }
  }

  /**
   * Classify request and return routing decision
   * In Phase 1, uses simple keyword matching.
   * Phase 3 can integrate lightweight LLM via AI Gateway.
   */
  private async classify(request: string): Promise<DispatcherDecision> {
    const lowerRequest = request.toLowerCase();

    // Simple heuristics for Phase 1
    // TODO: Replace with AI Gateway call if confidence < 0.7
    const patterns = {
      analyst: [
        /analyze|analyze|examine|inspect|audit|review|evaluate|assess/,
        /what is|understand|reason|investigate|figure out/,
      ],
      drafting: [
        /summarize|explain|write|create|generate|format|present|report/,
        /draft|compose|make|produce|prepare/,
      ],
      audit: [
        /check|verify|validate|confirm|approve|reject|review|risk/,
        /safe|valid|correct|accurate|compliant/,
      ],
    };

    let scores = {
      analyst: 0,
      drafting: 0,
      audit: 0,
    };

    // Score each agent type
    for (const [agentType, patternsArray] of Object.entries(patterns)) {
      for (const pattern of patternsArray) {
        if (pattern.test(lowerRequest)) {
          scores[agentType as keyof typeof scores] += 0.5;
        }
      }
    }

    // Normalize scores
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    if (totalScore > 0) {
      Object.keys(scores).forEach((key) => {
        scores[key as keyof typeof scores] /= totalScore;
      });
    }

    // Pick highest scoring agent, default to analyst
    let targetAgent: "analyst" | "drafting" | "audit" = "analyst";
    let maxScore = scores.analyst;

    if (scores.drafting > maxScore) {
      targetAgent = "drafting";
      maxScore = scores.drafting;
    }
    if (scores.audit > maxScore) {
      targetAgent = "audit";
      maxScore = scores.audit;
    }

    // If no clear match, default to analyst with lower confidence
    const confidence = totalScore > 0 ? maxScore : 0.4;

    return {
      targetAgent,
      confidence,
      context: {
        ...this.context,
        inputs: { request },
      },
      reason: `Classified as ${targetAgent} with ${(confidence * 100).toFixed(1)}% confidence`,
    };
  }
}
