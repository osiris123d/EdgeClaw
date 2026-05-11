import assert from "node:assert/strict";
import test from "node:test";
import {
  delegateToolTaskKindToWorkload,
  formatDelegateToolAgentMessage,
} from "../formatDelegateToolAgentMessage";

test("delegateToolTaskKindToWorkload maps unknown to tool_orchestration", () => {
  assert.equal(delegateToolTaskKindToWorkload("unknown"), "tool_orchestration");
  assert.equal(delegateToolTaskKindToWorkload("mcp_api"), "mcp_api");
});

test("formatDelegateToolAgentMessage emits workload marker and delegation policy line", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest: "List repos via MCP",
    taskKind: "external_api",
  });
  assert.ok(out.startsWith("[[edgeclaw:tool-task-kind=external_api]]"));
  assert.ok(out.includes("**Delegation policy"));
  assert.ok(out.includes("**User request**"));
  assert.ok(out.includes("List repos via MCP"));
});

test("formatDelegateToolAgentMessage includes skill and constraints when present", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest: "do thing",
    taskKind: "mcp_api",
    guidanceSkillKey: "my_skill",
    constraints: "read-only GET only",
  });
  assert.ok(out.includes("Optional guidance skill key"));
  assert.ok(out.includes("my_skill"));
  assert.ok(out.includes("Constraints"));
  assert.ok(out.includes("read-only GET only"));
});

test("formatDelegateToolAgentMessage includes preset Cloudflare account id when provided", () => {
  const id = "f8afd5d9155fc5142006c5acc3ad5a82";
  const out = formatDelegateToolAgentMessage({
    userRequest: "list scripts",
    taskKind: "mcp_api",
    cloudflareAccountId: id,
  });
  assert.ok(out.includes("**Cloudflare account (preset for MCP execute / codemode):**"));
  assert.ok(out.includes(id));
  assert.ok(out.includes("do not** ask the user for an account id"));
});
