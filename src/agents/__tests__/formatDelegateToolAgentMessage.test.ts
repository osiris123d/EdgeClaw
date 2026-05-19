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

test("formatDelegateToolAgentMessage labels runtime and target account roles separately", () => {
  const runtimeId = "f8afd5d9155fc5142006c5acc3ad5a82";
  const targetId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const out = formatDelegateToolAgentMessage({
    userRequest: "list scripts",
    taskKind: "mcp_api",
    runtimeAccountId: runtimeId,
    targetAccountId: targetId,
  });
  assert.ok(out.includes("**Cloudflare runtime account (AI Gateway / mirrored MCP execute context only):**"));
  assert.ok(out.includes(runtimeId));
  assert.ok(out.includes("runtime/AI-Gateway context only"));
  assert.ok(out.includes("**Target API account (from user request):**"));
  assert.ok(out.includes(targetId));
  assert.ok(out.includes("knownValues.account_id"));
  assert.ok(out.includes("do not ask for account id again"));
});

test("formatDelegateToolAgentMessage includes strict OpenAPI chain contract when explicitly requested", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest:
      "Use openapi_search then openapi_describe_operation then cloudflare_request to list WARP posture rules.",
    taskKind: "mcp_api",
  });

  assert.ok(out.includes("OpenAPI chain contract"));
  assert.ok(out.includes("openapi_search` -> `openapi_describe_operation` -> `cloudflare_request"));
  assert.ok(out.includes("Do not substitute `tools_call_code`"));
});

test("formatDelegateToolAgentMessage activates strict OpenAPI contract for search/describe wording cues", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest:
      "Use OpenAPI search/describe, then call only GET, verify describeStatus and describeStateKeys with invocationStoreId.",
    taskKind: "mcp_api",
  });

  assert.ok(out.includes("OpenAPI chain contract"));
  assert.ok(out.includes("openapi_search` -> `openapi_describe_operation` -> `cloudflare_request"));
});

test("formatDelegateToolAgentMessage requires GET-only + verification cues for natural-language strict contract", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest:
      "Use search/describe flow, then call only GET /accounts/{account_id}/gateway/rules and verify invocationStorePresent.",
    taskKind: "mcp_api",
  });

  assert.ok(out.includes("OpenAPI chain contract"));
});

test("formatDelegateToolAgentMessage does not activate strict contract when natural-language cues are incomplete", () => {
  const out = formatDelegateToolAgentMessage({
    userRequest: "Use OpenAPI search/describe for this issue.",
    taskKind: "mcp_api",
  });

  assert.ok(!out.includes("OpenAPI chain contract"));
});
