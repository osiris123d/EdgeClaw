/**
 * Unit tests for the EdgeClaw research workflow business logic.
 *
 * Tests runResearchWorkflow() from researchWorkflowLogic.ts in pure Node.js.
 * No Cloudflare runtime, no wrangler, no network — fast and reliable.
 *
 * What is covered:
 *   - Happy path: all three steps execute and return expected shape
 *   - Default topic applied when topic is omitted
 *   - Custom topic carried through to the final result
 *   - Approval path: waitForApproval called when requireApproval = true
 *   - No-approval path: waitForApproval NOT called when requireApproval = false
 *   - Rejection path: WorkflowRejectedError propagates; synthesise step does not run
 *   - Progress reporting: reportProgress called for every phase
 *   - Step idempotency: each step.do callback runs exactly once per invocation
 *   - URL param: url is preserved in the initialise step output
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Import the pure logic file — no cloudflare: imports, works in plain Node.js.
const { runResearchWorkflow } = await import(
  "../dist/workflows/researchWorkflowLogic.js"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal step mock: runs each callback exactly once and records the name. */
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

/** Build callbacks mock for reportProgress + waitForApproval. */
function makeCallbacks({ approveOnWait = true } = {}) {
  const progressCalls = [];
  let waitForApprovalCalled = false;

  const callbacks = {
    async reportProgress(data) {
      progressCalls.push(data);
    },
    async waitForApproval(_step, _opts) {
      waitForApprovalCalled = true;
      if (!approveOnWait) {
        const err = new Error("Workflow rejected");
        err.name = "WorkflowRejectedError";
        throw err;
      }
    },
  };

  return {
    callbacks,
    progressCalls,
    get waitForApprovalCalled() { return waitForApprovalCalled; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("happy path — all three steps run and result has correct shape", async () => {
  const step   = makeStep();
  const { callbacks } = makeCallbacks();

  const result = await runResearchWorkflow(
    { topic: "AI in healthcare", requireApproval: false },
    step,
    callbacks,
  );

  assert.deepEqual(step.calls, ["initialise", "gather-sources", "synthesise"]);
  assert.equal(result.topic, "AI in healthcare");
  assert.equal(typeof result.completedAt, "string");
  assert.equal(typeof result.sourceCount, "number");
  assert.equal(typeof result.summary, "string");
});

test("default topic — 'general research' is used when topic is omitted", async () => {
  const step = makeStep();
  const { callbacks } = makeCallbacks();

  const result = await runResearchWorkflow({}, step, callbacks);

  assert.equal(result.topic, "general research");
});

test("custom topic — provided topic is carried through to the result", async () => {
  const step = makeStep();
  const { callbacks } = makeCallbacks();

  const result = await runResearchWorkflow(
    { topic: "quantum computing" },
    step,
    callbacks,
  );

  assert.equal(result.topic, "quantum computing");
});

test("approval path — waitForApproval is called when requireApproval = true", async () => {
  const step = makeStep();
  const mock = makeCallbacks({ approveOnWait: true });

  await runResearchWorkflow({ topic: "test", requireApproval: true }, step, mock.callbacks);

  // Read the getter AFTER the async call completes, not via destructuring.
  assert.equal(mock.waitForApprovalCalled, true);
  assert.deepEqual(step.calls, ["initialise", "gather-sources", "synthesise"]);
});

test("no-approval path — waitForApproval is NOT called when requireApproval = false", async () => {
  const step = makeStep();
  const mock = makeCallbacks();

  await runResearchWorkflow({ topic: "test", requireApproval: false }, step, mock.callbacks);

  assert.equal(mock.waitForApprovalCalled, false);
});

test("rejection path — WorkflowRejectedError propagates; synthesise step does not run", async () => {
  const step = makeStep();
  const { callbacks } = makeCallbacks({ approveOnWait: false });

  await assert.rejects(
    () => runResearchWorkflow({ topic: "test", requireApproval: true }, step, callbacks),
    (err) => err.name === "WorkflowRejectedError",
  );

  assert.ok(step.calls.includes("initialise"),     "initialise should have run");
  assert.ok(step.calls.includes("gather-sources"), "gather-sources should have run");
  assert.ok(!step.calls.includes("synthesise"),    "synthesise must NOT run after rejection");
});

test("progress reporting — reportProgress called for each phase in order", async () => {
  const step = makeStep();
  const { callbacks, progressCalls } = makeCallbacks();

  await runResearchWorkflow(
    { topic: "climate research", requireApproval: false },
    step,
    callbacks,
  );

  const phases = progressCalls.map((c) => c.step);
  assert.ok(phases.includes("initialise"),    "missing initialise progress");
  assert.ok(phases.includes("gather-sources"), "missing gather-sources progress");
  assert.ok(phases.includes("synthesise"),    "missing synthesise progress");

  const last = progressCalls.at(-1);
  assert.equal(last.percent, 1.0, "final progress call must be 100%");
});

test("approval progress — awaiting-approval progress called when requireApproval = true", async () => {
  const step = makeStep();
  const { callbacks, progressCalls } = makeCallbacks({ approveOnWait: true });

  await runResearchWorkflow({ topic: "test", requireApproval: true }, step, callbacks);

  const phases = progressCalls.map((c) => c.step);
  assert.ok(phases.includes("awaiting-approval"), "missing awaiting-approval progress");
});

test("step idempotency — each step.do callback runs exactly once", async () => {
  const callCounts = {};
  const step = {
    async do(name, fn) {
      callCounts[name] = (callCounts[name] ?? 0) + 1;
      return await fn();
    },
  };
  const { callbacks } = makeCallbacks();

  await runResearchWorkflow({ topic: "test", requireApproval: false }, step, callbacks);

  for (const [name, count] of Object.entries(callCounts)) {
    assert.equal(count, 1, `step "${name}" ran ${count} times, expected 1`);
  }
});

test("url param — url is preserved in the initialise step output", async () => {
  const capturedReturns = [];
  const step = {
    async do(name, fn) {
      const result = await fn();
      capturedReturns.push({ name, result });
      return result;
    },
  };
  const { callbacks } = makeCallbacks();

  await runResearchWorkflow(
    { topic: "test", url: "https://example.com", requireApproval: false },
    step,
    callbacks,
  );

  const initStep = capturedReturns.find((r) => r.name === "initialise");
  assert.equal(initStep?.result.url, "https://example.com");
});

test("url omitted — url defaults to null in the initialise step output", async () => {
  const capturedReturns = [];
  const step = {
    async do(name, fn) {
      const result = await fn();
      capturedReturns.push({ name, result });
      return result;
    },
  };
  const { callbacks } = makeCallbacks();

  await runResearchWorkflow({ topic: "test" }, step, callbacks);

  const initStep = capturedReturns.find((r) => r.name === "initialise");
  assert.equal(initStep?.result.url, null);
});
