/**
 * researchWorkflowLogic.ts
 *
 * Pure orchestration logic for the EdgeClaw research workflow, extracted from
 * the CF Workflow class so it can be unit-tested in plain Node.js without the
 * `cloudflare:` runtime that AgentWorkflow depends on.
 *
 * The EdgeclawResearchWorkflow class imports and delegates to runResearchWorkflow().
 * Tests import and call runResearchWorkflow() directly with lightweight mocks.
 *
 * Data flow:
 *   initialise → gather-sources (AI) → [approval?] → synthesise (AI report) → [save-to-r2?] → done
 */

// ── Public types ──────────────────────────────────────────────────────────────

export type ResearchParams = {
  topic?:           string;
  url?:             string;
  /** When true the workflow will pause at the approval checkpoint. */
  requireApproval?: boolean;
  /** When false, skip R2 persistence (default: true). */
  saveReport?:      boolean;
};

export type ResearchResult = {
  topic:        string;
  sourceCount:  number;
  summary:      string;
  insights:     string[];
  reportText:   string;
  /** R2 object key — only present when saveReport = true and SKILLS_BUCKET is bound. */
  savedKey?:    string;
  completedAt:  string;
};

/** Minimal step interface matching AgentWorkflowStep.do(). */
export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Injectable service callbacks.
 *
 * In production these are wired to real CF bindings inside
 * EdgeclawResearchWorkflow.run().  In tests they are lightweight mocks.
 */
export interface WorkflowCallbacks {
  /** Forward progress events to the Workflows UI. */
  reportProgress(data: Record<string, unknown>): Promise<void>;

  /** Human-approval checkpoint. */
  waitForApproval(step: WorkflowStep, opts: { timeout: string }): Promise<void>;

  /**
   * Use Workers AI to research a topic and return a concise summary with key
   * insights.  The AI is the "source" — no live web browsing required.
   */
  aiResearch(topic: string, url: string | null): Promise<{ summary: string; insights: string[] }>;

  /**
   * Use Workers AI to write a structured research report from the summary and
   * insights.
   */
  aiWriteReport(topic: string, summary: string, insights: string[]): Promise<string>;

  /**
   * Persist the finished report to R2.  Returns the R2 object key.
   * Implementation is optional — callers pass a no-op when SKILLS_BUCKET is
   * unavailable or when saveReport = false.
   */
  persistToR2(topic: string, reportText: string): Promise<string>;
}

// ── Core workflow function ────────────────────────────────────────────────────

/**
 * Orchestrate a full topic-research run.
 *
 * Each step.do() call is idempotent — completed steps are replayed from their
 * stored outputs if the Durable Object restarts mid-run.
 */
export async function runResearchWorkflow(
  payload:   ResearchParams,
  step:      WorkflowStep,
  callbacks: WorkflowCallbacks,
): Promise<ResearchResult> {
  const {
    topic        = "general research",
    url          = null,
    requireApproval = false,
    saveReport      = true,
  } = payload;

  // ── Step 1: Initialise ──────────────────────────────────────────────────────
  const initialised = await step.do("initialise", async () => {
    await callbacks.reportProgress({ step: "initialise", status: "running", percent: 0.05 });
    return {
      topic,
      url,
      startedAt: new Date().toISOString(),
    };
  });

  await callbacks.reportProgress({ step: "initialise", status: "complete", percent: 0.2 });

  // ── Step 2: Workers AI — research the topic ─────────────────────────────────
  const research = await step.do("gather-sources", async () => {
    await callbacks.reportProgress({ step: "gather-sources", status: "running", percent: 0.3 });
    const result = await callbacks.aiResearch(initialised.topic, initialised.url);
    return {
      sourceCount: 1, // Workers AI knowledge base as the source
      summary:     result.summary,
      insights:    result.insights,
    };
  });

  await callbacks.reportProgress({ step: "gather-sources", status: "complete", percent: 0.5 });

  // ── Optional: human-approval checkpoint ────────────────────────────────────
  if (requireApproval) {
    await callbacks.reportProgress({ step: "awaiting-approval", status: "running", percent: 0.5 });
    await callbacks.waitForApproval(step, { timeout: "7 days" });
    await callbacks.reportProgress({ step: "awaiting-approval", status: "complete", percent: 0.6 });
  }

  // ── Step 3: Workers AI — write structured report ────────────────────────────
  const reportText = await step.do("synthesise", async () => {
    await callbacks.reportProgress({ step: "synthesise", status: "running", percent: 0.7 });
    return callbacks.aiWriteReport(initialised.topic, research.summary, research.insights);
  });

  await callbacks.reportProgress({ step: "synthesise", status: "complete", percent: 0.85 });

  // ── Step 4 (optional): R2 — persist ────────────────────────────────────────
  let savedKey: string | undefined;

  if (saveReport) {
    savedKey = await step.do("save-to-r2", async () => {
      await callbacks.reportProgress({ step: "save-to-r2", status: "running", percent: 0.9 });
      return callbacks.persistToR2(initialised.topic, reportText);
    });
    await callbacks.reportProgress({ step: "save-to-r2", status: "complete", percent: 1.0 });
  } else {
    await callbacks.reportProgress({ step: "complete", status: "complete", percent: 1.0 });
  }

  return {
    topic:       initialised.topic,
    sourceCount: research.sourceCount,
    summary:     research.summary,
    insights:    research.insights,
    reportText,
    savedKey,
    completedAt: new Date().toISOString(),
  };
}
