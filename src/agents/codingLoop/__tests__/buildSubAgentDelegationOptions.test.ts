import assert from "node:assert/strict";
import test from "node:test";
import type { CodingCollaborationLoopHost } from "../codingLoopTypes";
import { buildSubAgentDelegationOptions } from "../runCodingCollaborationLoop";

const mockHost: CodingCollaborationLoopHost = {
  loopRunId: "loop-run-1",
  parentRequestId: "parent-1",
  delegateToCoder: async () => ({ ok: true, text: "", events: [] }),
  delegateToTester: async () => ({ ok: true, text: "", events: [] }),
  getOrchestratorGateway: () => null,
  log: () => {},
};

test("buildSubAgentDelegationOptions: stateful orchestration omits statelessSubAgentModelTurn", () => {
  const o = buildSubAgentDelegationOptions(
    mockHost,
    {
      sharedProjectId: "proj",
      task: "t",
      statelessSubAgentModelTurn: false,
    },
    "iter-1",
    "coder"
  );
  assert.equal(o.statelessSubAgentModelTurn, undefined);
});

test("buildSubAgentDelegationOptions: MainAgent-style undefined still omits stateless flag", () => {
  const o = buildSubAgentDelegationOptions(
    mockHost,
    { sharedProjectId: "proj", task: "t" },
    "iter-1",
    "coder"
  );
  assert.equal(o.statelessSubAgentModelTurn, undefined);
});

test("buildSubAgentDelegationOptions: stateless turn passes statelessSubAgentModelTurn:true", () => {
  const o = buildSubAgentDelegationOptions(
    mockHost,
    {
      sharedProjectId: "proj",
      task: "t",
      statelessSubAgentModelTurn: true,
    },
    "iter-1",
    "coder"
  );
  assert.equal(o.statelessSubAgentModelTurn, true);
});
