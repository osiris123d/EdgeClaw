/**
 * agents/AnalystAgent.ts
 * Analyst agent for read/analyze/recommend-only execution.
 *
 * Responsibilities:
 * - consume TaskPacket + related artifacts + prior worklog
 * - produce structured, auditable analysis output
 * - append a structured worklog entry after each run
 * - never execute production/destructive/external-send actions
 */

import { TaskPacket, WorklogEntry as CoreWorklogEntry } from "../lib/core-task-schema";
import { logAgentEvent } from "../lib/logger";
import { appendWorklogEntry } from "../lib/r2";
import { AgentContext, AgentResult, AnalysisOutput, Env, TaskInput } from "../lib/types";

export interface AnalystArtifact {
  key: string;
  content: Record<string, unknown> | string;
}

export interface AnalystTaskInput {
  task: TaskPacket;
  artifacts: AnalystArtifact[];
  priorWorklogEntries: CoreWorklogEntry[];
}

export interface AnalystRootCauseHypothesis {
  hypothesis: string;
  confidence: number;
  supportingFacts: string[];
  missingEvidence: string[];
}

export interface AnalystStructuredOutput {
  confidence: number;
  facts: string[];
  assumptions: string[];
  recommendations: string[];
  incidentTimeline: Array<{ at: string; event: string; source: string }>;
  impactSummary: {
    usersAffected: string;
    systemsAffected: string[];
    businessImpact: string;
  };
  rootCauseHypotheses: AnalystRootCauseHypothesis[];
  riskAnalysis: {
    level: "low" | "medium" | "high";
    factors: string[];
  };
  nextStepRecommendations: string[];
  technicalNotes: string[];
  uncertaintyFlags: string[];
  auditTrail: {
    taskId: string;
    analyzedAt: string;
    artifactCount: number;
    priorWorklogCount: number;
    analysisMode: "deterministic" | "ai_assisted";
  };
}

export const ANALYST_PROMPT_TEMPLATE = `
You are AnalystAgent in an enterprise network operations system.

Hard constraints:
- perform read/analyze/recommend only
- DO NOT propose or execute production changes directly
- DO NOT perform external sends (email/chat/vendor) directly
- DO NOT perform destructive actions

Return structured JSON with sections:
{
  "facts": ["..."],
  "assumptions": ["..."],
  "recommendations": ["..."],
  "incidentTimeline": [{"at":"...","event":"...","source":"..."}],
  "impactSummary": {"usersAffected":"...","systemsAffected":["..."],"businessImpact":"..."},
  "rootCauseHypotheses": [{"hypothesis":"...","confidence":0.0,"supportingFacts":["..."],"missingEvidence":["..."]}],
  "riskAnalysis": {"level":"low|medium|high","factors":["..."]},
  "nextStepRecommendations": ["..."],
  "technicalNotes": ["..."],
  "uncertaintyFlags": ["..."]
}

TaskPacket JSON:
{{TASK_PACKET}}

Related Artifacts JSON:
{{ARTIFACTS}}

Recent Worklog JSON:
{{WORKLOG}}
`.trim();

export const SAMPLE_WIFI_NAC_ANALYSIS_RESULT: AnalystStructuredOutput = {
  confidence: 0.72,
  facts: [
    "WiFi outage window overlaps with NAC policy rollout interval.",
    "Authentication failures spiked on SSIDs using 802.1X.",
    "Core switching remained healthy during incident period.",
  ],
  assumptions: [
    "NAC rule propagation timing is consistent across all access controllers.",
    "No parallel identity provider outage occurred.",
  ],
  recommendations: [
    "Validate NAC policy diff for 802.1X identity groups.",
    "Run targeted rollback simulation in staging before wider rollback decision.",
  ],
  incidentTimeline: [
    { at: "2026-03-31T09:10:00.000Z", event: "NAC change deployed", source: "change-log" },
    { at: "2026-03-31T09:14:00.000Z", event: "WiFi auth failures increased", source: "wifi-telemetry" },
  ],
  impactSummary: {
    usersAffected: "approx 180 corporate users",
    systemsAffected: ["HQ-WiFi", "NAC-Policy-Engine"],
    businessImpact: "Intermittent user connectivity for core operations teams.",
  },
  rootCauseHypotheses: [
    {
      hypothesis: "NAC policy condition mismatch for specific role attributes",
      confidence: 0.76,
      supportingFacts: ["Failure signature concentrated in role-mapped users"],
      missingEvidence: ["Per-request policy decision trace"],
    },
  ],
  riskAnalysis: {
    level: "high",
    factors: ["Active user impact", "Potential repeated auth flaps under load"],
  },
  nextStepRecommendations: [
    "Collect NAC decision logs for affected user cohort.",
    "Prepare CAB-ready rollback and containment note.",
  ],
  technicalNotes: ["No packet-loss anomalies observed at core edge.", "RADIUS timeout distribution remained stable."],
  uncertaintyFlags: ["Need NAC decision trace to confirm root-cause hypothesis."],
  auditTrail: {
    taskId: "task-inc-1001",
    analyzedAt: "2026-03-31T10:00:00.000Z",
    artifactCount: 3,
    priorWorklogCount: 5,
    analysisMode: "deterministic",
  },
};

export class AnalystAgent {
  /**
   * Backward-compatible wrapper for older workflow integration.
   */
  async run(
    env: Env,
    context: AgentContext,
    input: TaskInput
  ): Promise<AgentResult<AnalysisOutput>> {
    try {
      const syntheticTask: TaskPacket = {
        taskId: context.taskId,
        taskType: "root_cause_analysis",
        domain: "cross_domain",
        title: input.objective,
        goal: input.objective,
        definitionOfDone: ["Facts and recommendations generated"],
        allowedTools: ["r2.read", "worklog.append", "ai_gateway.analyze"],
        forbiddenActions: ["direct_production_change", "external_send", "destructive_action"],
        inputArtifacts: [],
        dependencies: [],
        status: "in_progress",
        approvalState: "not_required",
        escalationRules: [],
        createdAt: context.nowIso,
        updatedAt: context.nowIso,
        assignedAgentRole: "analyst",
        metadata: { source: "workflow", custom: { payload: input.payload } },
      };

      const structured = await this.analyzeTask(env, {
        task: syntheticTask,
        artifacts: [],
        priorWorklogEntries: [],
      });

      if (!structured.ok) {
        return {
          agent: "analyst",
          ok: false,
          warnings: [],
          error: structured.error,
          output: {
            findings: [],
            recommendations: [],
            riskNotes: ["Analysis failed."],
          },
        };
      }

      const output: AnalysisOutput = {
        findings: structured.output.facts,
        recommendations: structured.output.recommendations,
        riskNotes: [
          `Risk level: ${structured.output.riskAnalysis.level}`,
          ...structured.output.uncertaintyFlags,
        ],
      };

      return {
        agent: "analyst",
        ok: true,
        warnings: structured.warnings,
        output,
      };
    } catch (error: unknown) {
      return {
        agent: "analyst",
        ok: false,
        warnings: [],
        error: error instanceof Error ? error.message : "Unknown analyst error",
        output: {
          findings: [],
          recommendations: [],
          riskNotes: ["Analysis failed."],
        },
      };
    }
  }

  /**
   * Primary Prompt 7 execution path.
   */
  async analyzeTask(env: Env, input: AnalystTaskInput): Promise<AgentResult<AnalystStructuredOutput>> {
    try {
      logAgentEvent(env, "analyst", "start", {
        taskId: input.task.taskId,
        message: "Starting analysis",
      });

      const deterministic = this.deterministicAnalyze(input);

      let output = deterministic;
      let mode: "deterministic" | "ai_assisted" = "deterministic";
      const aiWarnings: string[] = [];

      if (deterministic.confidence < 0.75) {
        const ai = await this.callAIGateway(env, buildAnalysisPrompt(input));
        if (ai) {
          const merged = mergeWithAiText(deterministic, ai);
          output = merged;
          mode = "ai_assisted";
        } else {
          aiWarnings.push("AI Gateway unavailable; deterministic analysis used.");
        }
      }

      output.auditTrail.analysisMode = mode;

      const worklogEntry = createAnalystWorklogEntry(input.task.taskId, output, mode);
      const saved = await appendWorklogEntry(env.R2_WORKLOGS, worklogEntry);
      if (!saved.ok) {
        aiWarnings.push(`Failed to persist analyst worklog: ${saved.error}`);
      }

      logAgentEvent(env, "analyst", "complete", {
        taskId: input.task.taskId,
        message: "Analysis complete",
        data: {
          mode,
          confidence: output.confidence,
          findingCount: output.facts.length,
        },
      });

      return {
        agent: "analyst",
        ok: true,
        warnings: aiWarnings,
        output,
      };
    } catch (error: unknown) {
      logAgentEvent(env, "analyst", "error", {
        taskId: input.task.taskId,
        message: "Analysis failed",
        data: { error: toErrorMessage(error) },
      });

      const failEntry = createAnalystFailureWorklogEntry(input.task.taskId, toErrorMessage(error));
      await appendWorklogEntry(env.R2_WORKLOGS, failEntry);

      return {
        agent: "analyst",
        ok: false,
        warnings: [],
        error: toErrorMessage(error),
        output: this.emptyOutput(input.task.taskId, input.artifacts.length, input.priorWorklogEntries.length),
      };
    }
  }

  private async callAIGateway(env: Env, prompt: string): Promise<string | null> {
    const baseUrl = env.AI_GATEWAY_BASE_URL;
    const token = env.AI_GATEWAY_TOKEN;
    const route = env.AI_GATEWAY_ROUTE_ANALYST;

    if (!baseUrl || !token || !route) {
      // TODO: Provide AI Gateway credentials/routes in Wrangler vars for live model execution.
      return null;
    }

    const url = `${baseUrl.replace(/\/$/, "")}/${route}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are an enterprise analyst." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      // TODO: Implement retry/backoff policy for transient gateway errors.
      throw new Error(`AI Gateway request failed with status ${response.status}`);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    return extractModelText(raw);
  }

  private deterministicAnalyze(input: AnalystTaskInput): AnalystStructuredOutput {
    const now = new Date().toISOString();
    const corpus = makeCorpus(input);

    const facts: string[] = [];
    const assumptions: string[] = [];
    const recommendations: string[] = [];
    const technicalNotes: string[] = [];

    if (/wifi|wireless|ssid/.test(corpus)) {
      facts.push("Wireless-related indicators are present in source artifacts.");
      technicalNotes.push("Review AP auth and RADIUS metrics for anomaly windows.");
    }
    if (/nac|802\.1x|policy/.test(corpus)) {
      facts.push("NAC/policy signals are present and may influence access outcomes.");
      technicalNotes.push("Compare NAC policy revision timing to failure onset.");
    }
    if (/outage|incident|access problem|failure/.test(corpus)) {
      facts.push("Incident symptoms indicate degraded connectivity or access.");
    }

    assumptions.push("Artifact timestamps are accurate and synchronized.");
    recommendations.push("Correlate timeline across policy changes, auth logs, and user impact windows.");
    recommendations.push("Prioritize reversible containment options pending confirmation.");

    const confidenceBase = 0.55 + Math.min(0.35, input.artifacts.length * 0.05 + input.priorWorklogEntries.length * 0.02);
    const confidence = Math.min(0.95, confidenceBase);
    const uncertaintyFlags = confidence < 0.7
      ? ["Confidence is low due to limited corroborating artifacts."]
      : [];

    const riskLevel = /outage|sev1|major/.test(corpus) ? "high" : /degrad|intermittent/.test(corpus) ? "medium" : "low";

    return {
      confidence,
      facts: facts.length > 0 ? facts : ["No direct domain-specific signals were found in provided inputs."],
      assumptions,
      recommendations,
      incidentTimeline: [
        {
          at: now,
          event: "Analyst evaluation executed",
          source: "analyst-agent",
        },
      ],
      impactSummary: {
        usersAffected: "unknown",
        systemsAffected: inferSystems(corpus),
        businessImpact: "Impact estimate requires additional telemetry.",
      },
      rootCauseHypotheses: [
        {
          hypothesis: "Policy/auth path mismatch under current task conditions",
          confidence: Math.max(0.4, confidence - 0.1),
          supportingFacts: facts.slice(0, 2),
          missingEvidence: ["Detailed decision traces", "Per-user failure distribution"],
        },
      ],
      riskAnalysis: {
        level: riskLevel,
        factors: [
          "Current confidence level",
          "Potential auth/policy coupling",
          "Observed incident keywords",
        ],
      },
      nextStepRecommendations: [
        "Gather high-fidelity logs for affected interval.",
        "Validate reversible containment options before rollout.",
      ],
      technicalNotes,
      uncertaintyFlags,
      auditTrail: {
        taskId: input.task.taskId,
        analyzedAt: now,
        artifactCount: input.artifacts.length,
        priorWorklogCount: input.priorWorklogEntries.length,
        analysisMode: "deterministic",
      },
    };
  }

  private emptyOutput(taskId: string, artifactCount: number, priorWorklogCount: number): AnalystStructuredOutput {
    return {
      confidence: 0,
      facts: [],
      assumptions: [],
      recommendations: [],
      incidentTimeline: [],
      impactSummary: { usersAffected: "unknown", systemsAffected: [], businessImpact: "unknown" },
      rootCauseHypotheses: [],
      riskAnalysis: { level: "high", factors: ["analysis_failed"] },
      nextStepRecommendations: [],
      technicalNotes: [],
      uncertaintyFlags: ["Analysis failed; output is incomplete."],
      auditTrail: {
        taskId,
        analyzedAt: new Date().toISOString(),
        artifactCount,
        priorWorklogCount,
        analysisMode: "deterministic",
      },
    };
  }
}

export function buildAnalysisPrompt(input: AnalystTaskInput): string {
  return ANALYST_PROMPT_TEMPLATE
    .replace("{{TASK_PACKET}}", JSON.stringify(input.task))
    .replace("{{ARTIFACTS}}", JSON.stringify(input.artifacts))
    .replace("{{WORKLOG}}", JSON.stringify(input.priorWorklogEntries.slice(-15)));
}

export function createAnalystWorklogEntry(
  taskId: string,
  output: AnalystStructuredOutput,
  mode: "deterministic" | "ai_assisted"
): CoreWorklogEntry {
  return {
    entryId: crypto.randomUUID(),
    taskId,
    agentRole: "analyst",
    timestamp: new Date().toISOString(),
    action: "analysis_completed",
    summary: `Analyst run complete: confidence=${output.confidence.toFixed(2)}, mode=${mode}`,
    detail: {
      mode,
      confidence: output.confidence,
      factsCount: output.facts.length,
      assumptionsCount: output.assumptions.length,
      recommendationsCount: output.recommendations.length,
      uncertaintyFlags: output.uncertaintyFlags,
    },
  };
}

export function createAnalystFailureWorklogEntry(taskId: string, errorMessage: string): CoreWorklogEntry {
  return {
    entryId: crypto.randomUUID(),
    taskId,
    agentRole: "analyst",
    timestamp: new Date().toISOString(),
    action: "analysis_failed",
    summary: "Analyst run failed",
    detail: { errorMessage },
  };
}

function mergeWithAiText(base: AnalystStructuredOutput, aiText: string): AnalystStructuredOutput {
  const uncertaintyFlags = [...base.uncertaintyFlags];
  if (base.confidence < 0.8) {
    uncertaintyFlags.push("AI-assisted output should be reviewed by a human before final decisions.");
  }

  return {
    ...base,
    confidence: Math.min(0.95, base.confidence + 0.08),
    technicalNotes: [...base.technicalNotes, `AI note: ${truncate(aiText, 320)}`],
    uncertaintyFlags,
  };
}

function makeCorpus(input: AnalystTaskInput): string {
  const artifacts = input.artifacts
    .map((a: AnalystArtifact) => (typeof a.content === "string" ? a.content : JSON.stringify(a.content)))
    .join(" ");

  const worklog = input.priorWorklogEntries
    .map((entry: CoreWorklogEntry) => `${entry.action} ${entry.summary} ${JSON.stringify(entry.detail || {})}`)
    .join(" ");

  return `${input.task.goal} ${input.task.title} ${artifacts} ${worklog}`.toLowerCase();
}

function inferSystems(corpus: string): string[] {
  const systems: string[] = [];
  if (/wifi|wireless|ssid/.test(corpus)) systems.push("wireless");
  if (/nac|802\.1x|policy/.test(corpus)) systems.push("nac");
  if (/ztna|zero trust/.test(corpus)) systems.push("ztna");
  return systems.length > 0 ? systems : ["unknown"];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown analyst error";
}

function extractModelText(raw: Record<string, unknown>): string {
  const result = raw.result as Record<string, unknown> | undefined;
  if (result && typeof result.response === "string") {
    return result.response;
  }

  const text = raw.response;
  return typeof text === "string" ? text : JSON.stringify(raw);
}
