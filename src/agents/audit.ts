/**
 * audit.ts
 * Validates outputs from other agents for accuracy, safety, and compliance
 * OpenClaw-inspired validation layer to prevent invalid state propagation
 */

import { BaseAgent } from "./base-agent.js";
import { AgentContext, AgentResult, AuditResult, RiskAssessment } from "../types.js";

export class AuditAgent extends BaseAgent {
  constructor(context: AgentContext) {
    super("audit", context);
  }

  async execute(input: Record<string, unknown>): Promise<AgentResult> {
    try {
      this.validateInput(input, ["content"]);

      const { result: auditResult, executionTime } =
        await this.executeWithMetrics(async () => {
          const content = input.content;
          const contentType = (input.contentType as string) || "unknown";
          return this.validate(content, contentType);
        });

      this.updateContext({ outputs: { audit: auditResult } });
      this.log("info", "Audit validation complete", {
        approved: auditResult.approved,
        riskCount: auditResult.risks.length,
      });

      return this.createSuccessResult(auditResult);
    } catch (error) {
      const err = this.createError(
        "AUDIT_FAILED",
        error instanceof Error ? error.message : "Unknown audit error"
      );
      return this.createErrorResult(err);
    }
  }

  /**
   * Validate content across multiple dimensions
   */
  private async validate(content: unknown, contentType: string): Promise<AuditResult> {
    const risks: RiskAssessment[] = [];
    let score = 1.0; // Start at 100%, deduct for issues

    // Content existence check
    if (!content) {
      risks.push({
        level: "high",
        category: "completeness",
        description: "Content is empty or null",
        recommendation: "Ensure content is properly generated before audit",
      });
      score -= 0.3;
    }

    // Type-specific validations
    const contentStr =
      typeof content === "string" ? content : JSON.stringify(content);

    // Check for minimal length
    if (contentStr.length < 10) {
      risks.push({
        level: "medium",
        category: "completeness",
        description: "Content appears truncated or too brief",
        recommendation: "Verify content generation completed successfully",
      });
      score -= 0.15;
    }

    // Check for suspicious patterns
    risks.push(
      ...(await this.checkForRisks(contentStr))
    );

    // Deduct based on risks found
    risks.forEach((risk) => {
      switch (risk.level) {
        case "critical":
          score -= 0.5;
          break;
        case "high":
          score -= 0.2;
          break;
        case "medium":
          score -= 0.1;
          break;
        case "low":
          score -= 0.05;
          break;
      }
    });

    // Ensure score stays in valid range
    score = Math.max(0, Math.min(1, score));

    const approved = score >= 0.6 && !risks.some((r) => r.level === "critical");

    return {
      approved,
      risks,
      score,
      feedback: this.generateFeedback(approved, risks.length, score),
      timestamp: Date.now(),
    };
  }

  /**
   * Check for common risk patterns
   */
  private async checkForRisks(content: string): Promise<RiskAssessment[]> {
    const risks: RiskAssessment[] = [];

    // Check for suspicious patterns
    if (content.toLowerCase().includes("delete") && content.toLowerCase().includes("all")) {
      risks.push({
        level: "high",
        category: "safety",
        description: "Content contains destructive operations",
        recommendation: "Review content for unintended side effects",
      });
    }

    // Check for code injection patterns
    if (
      /[<>]|exec|eval|system|shell/i.test(content)
    ) {
      risks.push({
        level: "medium",
        category: "security",
        description: "Content contains potentially executable code",
        recommendation: "Verify code is sandboxed and safe to execute",
      });
    }

    // Check for PII-like patterns (basic)
    if (
      /\b\d{3}-\d{2}-\d{4}\b|(\d{4}[\s-]?){3}\d{4}|[a-z0-9]+@[a-z0-9]+\.[a-z]/i.test(
        content
      )
    ) {
      risks.push({
        level: "medium",
        category: "privacy",
        description: "Content may contain personally identifiable information",
        recommendation: "Verify PII is intentional and properly redacted per policy",
      });
    }

    // Check for factuality (basic semantic check)
    const contraindications = /contradicts|however|but|actually|wrong|incorrect/i;
    if (contraindications.test(content) && content.split(".").length > 10) {
      risks.push({
        level: "low",
        category: "accuracy",
        description: "Content contains self-contradictory statements",
        recommendation: "Review for logical consistency",
      });
    }

    return risks;
  }

  /**
   * Generate human-readable audit feedback
   */
  private generateFeedback(approved: boolean, riskCount: number, score: number): string {
    let feedback = `Audit Score: ${(score * 100).toFixed(1)}% — `;

    if (approved) {
      feedback += "APPROVED ✓";
      if (riskCount === 0) {
        feedback += " (No issues detected)";
      } else if (riskCount === 1) {
        feedback += " (1 low-risk issue, suitable for release)";
      } else {
        feedback += ` (${riskCount} minor issues flagged, recommend human review)`;
      }
    } else {
      feedback += "REJECTED ✗";
      if (riskCount > 0) {
        feedback += ` (${riskCount} risk(s) found)`;
      } else {
        feedback += " (Score below approval threshold)";
      }
    }

    return feedback;
  }
}
