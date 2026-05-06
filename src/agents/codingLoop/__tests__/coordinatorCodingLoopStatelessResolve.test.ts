import assert from "node:assert/strict";
import test from "node:test";
import { coordinatorLoopEffectiveStatelessSubAgentModelTurn } from "../coordinatorCodingLoopStatelessResolve";

test("coordinator: omit stateless flag → stateful path (not forced stateless)", () => {
  assert.equal(
    coordinatorLoopEffectiveStatelessSubAgentModelTurn({
      sharedProjectId: "p",
      task: "t",
    }),
    false
  );
});

test("coordinator: explicit statelessSubAgentModelTurn:false is preserved (not upgraded to stateless)", () => {
  assert.equal(
    coordinatorLoopEffectiveStatelessSubAgentModelTurn({
      sharedProjectId: "p",
      task: "t",
      statelessSubAgentModelTurn: false,
    }),
    false
  );
});

test("coordinator: statelessSubAgentModelTurn:true uses stateless RPC", () => {
  assert.equal(
    coordinatorLoopEffectiveStatelessSubAgentModelTurn({
      sharedProjectId: "p",
      task: "t",
      statelessSubAgentModelTurn: true,
    }),
    true
  );
});
