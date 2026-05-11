import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import { prepareToolAgentRpcIngress } from "../subagents/toolAgentRpcIngress";

test("prepareToolAgentRpcIngress strips workload line and attaches ToolAgent observability", () => {
  const env = {} as Env;
  const prepared = prepareToolAgentRpcIngress(
    env,
    `[[edgeclaw:tool-task-kind=mcp_api]]\nx`
  );

  assert.equal(prepared.inferenceMessageTrimmed, "x");
  assert.equal(prepared.delegationGatewayObs.agent, "ToolAgent");
  assert.equal(prepared.delegationGatewayObs.taskId, "mcp_api");
});
