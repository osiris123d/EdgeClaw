/**
 * pageIntelWorkflowLogic.ts
 *
 * Pure orchestration logic for the Page Intelligence workflow.
 * Extracted from the CF Workflow class so it can be unit-tested in plain
 * Node.js — all real Cloudflare service calls are provided as injectable
 * callbacks (PageIntelServices).
 *
 * Cloudflare services used by the real implementation:
 *   • Browser Rendering (BROWSER)  → fetchPageContent()
 *   • Workers AI (AI)              → aiSummarize(), aiWriteReport()
 *   • R2 (SKILLS_BUCKET)           → persistToR2()
 *   • AgentWorkflow base class     → reportProgress(), waitForApproval()
 *
 * Data flow:
 *   fetch-page → analyse → [approval?] → write-report → [save-to-r2?] → done
 */

// ── Public types ──────────────────────────────────────────────────────────────

export type PageIntelParams = {
  /**
   * The URL to research. A full `https://…` URL is recommended; a bare hostname
   * is accepted and normalized to `https://…`.
   */
  url?: string;
  /**
   * Alias for `url` (same normalization). Use when the trigger payload only
   * exposes a generic string field named `key`.
   */
  key?: string;
  /** When true, pause for human approval before writing the final report. */
  requireApproval?: boolean;
  /** When true (default), persist the finished report to R2. */
  saveReport?: boolean;
};

/**
 * Resolve and normalize the target URL from a Page Intel payload.
 * Exported for unit tests; `runPageIntelWorkflow` uses this before any browser step.
 */
export function resolvePageIntelTargetUrl(payload: PageIntelParams): string {
  const fromUrl = typeof payload.url === "string" ? payload.url.trim() : "";
  const fromKey = typeof payload.key === "string" ? payload.key.trim() : "";
  const raw = fromUrl || fromKey;
  if (!raw) {
    throw new Error(
      'Page Intelligence workflow requires a non-empty "url" (or "key" as an alias). ' +
        'Example: {"url":"https://example.com"} or {"key":"example.com"}',
    );
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, "")}`;
}

export type PageIntelResult = {
  url:         string;
  title:       string;
  summary:     string;
  insights:    string[];
  reportText:  string;
  /** R2 object key — only present when saveReport = true. */
  savedKey?:   string;
  completedAt: string;
};

/** Minimal step interface matching AgentWorkflowStep.do(). */
export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Injectable Cloudflare service callbacks.
 *
 * In production these are wired to real CF bindings inside
 * EdgeclawPageIntelWorkflow.run().  In tests they are simple mocks.
 */
export interface PageIntelServices {
  /**
   * Fetch a web page and return its title + visible text body.
   * Production: @cloudflare/puppeteer launched with the BROWSER Fetcher binding.
   */
  fetchPageContent(url: string): Promise<{ title: string; bodyText: string }>;

  /**
   * Summarize page text and extract key insights with Workers AI.
   * Production: Workers AI  (@cf/meta/llama-3.3-70b-instruct-fp8-fast).
   */
  aiSummarize(
    bodyText: string,
    url:      string,
  ): Promise<{ summary: string; insights: string[] }>;

  /**
   * Write a structured research report from the summary + insights.
   * Production: Workers AI (same model, different prompt).
   */
  aiWriteReport(
    summary:  string,
    insights: string[],
    url:      string,
  ): Promise<string>;

  /**
   * Persist the finished report as JSON in R2.
   * Production: env.SKILLS_BUCKET.put() under the "intel/" prefix.
   * Returns the R2 object key.
   */
  persistToR2(url: string, reportText: string): Promise<string>;

  /** Forward progress events to the Workflows UI (from AgentWorkflow.reportProgress). */
  reportProgress(data: Record<string, unknown>): Promise<void>;

  /** Human-approval checkpoint (from AgentWorkflow.waitForApproval). */
  waitForApproval(step: WorkflowStep, opts: { timeout: string }): Promise<void>;
}

// ── Core workflow function ────────────────────────────────────────────────────

/**
 * Orchestrate a full page-intelligence research run.
 *
 * Each step.do() call is idempotent — if the Durable Object restarts the
 * worker mid-run, completed steps are replayed from their stored outputs
 * rather than re-executed.
 */
export async function runPageIntelWorkflow(
  payload: PageIntelParams,
  step:    WorkflowStep,
  svc:     PageIntelServices,
): Promise<PageIntelResult> {
  const url = resolvePageIntelTargetUrl(payload);
  const { requireApproval = false, saveReport = true } = payload;

  // ── Step 1: Browser Rendering — fetch the page ─────────────────────────────
  const fetched = await step.do("fetch-page", async () => {
    await svc.reportProgress({ step: "fetch-page", status: "running", percent: 0.1, url });
    const { title, bodyText } = await svc.fetchPageContent(url);
    return { title, bodyText };
  });
  await svc.reportProgress({ step: "fetch-page", status: "complete", percent: 0.25 });

  // ── Step 2: Workers AI — summarise + extract insights ──────────────────────
  const analysis = await step.do("analyse", async () => {
    await svc.reportProgress({ step: "analyse", status: "running", percent: 0.3 });
    return svc.aiSummarize(fetched.bodyText, url);
  });
  await svc.reportProgress({ step: "analyse", status: "complete", percent: 0.5 });

  // ── Optional: human-approval checkpoint ────────────────────────────────────
  // The Workflows UI shows "Waiting for approval" and lets a reviewer
  // approve or reject from the run inspector drawer.
  // Rejection throws WorkflowRejectedError, which surfaces as errored status.
  if (requireApproval) {
    await svc.reportProgress({ step: "awaiting-approval", status: "running", percent: 0.5 });
    await svc.waitForApproval(step, { timeout: "7 days" });
    await svc.reportProgress({ step: "awaiting-approval", status: "complete", percent: 0.6 });
  }

  // ── Step 3: Workers AI — write the structured report ───────────────────────
  const reportText = await step.do("write-report", async () => {
    await svc.reportProgress({ step: "write-report", status: "running", percent: 0.7 });
    return svc.aiWriteReport(analysis.summary, analysis.insights, url);
  });
  await svc.reportProgress({ step: "write-report", status: "complete", percent: 0.85 });

  // ── Step 4 (optional): R2 — persist the report ─────────────────────────────
  let savedKey: string | undefined;

  if (saveReport) {
    savedKey = await step.do("save-to-r2", async () => {
      await svc.reportProgress({ step: "save-to-r2", status: "running", percent: 0.9 });
      return svc.persistToR2(url, reportText);
    });
    await svc.reportProgress({ step: "save-to-r2", status: "complete", percent: 1.0 });
  } else {
    await svc.reportProgress({ step: "complete", status: "complete", percent: 1.0 });
  }

  return {
    url,
    title:       fetched.title,
    summary:     analysis.summary,
    insights:    analysis.insights,
    reportText,
    savedKey,
    completedAt: new Date().toISOString(),
  };
}
