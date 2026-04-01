/**
 * analyst.ts
 * Analyzes incoming data and produces insights/recommendations
 * Calls out to AI Gateway for LLM reasoning
 */

import { BaseAgent } from "./base-agent.js";
import { AgentContext, AgentResult, AIGatewayRequest, AIGatewayResponse } from "../types.js";

export class AnalystAgent extends BaseAgent {
  private accountId: string;
  private authToken: string;
  private modelRoute: string;

  constructor(
    context: AgentContext,
    accountId: string,
    authToken: string,
    modelRoute: string
  ) {
    super("analyst", context);
    this.accountId = accountId;
    this.authToken = authToken;
    this.modelRoute = modelRoute;
  }

  async execute(input: Record<string, unknown>): Promise<AgentResult> {
    try {
      this.validateInput(input, ["data"]);

      const { result: analysis, executionTime } =
        await this.executeWithMetrics(async () => {
          const data = input.data as string | Record<string, unknown>;
          return this.analyze(data);
        });

      this.updateContext({ outputs: { analysis } });
      this.log("info", "Analysis complete", { analysisLength: JSON.stringify(analysis).length });

      return this.createSuccessResult(analysis);
    } catch (error) {
      const err = this.createError(
        "ANALYSIS_FAILED",
        error instanceof Error ? error.message : "Unknown analyst error"
      );
      return this.createErrorResult(err);
    }
  }

  /**
   * Call AI Gateway to analyze data
   */
  private async analyze(data: string | Record<string, unknown>): Promise<unknown> {
    const dataString = typeof data === "string" ? data : JSON.stringify(data);

    const prompt = `You are an enterprise analyst assistant.
    
Analyze the following data and provide:
1. Key findings
2. Patterns or trends
3. Recommendations for action
4. Any risks or concerns

Data to analyze:
${dataString}

Respond in structured JSON format with keys: findings, patterns, recommendations, risks`;

    const gatewayRequest: AIGatewayRequest = {
      messages: [
        {
          role: "system",
          content:
            "You are a professional analyst. Provide thorough, structured analysis.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      maxTokens: 2000,
    };

    try {
      const response = await this.callAIGateway(gatewayRequest);
      this.log("info", "AI Gateway analysis received");

      // Parse response
      // TODO: Handle response format variations from different models
      const analysisText = response.result.response;
      try {
        // Attempt to extract JSON from response
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // If JSON parsing fails, return as string
        this.log("warn", "Could not parse JSON from AI response, returning as text");
      }

      return {
        findings: analysisText,
        patterns: [],
        recommendations: [],
        risks: [],
      };
    } catch (error) {
      this.log("error", "AI Gateway call failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Call Cloudflare AI Gateway
   */
  private async callAIGateway(request: AIGatewayRequest): Promise<AIGatewayResponse> {
    // TODO: Implement actual AI Gateway call
    // For now, return a mock response for testing
    // Real implementation:
    // const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai-gateway/${this.modelRoute}`;
    // const response = await fetch(url, {
    //   method: 'POST',
    //   headers: { 'Authorization': `Bearer ${this.authToken}` },
    //   body: JSON.stringify(request)
    // });

    this.log("debug", "Calling AI Gateway", { route: this.modelRoute });

    // Mock response for Phase 1
    return {
      result: {
        response: `Analysis of provided data shows interesting patterns. Key findings: data appears well-structured. Recommendations: continue monitoring. Risks: none detected.`,
        finish_reason: "stop",
      },
    };
  }
}
