import assert from "node:assert/strict";
import test from "node:test";
import {
  peelToolAgentWorkloadKindLeadLine,
  normalizeToolAgentWorkloadKind,
} from "../toolAgentWorkloadKind";

test("peel preserves message and defaults kind when absent", () => {
  const hello = peelToolAgentWorkloadKindLeadLine("Hello");
  assert.equal(hello.strippedMessage, "Hello");
  assert.equal(hello.kind, "tool_orchestration");
});

test("peel strips workload prefix and preserves envelope body", () => {
  const body = peelToolAgentWorkloadKindLeadLine(
    "[[edgeclaw:tool-task-kind=mcp_api]]\n[EdgeClawSharedWorkspace]{\"projectId\":\"p1\",\"role\":\"coder\"}[/EdgeClawSharedWorkspace]\ndo work"
  );
  assert.equal(body.kind, "mcp_api");
  assert.ok(body.strippedMessage.startsWith("[EdgeClawSharedWorkspace]"));
});

test("normalize invalid kinds falls back", () => {
  assert.equal(normalizeToolAgentWorkloadKind("bogus"), "tool_orchestration");
});
