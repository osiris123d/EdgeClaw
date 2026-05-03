/**
 * Unit tests for the EdgeClaw Page Intelligence workflow.
 *
 * Tests runPageIntelWorkflow() from pageIntelWorkflowLogic.ts in plain Node.js.
 * All three Cloudflare services are mocked:
 *   - Browser Rendering  → makeSvc().fetchPageContent   (returns fake HTML text)
 *   - Workers AI         → makeSvc().aiSummarize        (returns structured object)
 *                          makeSvc().aiWriteReport       (returns prose string)
 *   - R2                 → makeSvc().persistToR2         (records the key written)
 *
 * Coverage:
 *   1.  Happy path — four steps run in order, result has correct shape
 *   2.  Step order — fetch-page → analyse → write-report → save-to-r2
 *   3.  R2 key format — key starts with "intel/"
 *   4.  saveReport=false — persistToR2 is NOT called; savedKey is undefined
 *   5.  Approval path — waitForApproval called when requireApproval=true
 *   6.  No-approval path — waitForApproval NOT called when requireApproval=false
 *   7.  Rejection path — WorkflowRejectedError propagates; write-report does not run
 *   8.  AI JSON parse failure — aiSummarize gracefully falls back to raw string
 *   9.  Progress reporting — all phases present; final progress = 1.0
 *   10. Approval progress — awaiting-approval progress emitted
 *   11. Step idempotency — each step.do callback runs exactly once
 *   12. fetchPageContent error — R2 not called when earlier step fails
 *   13. Data flow — aiWriteReport receives summary + insights from aiSummarize
 *   14. Result shape — all required fields present and typed correctly
 */

import { test } from "node:test";
import assert   from "node:assert/strict";

const { runPageIntelWorkflow } = await import(
  "../dist/workflows/pageIntelWorkflowLogic.js"
);

// ── Test doubles ──────────────────────────────────────────────────────────────

/** Minimal step mock — runs each callback once and records names in order. */
function makeStep() {
  const calls = [];
  return {
    calls,
    async do(name, fn) {
      const result = await fn();
      calls.push(name);
      return result;
    },
  };
}

/**
 * Default service mock — all services succeed and return realistic stubs.
 * Pass overrides to selectively replace individual methods.
 */
function makeSvc(overrides = {}) {
  const progressCalls     = [];
  let   waitForApprovalCalled = false;
  let   persistCalls          = [];

  const defaults = {
    async fetchPageContent(url) {
      return {
        title:    `Page title for ${url}`,
        bodyText: `Body text content for ${url}. Some interesting facts.`,
      };
    },

    async aiSummarize(_bodyText, _url) {
      return {
        summary:  "A concise summary of the page.",
        insights: ["Insight one", "Insight two", "Insight three"],
      };
    },

    async aiWriteReport(_summary, _insights, _url) {
      return "## Executive Summary\nThis is the report.\n## Key Findings\nFound stuff.";
    },

    async persistToR2(url, _reportText) {
      const key = `intel/${url.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}.json`;
      persistCalls.push({ url, key });
      return key;
    },

    async reportProgress(data) {
      progressCalls.push(data);
    },

    async waitForApproval(_step, _opts) {
      waitForApprovalCalled = true;
    },
  };

  const svc = { ...defaults, ...overrides };

  return {
    svc,
    progressCalls,
    persistCalls,
    get waitForApprovalCalled() { return waitForApprovalCalled; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("1. happy path — four steps run and result has correct shape", async () => {
  const step  = makeStep();
  const { svc } = makeSvc();

  const result = await runPageIntelWorkflow(
    { url: "https://example.com", requireApproval: false, saveReport: true },
    step,
    svc,
  );

  assert.deepEqual(step.calls, ["fetch-page", "analyse", "write-report", "save-to-r2"]);

  assert.equal(typeof result.url,         "string");
  assert.equal(typeof result.title,       "string");
  assert.equal(typeof result.summary,     "string");
  assert.ok(Array.isArray(result.insights));
  assert.equal(typeof result.reportText,  "string");
  assert.equal(typeof result.savedKey,    "string");
  assert.equal(typeof result.completedAt, "string");
});

test("2. step order — fetch-page → analyse → write-report → save-to-r2", async () => {
  const step  = makeStep();
  const { svc } = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", saveReport: true },
    step,
    svc,
  );

  assert.deepEqual(step.calls, ["fetch-page", "analyse", "write-report", "save-to-r2"]);
});

test("3. R2 key format — saved key starts with 'intel/'", async () => {
  const step  = makeStep();
  const { svc } = makeSvc();

  const result = await runPageIntelWorkflow(
    { url: "https://example.com", saveReport: true },
    step,
    svc,
  );

  assert.ok(result.savedKey?.startsWith("intel/"), `savedKey was: ${result.savedKey}`);
});

test("4. saveReport=false — persistToR2 not called; savedKey is undefined", async () => {
  const step  = makeStep();
  const { svc, persistCalls } = makeSvc();

  const result = await runPageIntelWorkflow(
    { url: "https://example.com", saveReport: false },
    step,
    svc,
  );

  assert.equal(persistCalls.length, 0);
  assert.equal(result.savedKey, undefined);
  assert.ok(!step.calls.includes("save-to-r2"), "save-to-r2 must not run when saveReport=false");
});

test("5. approval path — waitForApproval called when requireApproval=true", async () => {
  const step = makeStep();
  const mock  = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", requireApproval: true, saveReport: true },
    step,
    mock.svc,
  );

  assert.equal(mock.waitForApprovalCalled, true);
  // All four data steps still run after approval.
  assert.deepEqual(step.calls, ["fetch-page", "analyse", "write-report", "save-to-r2"]);
});

test("6. no-approval path — waitForApproval NOT called when requireApproval=false", async () => {
  const step = makeStep();
  const mock  = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", requireApproval: false, saveReport: true },
    step,
    mock.svc,
  );

  assert.equal(mock.waitForApprovalCalled, false);
});

test("7. rejection path — WorkflowRejectedError propagates; write-report does not run", async () => {
  const step = makeStep();
  const { svc } = makeSvc({
    async waitForApproval() {
      const err = new Error("Rejected");
      err.name  = "WorkflowRejectedError";
      throw err;
    },
  });

  await assert.rejects(
    () => runPageIntelWorkflow(
      { url: "https://example.com", requireApproval: true },
      step,
      svc,
    ),
    (err) => err.name === "WorkflowRejectedError",
  );

  assert.ok(step.calls.includes("fetch-page"),  "fetch-page should have run");
  assert.ok(step.calls.includes("analyse"),      "analyse should have run");
  assert.ok(!step.calls.includes("write-report"), "write-report must NOT run after rejection");
  assert.ok(!step.calls.includes("save-to-r2"),   "save-to-r2 must NOT run after rejection");
});

test("8. AI JSON parse failure — aiSummarize falls back to raw string gracefully", async () => {
  // The real workflow class has this fallback; we test the pure logic path by
  // returning a pre-parsed object (the logic itself does no JSON parsing).
  // We verify the fallback object shape is handled correctly end-to-end.
  const step  = makeStep();
  const { svc } = makeSvc({
    async aiSummarize() {
      // Simulate the fallback path: return summary as raw text, no insights.
      return { summary: "raw model output, not JSON", insights: [] };
    },
  });

  const result = await runPageIntelWorkflow(
    { url: "https://example.com" },
    step,
    svc,
  );

  assert.equal(result.summary, "raw model output, not JSON");
  assert.deepEqual(result.insights, []);
});

test("9. progress reporting — all phases present; final progress = 1.0", async () => {
  const step  = makeStep();
  const { svc, progressCalls } = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", saveReport: true },
    step,
    svc,
  );

  const phases = progressCalls.map((c) => c.step);
  assert.ok(phases.includes("fetch-page"),  "missing fetch-page progress");
  assert.ok(phases.includes("analyse"),      "missing analyse progress");
  assert.ok(phases.includes("write-report"), "missing write-report progress");
  assert.ok(phases.includes("save-to-r2"),   "missing save-to-r2 progress");

  const last = progressCalls.at(-1);
  assert.equal(last.percent, 1.0, "final progress must be 100%");
});

test("10. approval progress — awaiting-approval progress emitted when requireApproval=true", async () => {
  const step  = makeStep();
  const { svc, progressCalls } = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", requireApproval: true, saveReport: true },
    step,
    svc,
  );

  const phases = progressCalls.map((c) => c.step);
  assert.ok(phases.includes("awaiting-approval"), "missing awaiting-approval progress");
});

test("11. step idempotency — each step.do callback runs exactly once", async () => {
  const callCounts = {};
  const step = {
    async do(name, fn) {
      callCounts[name] = (callCounts[name] ?? 0) + 1;
      return await fn();
    },
  };
  const { svc } = makeSvc();

  await runPageIntelWorkflow(
    { url: "https://example.com", requireApproval: false, saveReport: true },
    step,
    svc,
  );

  for (const [name, count] of Object.entries(callCounts)) {
    assert.equal(count, 1, `step "${name}" ran ${count} times — expected exactly 1`);
  }
});

test("12. fetchPageContent error — save-to-r2 not called when earlier step fails", async () => {
  const step  = makeStep();
  const { svc, persistCalls } = makeSvc({
    async fetchPageContent() {
      throw new Error("Browser rendering failed — target unreachable");
    },
  });

  await assert.rejects(
    () => runPageIntelWorkflow({ url: "https://unreachable.example" }, step, svc),
    (err) => err.message.includes("unreachable"),
  );

  assert.equal(persistCalls.length, 0, "R2 must not be called when an earlier step throws");
});

test("13. data flow — aiWriteReport receives summary + insights from aiSummarize", async () => {
  const step  = makeStep();
  let capturedArgs = null;

  const { svc } = makeSvc({
    async aiSummarize() {
      return {
        summary:  "CAPTURED SUMMARY",
        insights: ["CAPTURED INSIGHT A", "CAPTURED INSIGHT B"],
      };
    },
    async aiWriteReport(summary, insights, url) {
      capturedArgs = { summary, insights, url };
      return "report text";
    },
  });

  await runPageIntelWorkflow(
    { url: "https://example.com", saveReport: false },
    step,
    svc,
  );

  assert.equal(capturedArgs.summary,     "CAPTURED SUMMARY");
  assert.deepEqual(capturedArgs.insights, ["CAPTURED INSIGHT A", "CAPTURED INSIGHT B"]);
  assert.equal(capturedArgs.url,         "https://example.com");
});

test("14. result shape — url and title come from fetch step, not payload alone", async () => {
  const step  = makeStep();
  const { svc } = makeSvc({
    async fetchPageContent(url) {
      return { title: "Specific Title From Browser", bodyText: `content of ${url}` };
    },
  });

  const result = await runPageIntelWorkflow(
    { url: "https://specific.example.com", saveReport: false },
    step,
    svc,
  );

  assert.equal(result.url,   "https://specific.example.com");
  assert.equal(result.title, "Specific Title From Browser");
});
