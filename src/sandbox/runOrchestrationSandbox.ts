/**
 * Dev harness: exercise {@link runCodingCollaborationLoop} with scripted coder/tester delegates
 * and in-memory shared workspace — same contract MainAgent uses, without Durable Objects or Workers.
 *
 * Run: `npm run sandbox:orchestration`
 */

import { runCodingCollaborationLoop } from "../agents/codingLoop/runCodingCollaborationLoop";
import type { CodingCollaborationLoopResult } from "../agents/codingLoop/codingLoopTypes";
import { createScriptedCodingCollaborationLoopHost } from "../agents/codingLoop/testFixtures/scriptedCodingLoopHost";
import { InMemorySharedWorkspaceStorage } from "../agents/codingLoop/testFixtures/inMemorySharedWorkspaceStorage";
import { SharedWorkspaceGateway } from "../workspace/sharedWorkspaceTypes";
import { SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID, seedOrchestrationMicroFixture } from "./orchestrationMicroFixture";

function summarizeLoopResult(r: CodingCollaborationLoopResult) {
  return {
    status: r.status,
    loopRunId: r.loopRunId,
    parentRequestId: r.parentRequestId,
    sharedProjectId: r.sharedProjectId,
    terminalIterationIndex: r.terminalIterationIndex,
    lastActivePatchIds: r.lastActivePatchIds,
    summaryForUser: r.summaryForUser,
    iterations: r.iterations.map((it) => ({
      iteration: it.iteration,
      subAgentSuffix: it.subAgentSuffix,
      newPendingPatchIds: it.newPendingPatchIds,
      pendingPatchIdsAfterCoder: it.pendingPatchIdsAfterCoder,
      activePatchIdsForIteration: it.activePatchIdsForIteration,
      testerVerdict: it.testerVerdict,
      testerVerdictScope: it.testerVerdictScope,
      managerDecision: it.managerDecision,
      revisionReasonCategory: it.revisionReasonCategory,
      coderSummary: it.coderSummary,
      testerSummary: it.testerSummary,
    })),
  };
}

async function runScenario(
  name: string,
  task: string,
  iterations: Parameters<typeof createScriptedCodingCollaborationLoopHost>[0]["iterations"]
): Promise<void> {
  const storage = new InMemorySharedWorkspaceStorage();
  await seedOrchestrationMicroFixture(storage);
  const gateway = new SharedWorkspaceGateway(storage);
  const logSink: string[] = [];
  const host = createScriptedCodingCollaborationLoopHost({
    loopRunId: `sandbox-orchestration-${name}`,
    parentRequestId: `sandbox-parent-${name}`,
    sharedProjectId: SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID,
    gateway,
    iterations,
    logSink,
  });

  const result = await runCodingCollaborationLoop(host, {
    sharedProjectId: SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID,
    task,
    maxIterations: 5,
    autoApplyVerifiedPatches: true,
    scopeTesterToNewPatchesOnly: true,
  });

  console.log(`\n=== scenario: ${name} ===`);
  console.log(JSON.stringify({ task, ...summarizeLoopResult(result), hostLogLines: logSink }, null, 2));
}

async function main(): Promise<void> {
  console.log(
    "Orchestration sandbox (scripted coder/tester + in-memory gateway). " +
      `Project id: ${SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID}`
  );

  await runScenario(
    "simple_success",
    "Add one pending patch and have the tester approve it.",
    {
      1: {
        coder: { addPatches: [{ patchId: "patch-success-1", body: "--- success diff ---\n" }] },
        tester: { verdict: "pass", preamble: "Looks good for the scoped patch." },
      },
    }
  );

  await runScenario(
    "fail_then_revise",
    "First patch fails review; second iteration adds a revised patch that passes.",
    {
      1: {
        coder: { addPatches: [{ patchId: "patch-revise-1", body: "--- broken ---\n" }] },
        tester: { verdict: "fail", preamble: "Missing tests / incomplete." },
      },
      2: {
        coder: { addPatches: [{ patchId: "patch-revise-2", body: "--- fixed ---\n" }] },
        tester: { verdict: "pass", preamble: "Revised patch addresses feedback." },
      },
    }
  );

  await runScenario(
    "permission_boundary",
    "Iteration 1: coder attempts a non-staging write (gateway blocks). Iteration 2: valid patch under policy.",
    {
      1: {
        coder: {
          illegalCoderWrites: [{ relativePath: "src/outside-staging.ts" }],
          addPatches: [],
        },
        tester: { verdict: "fail", preamble: "No valid pending patch to verify." },
      },
      2: {
        coder: { addPatches: [{ patchId: "patch-after-boundary", body: "--- allowed patch ---\n" }] },
        tester: { verdict: "pass", preamble: "Valid patch only after policy-respecting handoff." },
      },
    }
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
