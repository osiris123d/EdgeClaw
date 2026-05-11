/**
 * Observability ingress for ToolAgent — no Workers runtime.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAiGatewayMetadataRecord,
  edgeClawGatewayAgentFromConstructorName,
  gatewayObservabilityForToolAgentMessage,
} from "../agentObservability";

test("gateway constructor mapping includes ToolAgent", () => {
  assert.equal(edgeClawGatewayAgentFromConstructorName("ToolAgent"), "ToolAgent");
});

test("gateway metadata uses agent ToolAgent plus workload classification in task slot", () => {
  const obs = gatewayObservabilityForToolAgentMessage(
    `[EdgeClawSharedWorkspace]{\"projectId\":\"proj-abc\",\"role\":\"coder\",\"taskId\":\"t-42\"}[/EdgeClawSharedWorkspace]\ndo things`,
    "external_api"
  );
  assert.equal(obs.agent, "ToolAgent");
  assert.equal(obs.taskId, "external_api");
  assert.equal(obs.projectId, "proj-abc");
  assert.equal(obs.runId, "t-42");

  const record = buildAiGatewayMetadataRecord({ ...obs, worker: "EdgeClaw" });
  assert.equal(record.agent, "ToolAgent");
  assert.equal(record.task, "external_api");
  assert.equal(record.project, "proj-abc");
  assert.equal(record.run, "t-42");
});

test("ToolAgent metadata.task mirrors each canonical workload kind", () => {
  for (const kind of ["mcp_api", "external_api", "tool_orchestration"] as const) {
    const obs = gatewayObservabilityForToolAgentMessage("plain user text", kind);
    assert.equal(obs.agent, "ToolAgent");
    assert.equal(obs.taskId, kind);
    const record = buildAiGatewayMetadataRecord({ ...obs, worker: "EdgeClaw" });
    assert.equal(record.task, kind);
  }
});
