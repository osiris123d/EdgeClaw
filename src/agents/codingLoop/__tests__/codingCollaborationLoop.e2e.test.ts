/**
 * End-to-end tests for {@link runCodingCollaborationLoop} using scripted delegates + in-memory storage.
 *
 * Run: `npm run test:coding-loop-e2e` (uses `tsx` so Node can resolve extensionless TypeScript imports).
 * Type-check subset (excludes MainAgent): `npm run type-check:coding-loop`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SharedWorkspaceGateway } from "../../../workspace/sharedWorkspaceTypes";
import { runCodingCollaborationLoop } from "../runCodingCollaborationLoop";
import { InMemorySharedWorkspaceStorage } from "../testFixtures/inMemorySharedWorkspaceStorage";
import {
  createScriptedCodingCollaborationLoopHost,
  parseIterationFromOptions,
} from "../testFixtures/scriptedCodingLoopHost";

const PROJECT = "e2e-proj";
const LOOP_RUN = "loop-run-e2e";
const PARENT = "parent-req";

async function expectPatchStatus(
  gateway: SharedWorkspaceGateway,
  patchId: string,
  expected: "pending" | "approved" | "applied" | "rejected"
): Promise<void> {
  const r = await gateway.getPatchProposal("orchestrator", PROJECT, patchId);
  if ("error" in r) {
    assert.fail(`expected patch ${patchId}: ${r.error}`);
  }
  assert.equal(r.record.status, expected);
}

function gatewayFixture(): { gateway: SharedWorkspaceGateway; storage: InMemorySharedWorkspaceStorage } {
  const storage = new InMemorySharedWorkspaceStorage();
  const gateway = new SharedWorkspaceGateway(storage);
  return { gateway, storage };
}

test("parseIterationFromOptions reads -i suffix", () => {
  assert.equal(parseIterationFromOptions({ subAgentInstanceSuffix: `${LOOP_RUN}-i3` }), 3);
});

test("e2e: PASS on first iteration applies scoped patches when autoApplyVerifiedPatches", async () => {
  const { gateway } = gatewayFixture();
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "p-first", body: "diff1" }] },
        tester: { verdict: "pass", preamble: "OK" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Implement feature X",
    maxIterations: 5,
    autoApplyVerifiedPatches: true,
  });

  assert.equal(result.status, "completed_success");
  assert.equal(result.iterations.length, 1);
  await expectPatchStatus(gateway, "p-first", "applied");
});

test("e2e: FAIL then PASS completes and applies on later iteration", async () => {
  const { gateway } = gatewayFixture();
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "p1" }] },
        tester: { verdict: "fail", preamble: "BLOCKER_ONE" },
      },
      2: {
        coder: { addPatches: [] },
        tester: { verdict: "pass", preamble: "Fixed" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 5,
    autoApplyVerifiedPatches: true,
    scopeTesterToNewPatchesOnly: true,
  });

  assert.equal(result.status, "completed_success");
  await expectPatchStatus(gateway, "p1", "applied");
});

test("e2e: repeated identical tester failures stop", async () => {
  const { gateway } = gatewayFixture();
  const sharedPreamble = "SAME_ROOT_CAUSE_SIGMA";
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "p-rf" }] },
        tester: { verdict: "fail", preamble: sharedPreamble },
      },
      2: {
        coder: { addPatches: [] },
        tester: { verdict: "fail", preamble: sharedPreamble },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 5,
    stopOnRepeatedIdenticalFailures: true,
  });

  assert.equal(result.status, "stopped_repeated_failure");
  assert.equal(result.iterations.length, 2);
  await expectPatchStatus(gateway, "p-rf", "pending");
});

test("e2e: stop when no new patches (iteration >= 2)", async () => {
  const { gateway } = gatewayFixture();
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "p-only" }] },
        tester: { verdict: "fail", preamble: "need work" },
      },
      2: {
        coder: { addPatches: [] },
        tester: { verdict: "pass", preamble: "unexpected" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 5,
    stopOnNoNewPatches: true,
  });

  assert.equal(result.status, "stopped_no_new_patches");
  assert.equal(result.iterations[1].coderSummary.ok, true);
  assert.equal(result.iterations[1].testerSummary.textLen, 0);
});

test("e2e: stale pending excluded from approve/apply when applyAllPendingOnPass", async () => {
  const { gateway, storage } = gatewayFixture();
  storage.seedPendingPatch(PROJECT, "old", "legacy diff");
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [] },
        tester: { verdict: "fail", preamble: "wait" },
      },
      2: {
        coder: { addPatches: [{ patchId: "fresh", body: "new diff" }] },
        tester: { verdict: "fail", preamble: "still bad" },
      },
      3: {
        coder: { addPatches: [] },
        tester: { verdict: "pass", preamble: "done" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 5,
    autoApplyVerifiedPatches: true,
    applyAllPendingOnPass: true,
    stalePatchIterationThreshold: 2,
  });

  assert.equal(result.status, "completed_success");
  await expectPatchStatus(gateway, "fresh", "applied");
  await expectPatchStatus(gateway, "old", "pending");
});

test("e2e: focusPatchIds scopes active verification ids", async () => {
  const { gateway, storage } = gatewayFixture();
  storage.seedPendingPatch(PROJECT, "p-a", "a");
  storage.seedPendingPatch(PROJECT, "p-b", "b");
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [] },
        tester: { verdict: "fail", preamble: "scoped" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 1,
    focusPatchIds: ["p-b"],
    scopeTesterToNewPatchesOnly: true,
  });

  assert.deepEqual(result.iterations[0].activePatchIdsForIteration, ["p-b"]);
  assert.equal(result.status, "stopped_max_iterations");
});

test("e2e: autoApproveOnPass without apply leaves approved not applied", async () => {
  const { gateway } = gatewayFixture();
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "approve-only" }] },
        tester: { verdict: "pass", preamble: "LGTM" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 3,
    autoApproveOnPass: true,
    autoApplyVerifiedPatches: false,
  });

  assert.equal(result.status, "completed_success");
  assert.ok(result.summaryForUser.includes("Approved (not applied)"));
  await expectPatchStatus(gateway, "approve-only", "approved");
});

test("e2e: needs_user_approval when orchestrator does not auto-approve or apply", async () => {
  const { gateway } = gatewayFixture();
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: LOOP_RUN,
    parentRequestId: PARENT,
    sharedProjectId: PROJECT,
    gateway,
    iterations: {
      1: {
        coder: { addPatches: [{ patchId: "manual-gate" }] },
        tester: { verdict: "pass", preamble: "Ship it" },
      },
    },
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: PROJECT,
    task: "Task",
    maxIterations: 3,
    autoApproveOnPass: false,
    autoApplyVerifiedPatches: false,
    exitOnPassWithoutAutoApply: true,
  });

  assert.equal(result.status, "needs_user_approval");
  await expectPatchStatus(gateway, "manual-gate", "pending");
});
