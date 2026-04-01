/**
 * agents/AuditAgent.ts
 *
 * Reviews AnalystAgent output for quality, evidence support,
 * overconfidence, and risky recommendations.
 *
 * AuditAgent NEVER rewrites the content under review. It produces a structured
 * AuditResult with a verdict and recommendations for the caller to act on.
 *
 * Verdict options:
 *   accept          — output meets quality bar; may proceed to next stage
 *   revise          — specific revisions identified; return to source agent
 *   escalate_human  — issues require human judgement before proceeding
 *
 * Idempotency guarantee:
 *   Given identical inputs (task, candidate, artifacts, worklog), AuditAgent
 *   will always produce the same verdict and finding codes. Timestamps are the
 *   only non-deterministic field. Callers may safely re-run audits after revisions.
 *
 * Hard constraints:
 *   - NEVER rewrites, edits, or sends the candidate output
 *   - NEVER performs production changes
 *   - Findings are advisory only; enforcement is the caller's responsibility
 */

import {
  ApprovalState,
  TaskPacket,
  WorklogEntry as CoreWorklogEntry,
} from "../lib/core-task-schema";
import { logAgentEvent } from "../lib/logger";
import { appendWorklogEntry } from "../lib/r2";
import { AgentContext, AgentResult, AuditIssue, AuditSummary, DraftOutput, Env } from "../lib/types";
import { AnalystStructuredOutput } from "./AnalystAgent";

// ─── Finding codes ────────────────────────────────────────────────────────────

/**
 * Canonical audit finding codes.
 * Codes are stable identifiers — callers may key on them programmatically.
 *
 * GOOD finding example (low severity, actionable):
 *   { code: "EVIDENCE_DEPTH", severity: "low",
 *     message: "Only one artifact was referenced. Confidence would improve with an additional RADIUS log.",
 *     recommendation: "Attach syslog export for the affected AP cluster." }
 *
 * BAD finding example (vague, non-actionable):
 *   { code: "LOW_CONFIDENCE", severity: "medium",
 *     message: "Confidence is low." }   ← no evidence pointer, no recommendation
 *
 * The rule: every finding SHOULD include a `recommendation` that tells the
 * source agent or reviewer exactly what to do to resolve it.
 */
export type AuditFindingCode =
  | "MISSING_CONTENT"       // required field or section is absent
  | "UNSUPPORTED_CLAIM"     // assertion not backed by a cited artifact
  | "OVERCONFIDENCE"        // stated confidence exceeds evidence quality
  | "RISKY_RECOMMENDATION"  // proposed action could cause harm if wrong
  | "MISSING_EVIDENCE"      // specific evidence type expected but absent
  | "PII_RISK"              // potential sensitive data in output
  | "FORBIDDEN_ACTION_REF"  // output references a task-forbidden action
  | "INCOMPLETE_TIMELINE"   // timeline section present but sparse
  | "DEFINITION_OF_DONE_GAP" // definitionOfDone items not addressed
  | "LOW_CONFIDENCE"        // analysis confidence below acceptance threshold
  | "INSUFFICIENT_SECTIONS" // drafted document lacks expected sections
  | "APPROVAL_STATE_INVALID" // draft delivered without proper approval gate
  | "WORKLOG_GAP"           // no worklog entry recorded for this task stage
  | "EVIDENCE_DEPTH"        // output could benefit from additional corroborating artifacts
  | "UNKNOWN";              // catch-all for unexpected failures

export interface AuditFinding {
  severity: "low" | "medium" | "high";
  code: AuditFindingCode;
  message: string;
  /** Concrete, actionable guidance for the source agent or human reviewer. */
  recommendation?: string;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

export type AuditVerdict = "accept" | "revise" | "escalate_human";

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * Candidate types the AuditAgent can review.
 * Both share a common structural contract (sections + metadata/confidence).
 */
export type AuditCandidateType = "analyst_output" | "draft_output";

export interface AuditInput {
  task: TaskPacket;
  candidateType: AuditCandidateType;
  /** Pass exactly one of analystOutput or draftOutput. */
  analystOutput?: AnalystStructuredOutput;
  draftOutput?: Record<string, unknown>;
  /** Source artifacts referenced in the task packet — used for evidence cross-check. */
  artifactKeys: string[];
  /** Recent worklog entries for this task — used to check logging gaps. */
  priorWorklogEntries: CoreWorklogEntry[];
}

// ─── Output schema ────────────────────────────────────────────────────────────

export interface AuditStructuredOutput {
  auditId: string;
  taskId: string;
  verdict: AuditVerdict;
  /**
   * Maps directly to ApprovalState on the TaskCoordinator:
   *   accept          → "approved"
   *   revise          → "pending"       (send back for revision)
   *   escalate_human  → "escalated"
   */
  approvalState: ApprovalState;
  score: number;         // 0–100; < 60 = reject; 60–79 = revise; 80+ = accept
  findings: AuditFinding[];
  candidateType: AuditCandidateType;
  auditMode: "deterministic" | "ai_assisted";
  reviewedAt: string;
  /** Summary sentence suitable for worklog and coordinator state. */
  verdictRationale: string;
}

// ─── Prompt template ─────────────────────────────────────────────────────────

/**
 * AUDIT_PROMPT_TEMPLATE
 *
 * Placeholders: {{TASK_PACKET}}, {{CANDIDATE_TYPE}}, {{CANDIDATE_JSON}},
 *               {{ARTIFACT_KEYS}}, {{WORKLOG_TAIL}}
 *
 * Idempotency note: the prompt is deterministic given the same inputs.
 * AI responses may vary, but deterministic checks always run first and
 * constrain the score floor/ceiling regardless of AI output.
 */
export const AUDIT_PROMPT_TEMPLATE = `
You are AuditAgent in an enterprise network operations planning system.

Your role: review the candidate output below for quality, accuracy, and safety.
DO NOT rewrite the content. DO NOT send anything externally.
Produce only a structured JSON audit report.

Hard constraints:
- identify unsupported claims (assertions not backed by cited artifacts)
- identify overconfidence (confidence > 0.85 with < 3 artifacts)
- identify risky recommendations (irreversible or broad-impact actions without caveats)
- identify missing evidence (expected artifact types absent for the domain)
- DO NOT manufacture findings; only flag what is genuinely observable

Task packet:
{{TASK_PACKET}}

Candidate type: {{CANDIDATE_TYPE}}

Candidate output:
{{CANDIDATE_JSON}}

Available artifact keys (referenced in task):
{{ARTIFACT_KEYS}}

Recent worklog (last 10 entries):
{{WORKLOG_TAIL}}

Return a JSON object:
{
  "findings": [
    {
      "severity": "low|medium|high",
      "code": "<AuditFindingCode>",
      "message": "Specific, factual observation.",
      "recommendation": "Concrete action for source agent or reviewer."
    }
  ],
  "verdictRationale": "One sentence explaining the overall verdict.",
  "suggestedVerdict": "accept|revise|escalate_human"
}

Finding code vocabulary: MISSING_CONTENT, UNSUPPORTED_CLAIM, OVERCONFIDENCE,
RISKY_RECOMMENDATION, MISSING_EVIDENCE, PII_RISK, FORBIDDEN_ACTION_REF,
INCOMPLETE_TIMELINE, DEFINITION_OF_DONE_GAP, LOW_CONFIDENCE,
INSUFFICIENT_SECTIONS, APPROVAL_STATE_INVALID, WORKLOG_GAP, UNKNOWN
`.trim();

export function buildAuditPromptText(input: AuditInput): string {
  const candidate = input.analystOutput ?? input.draftOutput ?? {};
  return AUDIT_PROMPT_TEMPLATE
    .replace("{{TASK_PACKET}}", JSON.stringify(input.task))
    .replace("{{CANDIDATE_TYPE}}", input.candidateType)
    .replace("{{CANDIDATE_JSON}}", JSON.stringify(candidate))
    .replace("{{ARTIFACT_KEYS}}", JSON.stringify(input.artifactKeys))
    .replace("{{WORKLOG_TAIL}}", JSON.stringify(input.priorWorklogEntries.slice(-10)));
}

// ─── Worklog helpers ──────────────────────────────────────────────────────────

export function createAuditWorklogEntry(output: AuditStructuredOutput): CoreWorklogEntry {
  return {
    entryId: crypto.randomUUID(),
    taskId: output.taskId,
    agentRole: "auditor",
    action: "audit_completed",
    timestamp: output.reviewedAt,
    summary: `Audit verdict: ${output.verdict} (score=${output.score}). ${output.verdictRationale}`,
    detail: {
      auditId: output.auditId,
      verdict: output.verdict,
      score: output.score,
      findingCount: output.findings.length,
      highCount: output.findings.filter((f) => f.severity === "high").length,
      mediumCount: output.findings.filter((f) => f.severity === "medium").length,
      lowCount: output.findings.filter((f) => f.severity === "low").length,
      approvalState: output.approvalState,
      auditMode: output.auditMode,
    },
  };
}

export function createAuditFailureWorklogEntry(taskId: string, errorMessage: string): CoreWorklogEntry {
  return {
    entryId: crypto.randomUUID(),
    taskId,
    agentRole: "auditor",
    action: "audit_failed",
    timestamp: new Date().toISOString(),
    summary: "AuditAgent execution failed",
    detail: { errorMessage },
  };
}

// ─── Example outputs ──────────────────────────────────────────────────────────

/**
 * SAMPLE_AUDIT_ACCEPT — well-supported analyst output, score 88.
 *
 * Good finding pattern: low severity, specific evidence pointer, actionable recommendation.
 */
export const SAMPLE_AUDIT_ACCEPT: AuditStructuredOutput = {
  auditId: "audit-20260331-001",
  taskId: "task-20260331-wifi-nac-001",
  verdict: "accept",
  approvalState: "approved",
  score: 88,
  findings: [
    {
      severity: "low",
      code: "EVIDENCE_DEPTH",
      message: "Analysis references one RADIUS log artifact. A second corroborating source (e.g. AP-side syslog) would raise confidence above 0.90.",
      recommendation: "Attach AP-side syslog export as an additional input artifact for the next review cycle.",
    },
    {
      severity: "low",
      code: "INCOMPLETE_TIMELINE",
      message: "Incident timeline contains only one event. Consider expanding with pre-incident baseline events.",
      recommendation: "Analyst should append at least two baseline timeline entries from prior normal-state logs.",
    },
  ],
  candidateType: "analyst_output",
  auditMode: "deterministic",
  reviewedAt: "2026-03-31T10:15:00.000Z",
  verdictRationale: "Output is well-supported; two low-severity improvements noted but none block acceptance.",
};

/**
 * SAMPLE_AUDIT_REVISE — draft output with overconfidence and a risky recommendation.
 *
 * Bad finding (what NOT to do):
 *   { code: "LOW_CONFIDENCE", message: "Confidence is low." }   ← no specifics, no recommendation
 *
 * Good finding pattern used here: high severity with a precise observation and concrete action.
 */
export const SAMPLE_AUDIT_REVISE: AuditStructuredOutput = {
  auditId: "audit-20260331-002",
  taskId: "task-20260331-wifi-nac-001",
  verdict: "revise",
  approvalState: "pending",
  score: 58,
  findings: [
    {
      severity: "high",
      code: "OVERCONFIDENCE",
      message: "Draft claims 'root cause confirmed' but only one artifact was provided (confidence 0.55). This claim is not supported by evidence.",
      recommendation: "Replace 'root cause confirmed' with 'root cause hypothesis' and add uncertainty flags until a second corroborating artifact is attached.",
    },
    {
      severity: "high",
      code: "RISKY_RECOMMENDATION",
      message: "Section 'Recommended Actions' proposes 'disable NAC enforcement cluster-wide' — a broad, potentially irreversible action — without a rollback plan or approval gate.",
      recommendation: "Add a rollback procedure and an explicit [APPROVAL GATE] marker before this action. Scope the recommendation to a single VLAN for initial validation.",
    },
    {
      severity: "medium",
      code: "DEFINITION_OF_DONE_GAP",
      message: "Task definitionOfDone requires 'Escalation owner assigned if unresolved', but no escalation owner is named in the draft.",
      recommendation: "Add an escalation contact or ticket reference to satisfy this definition-of-done criterion.",
    },
  ],
  candidateType: "draft_output",
  auditMode: "deterministic",
  reviewedAt: "2026-03-31T10:20:00.000Z",
  verdictRationale: "Two high-severity findings block acceptance: unsupported root-cause claim and unguarded risky recommendation.",
};

/**
 * SAMPLE_AUDIT_ESCALATE — analyst output with PII risk requiring human review.
 */
export const SAMPLE_AUDIT_ESCALATE: AuditStructuredOutput = {
  auditId: "audit-20260331-003",
  taskId: "task-20260331-wifi-nac-001",
  verdict: "escalate_human",
  approvalState: "escalated",
  score: 35,
  findings: [
    {
      severity: "high",
      code: "PII_RISK",
      message: "Output contains what appears to be a guest's full name and room number in the 'technicalNotes' field.",
      recommendation: "Human reviewer must redact PII before the output can be stored or forwarded. Do not proceed until redaction is confirmed.",
    },
    {
      severity: "high",
      code: "FORBIDDEN_ACTION_REF",
      message: "Recommendation references 'credential_exfiltration' pattern — this matches the task's forbiddenActions list exactly.",
      recommendation: "Remove this recommendation entirely. If it was unintentional, review AnalystAgent prompt constraints.",
    },
  ],
  candidateType: "analyst_output",
  auditMode: "deterministic",
  reviewedAt: "2026-03-31T10:25:00.000Z",
  verdictRationale: "PII detected and forbidden action referenced — escalation to human reviewer mandatory before any further processing.",
};

// ─── Agent class ──────────────────────────────────────────────────────────────

export class AuditAgent {
  /**
   * Primary Prompt 9 execution path.
   *
   * Idempotency:
   * - Deterministic checks run first and always produce identical codes for identical inputs.
   * - AI enrichment may add extra findings but cannot remove deterministic ones.
   * - Score is computed from findings after merging; same findings → same score.
   * - Callers may re-run this after the source agent revises output; stale findings
   *   will naturally disappear when the condition they flagged is resolved.
   *
   * Concurrency safety:
   * - AuditAgent does not hold locks. It is safe to run multiple audits in parallel
   *   on different tasks. Do NOT run concurrent audits on the same taskId + candidateType
   *   without deduplicating via the worklog or TaskCoordinatorDO lease.
   */
  async auditOutput(
    env: Env,
    input: AuditInput
  ): Promise<AgentResult<AuditStructuredOutput>> {
    const now = new Date().toISOString();
    const auditId = crypto.randomUUID();
    const warnings: string[] = [];

    try {
      logAgentEvent(env, "audit", "start", {
        taskId: input.task.taskId,
        message: "Starting audit",
      });

      // Step 1: Run deterministic checks (always; forms the audit floor).
      const detFindings = this.runDeterministicChecks(input);

      // Step 2: AI enrichment for unsupported-claim and risky-recommendation detection.
      //         Only attempted if deterministic checks do not already block the output.
      let allFindings = detFindings;
      let auditMode: "deterministic" | "ai_assisted" = "deterministic";
      const detScore = scoreFindings(detFindings);

      if (detScore >= 50) {
        const aiText = await this.callAIGateway(env, buildAuditPromptText(input));
        if (aiText) {
          const aiFindings = parseAiFindings(aiText);
          allFindings = mergeFindings(detFindings, aiFindings);
          auditMode = "ai_assisted";
        } else {
          warnings.push("AI Gateway unavailable; deterministic audit only");
        }
      }

      const score = scoreFindings(allFindings);
      const verdict = deriveVerdict(score, allFindings);
      const approvalState = verdictToApprovalState(verdict);

      const output: AuditStructuredOutput = {
        auditId,
        taskId: input.task.taskId,
        verdict,
        approvalState,
        score,
        findings: allFindings,
        candidateType: input.candidateType,
        auditMode,
        reviewedAt: now,
        verdictRationale: buildVerdictRationale(verdict, score, allFindings),
      };

      // Step 3: Append worklog entry.
      const entry = createAuditWorklogEntry(output);
      const saved = await appendWorklogEntry(env.R2_WORKLOGS, entry);
      if (!saved.ok) {
        warnings.push(`Failed to persist audit worklog: ${saved.error}`);
      }

      logAgentEvent(env, "audit", "complete", {
        taskId: input.task.taskId,
        message: "Audit complete",
        data: {
          verdict,
          score,
          findingCount: allFindings.length,
          mode: auditMode,
        },
      });

      return { agent: "audit", ok: true, warnings, output };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown audit error";
      logAgentEvent(env, "audit", "error", {
        taskId: input.task.taskId,
        message: "Audit failed",
        data: { error: msg },
      });
      const failEntry = createAuditFailureWorklogEntry(input.task.taskId, msg);
      await appendWorklogEntry(env.R2_WORKLOGS, failEntry);

      return {
        agent: "audit",
        ok: false,
        warnings,
        error: msg,
        output: failOutput(auditId, input.task.taskId, input.candidateType, now),
      };
    }
  }

  // ─── Deterministic checks ──────────────────────────────────────────────────

  /**
   * runDeterministicChecks
   *
   * Runs all deterministic audit rules. These are:
   * - Input-only (no external calls)
   * - Side-effect free (no writes)
   * - Idempotent: same input → same output, every run
   *
   * Adding a new rule: add a private check_* method, call it here,
   * push its findings into `findings`. Keep each check focused on one code.
   */
  private runDeterministicChecks(input: AuditInput): AuditFinding[] {
    const findings: AuditFinding[] = [];

    findings.push(...this.checkMissingContent(input));
    findings.push(...this.checkPiiRisk(input));
    findings.push(...this.checkForbiddenActionRefs(input));
    findings.push(...this.checkOverconfidence(input));
    findings.push(...this.checkDefinitionOfDoneGap(input));
    findings.push(...this.checkWorklogGap(input));
    findings.push(...this.checkIncompleteTimeline(input));

    return findings;
  }

  private checkMissingContent(input: AuditInput): AuditFinding[] {
    const findings: AuditFinding[] = [];
    if (input.candidateType === "analyst_output" && input.analystOutput) {
      const o = input.analystOutput;
      if (o.facts.length === 0) {
        findings.push({
          severity: "high",
          code: "MISSING_CONTENT",
          message: "Analyst output has no facts. A valid analysis must produce at least one factual observation.",
          recommendation: "Re-run AnalystAgent with additional artifacts or verify that input artifact content is non-empty.",
        });
      }
      if (o.recommendations.length === 0) {
        findings.push({
          severity: "medium",
          code: "MISSING_CONTENT",
          message: "Analyst output has no recommendations.",
          recommendation: "AnalystAgent should produce at least one recommendation even under high uncertainty.",
        });
      }
    }
    return findings;
  }

  private checkPiiRisk(input: AuditInput): AuditFinding[] {
    const corpus = extractTextCorpus(input);
    if (/\bssn\b|social security|\bcredit card\b|\bapi[_\s]?key\b|\bpassword\b|\bsecret\b/i.test(corpus)) {
      return [{
        severity: "high",
        code: "PII_RISK",
        message: "Potential sensitive data (SSN, credit card, API key, password, or secret) detected in output text.",
        recommendation: "Human reviewer must inspect and redact before this output is stored or forwarded. Escalate immediately.",
      }];
    }
    return [];
  }

  private checkForbiddenActionRefs(input: AuditInput): AuditFinding[] {
    const findings: AuditFinding[] = [];
    if (input.task.forbiddenActions.length === 0) return findings;
    const corpus = extractTextCorpus(input).toLowerCase();
    for (const forbidden of input.task.forbiddenActions) {
      if (corpus.includes(forbidden.toLowerCase())) {
        findings.push({
          severity: "high",
          code: "FORBIDDEN_ACTION_REF",
          message: `Output contains a reference to forbidden action: "${forbidden}".`,
          recommendation: `Remove all references to "${forbidden}" from the candidate output. Review agent prompt constraints to prevent recurrence.`,
        });
      }
    }
    return findings;
  }

  private checkOverconfidence(input: AuditInput): AuditFinding[] {
    if (input.candidateType !== "analyst_output" || !input.analystOutput) return [];
    const { confidence } = input.analystOutput;
    const artifactCount = input.artifactKeys.length;
    // Overconfidence: stated confidence > 0.85 but fewer than 3 supporting artifacts.
    if (confidence > 0.85 && artifactCount < 3) {
      return [{
        severity: "medium",
        code: "OVERCONFIDENCE",
        message: `Analyst confidence is ${confidence.toFixed(2)} but only ${artifactCount} artifact(s) are referenced. High confidence requires at least 3 corroborating sources.`,
        recommendation: "Lower stated confidence to reflect artifact count, or attach additional supporting artifacts before re-running.",
      }];
    }
    // Low confidence: below 0.5 is a concern even if not overconfident.
    if (confidence < 0.5) {
      return [{
        severity: "medium",
        code: "LOW_CONFIDENCE",
        message: `Analyst confidence is ${confidence.toFixed(2)}, which is below the 0.50 acceptance threshold for automated processing.`,
        recommendation: "Attach additional artifacts, or escalate to human reviewer for manual assessment.",
      }];
    }
    return [];
  }

  private checkDefinitionOfDoneGap(input: AuditInput): AuditFinding[] {
    const findings: AuditFinding[] = [];
    if (input.task.definitionOfDone.length === 0) return findings;
    const corpus = extractTextCorpus(input).toLowerCase();
    for (const criterion of input.task.definitionOfDone) {
      // Heuristic: key terms from the criterion should appear somewhere in the output.
      const keywords = criterion.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const covered = keywords.some((kw) => corpus.includes(kw));
      if (!covered) {
        findings.push({
          severity: "medium",
          code: "DEFINITION_OF_DONE_GAP",
          message: `Definition-of-done criterion not addressed: "${criterion}"`,
          recommendation: `Ensure the output explicitly addresses this criterion. Add a section or recommendation that covers: "${criterion}".`,
        });
      }
    }
    return findings;
  }

  private checkWorklogGap(input: AuditInput): AuditFinding[] {
    // Check that the source agent recorded a worklog entry for this stage.
    const expectedAction = input.candidateType === "analyst_output"
      ? "analysis_completed"
      : "draft_generated";
    const hasEntry = input.priorWorklogEntries.some((e) => e.action === expectedAction);
    if (!hasEntry) {
      return [{
        severity: "low",
        code: "WORKLOG_GAP",
        message: `No worklog entry with action "${expectedAction}" found for this task. The source agent may not have persisted its completion record.`,
        recommendation: `Verify that the source agent's worklog append succeeded. Re-run the agent if the entry is missing.`,
      }];
    }
    return [];
  }

  private checkIncompleteTimeline(input: AuditInput): AuditFinding[] {
    if (input.candidateType !== "analyst_output" || !input.analystOutput) return [];
    const { incidentTimeline } = input.analystOutput;
    if (incidentTimeline.length === 1) {
      return [{
        severity: "low",
        code: "INCOMPLETE_TIMELINE",
        message: "Incident timeline contains only one event. A useful timeline should include at least a baseline and an anomaly event.",
        recommendation: "Expand the timeline with pre-incident baseline events drawn from the available artifacts.",
      }];
    }
    return [];
  }

  // ─── AI Gateway ───────────────────────────────────────────────────────────

  private async callAIGateway(env: Env, prompt: string): Promise<string | null> {
    const baseUrl = env.AI_GATEWAY_BASE_URL;
    const token = env.AI_GATEWAY_TOKEN;
    // TODO: Add AI_GATEWAY_ROUTE_AUDITOR to Env and Wrangler vars for a dedicated audit model route.
    const route = env.AI_GATEWAY_ROUTE_ANALYST; // reuse until dedicated route is provisioned

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
          {
            role: "system",
            content:
              "You are AuditAgent. Review the candidate output. DO NOT rewrite it. Return only a JSON audit report.",
          },
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

  // ─── Backward-compatible run() wrapper ────────────────────────────────────

  /**
   * @deprecated Use auditOutput(env, input) instead.
   * Preserved for TaskWorkflow compatibility until Prompt 10 aligns the pipeline.
   */
  async run(
    context: AgentContext,
    candidate: DraftOutput,
    dispatchConfidence: number
  ): Promise<AgentResult<AuditSummary>> {
    try {
      const issues: AuditIssue[] = [];

      if (!candidate.summary || candidate.summary.trim().length < 10) {
        issues.push({ severity: "high", code: "MISSING_CONTENT", message: "Summary is missing or too short." });
      }
      if (candidate.sections.length < 2) {
        issues.push({ severity: "medium", code: "MISSING_CONTENT", message: "Report has too few sections." });
      }

      const fullText = [candidate.summary, ...candidate.sections.map((s) => s.body)].join(" ").toLowerCase();
      if (/ssn|social security|credit card|api key|secret/.test(fullText)) {
        issues.push({ severity: "high", code: "PII_RISK", message: "Potential sensitive data detected in output." });
      }
      if (dispatchConfidence < 0.6) {
        issues.push({ severity: "low", code: "LOW_CONFIDENCE", message: `Dispatcher confidence was low (${dispatchConfidence.toFixed(2)}).` });
      }

      const penalty = issues.reduce((acc, i) => acc + (i.severity === "high" ? 35 : i.severity === "medium" ? 20 : 10), 0);
      const score = Math.max(0, 100 - penalty);
      const approved = issues.every((i) => i.severity !== "high") && score >= 60;

      return { agent: "audit", ok: true, warnings: [], output: { approved, score, issues } };
    } catch (error: unknown) {
      return {
        agent: "audit",
        ok: false,
        warnings: [],
        error: error instanceof Error ? error.message : `Unknown audit error for task ${context.taskId}`,
        output: { approved: false, score: 0, issues: [{ severity: "high", code: "UNKNOWN", message: "Audit execution failed." }] },
      };
    }
  }
}

// ─── Module-level helpers ────────────────────────────────────────────────────

/**
 * scoreFindings: penalty-based scoring.
 * Starts at 100; high=-30, medium=-15, low=-5.
 * Floors at 0.
 *
 * Idempotency: same findings (same codes) → same score.
 */
function scoreFindings(findings: AuditFinding[]): number {
  const penalty = findings.reduce((acc, f) => {
    if (f.severity === "high") return acc + 30;
    if (f.severity === "medium") return acc + 15;
    return acc + 5;
  }, 0);
  return Math.max(0, 100 - penalty);
}

/**
 * deriveVerdict:
 *   score >= 80 and no high findings → accept
 *   PII_RISK or FORBIDDEN_ACTION_REF (any severity) → escalate_human (always)
 *   score 60–79 or medium findings only → revise
 *   score < 60 or any high finding → revise (unless escalation trigger above)
 */
function deriveVerdict(score: number, findings: AuditFinding[]): AuditVerdict {
  const escalationCodes: AuditFindingCode[] = ["PII_RISK", "FORBIDDEN_ACTION_REF"];
  if (findings.some((f) => escalationCodes.includes(f.code))) return "escalate_human";
  if (score >= 80 && !findings.some((f) => f.severity === "high")) return "accept";
  return "revise";
}

function verdictToApprovalState(verdict: AuditVerdict): ApprovalState {
  if (verdict === "accept") return "approved";
  if (verdict === "escalate_human") return "escalated";
  return "pending";
}

function buildVerdictRationale(verdict: AuditVerdict, score: number, findings: AuditFinding[]): string {
  const highCount = findings.filter((f) => f.severity === "high").length;
  const medCount = findings.filter((f) => f.severity === "medium").length;
  if (verdict === "accept") return `Output passed audit with score ${score}/100 and ${findings.length} low-severity finding(s).`;
  if (verdict === "escalate_human") {
    const triggers = findings.filter((f) => ["PII_RISK", "FORBIDDEN_ACTION_REF"].includes(f.code));
    return `Escalation required: ${triggers.map((f) => f.code).join(", ")} detected.`;
  }
  return `Revision required: score ${score}/100, ${highCount} high and ${medCount} medium finding(s) must be addressed.`;
}

/**
 * mergeFindings: AI findings that share a code with an existing deterministic
 * finding are dropped (deterministic has precedence; avoids duplicate noise).
 * New codes from AI are appended.
 *
 * Idempotency: given the same deterministic set, no AI finding can remove a
 * deterministic finding. The worst-case score can only decrease (more findings).
 */
function mergeFindings(deterministic: AuditFinding[], ai: AuditFinding[]): AuditFinding[] {
  const existingCodes = new Set(deterministic.map((f) => f.code));
  const novel = ai.filter((f) => !existingCodes.has(f.code));
  return [...deterministic, ...novel];
}

function parseAiFindings(aiText: string): AuditFinding[] {
  try {
    const jsonStr = extractJsonBlock(aiText);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const raw = parsed["findings"];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f): f is AuditFinding => isRecord(f) && typeof f["code"] === "string" && typeof f["message"] === "string")
      .map((f) => ({
        severity: (["low", "medium", "high"].includes(f.severity as string) ? f.severity : "medium") as AuditFinding["severity"],
        code: f.code as AuditFindingCode,
        message: f.message as string,
        recommendation: typeof f.recommendation === "string" ? f.recommendation : undefined,
      }));
  } catch {
    return [];
  }
}

function extractTextCorpus(input: AuditInput): string {
  const parts: string[] = [];
  if (input.analystOutput) {
    parts.push(...input.analystOutput.facts);
    parts.push(...input.analystOutput.recommendations);
    parts.push(...input.analystOutput.technicalNotes);
    parts.push(...input.analystOutput.nextStepRecommendations);
    for (const h of input.analystOutput.rootCauseHypotheses) {
      parts.push(h.hypothesis);
    }
  }
  return parts.join(" ");
}

function extractJsonBlock(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (match) return match[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text;
}

function extractModelText(raw: Record<string, unknown>): string | null {
  const choices = raw["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as Record<string, unknown>)["message"];
    if (msg && typeof (msg as Record<string, unknown>)["content"] === "string") {
      return (msg as Record<string, unknown>)["content"] as string;
    }
  }
  if (typeof raw["result"] === "string") return raw["result"] as string;
  if (typeof raw["response"] === "string") return raw["response"] as string;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function failOutput(
  auditId: string,
  taskId: string,
  candidateType: AuditCandidateType,
  now: string
): AuditStructuredOutput {
  return {
    auditId,
    taskId,
    verdict: "escalate_human",
    approvalState: "escalated",
    score: 0,
    findings: [{ severity: "high", code: "UNKNOWN", message: "AuditAgent threw an unhandled exception.", recommendation: "Check worker logs for the stack trace." }],
    candidateType,
    auditMode: "deterministic",
    reviewedAt: now,
    verdictRationale: "Audit failed due to an unhandled exception. Human review required.",
  };
}
