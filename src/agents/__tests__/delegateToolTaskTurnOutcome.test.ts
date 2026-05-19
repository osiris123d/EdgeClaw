/**
 * Pure delegation outcome helpers — Node-safe.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDelegateToolTaskTurnLatchesAndReply,
  delegateSuccessReplyContainsForbiddenToolMarkup,
  formatDelegateToolTaskFakeToolMarkupFailureReply,
  raceToolAgentDelegationRpc,
  resolveToolAgentDelegationTimeoutMs,
  TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT,
  userAskedForLiteralToolCallMarkup,
} from "../delegateToolTaskTurnOutcome";

test("delegateSuccessReplyContainsForbiddenToolMarkup detects pseudo XML tool calls", () => {
  assert.equal(delegateSuccessReplyContainsForbiddenToolMarkup("ok"), false);
  assert.equal(
    delegateSuccessReplyContainsForbiddenToolMarkup('<tool_call name="x">'),
    true
  );
  assert.equal(delegateSuccessReplyContainsForbiddenToolMarkup("</tool_call>"), true);
  assert.equal(delegateSuccessReplyContainsForbiddenToolMarkup("<arg_key>"), true);
  assert.equal(delegateSuccessReplyContainsForbiddenToolMarkup("<arg_value>"), true);
});

test("computeDelegateToolTaskTurnLatchesAndReply: RPC ok but forbidden markup → failure latch + deterministic reply", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    userRequest: "list workers",
    rpc: { ok: true, text: '<tool_call name="tools_call_code">x</tool_call>' },
  });
  assert.equal(latches.delegationFailed, true);
  assert.equal(latches.delegateOk, false);
  assert.ok(reply.includes("[delegate_tool_task] failed"));
  assert.ok(reply.includes("<tool_call>"));
});

test("computeDelegateToolTaskTurnLatchesAndReply: allows markup when user explicitly requested literal tags", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    userRequest: 'Show an example line like <tool_call>foo</tool_call> in your answer',
    rpc: { ok: true, text: '<tool_call>foo</tool_call>' },
  });
  assert.equal(latches.delegationFailed, false);
  assert.equal(latches.delegateOk, true);
  assert.equal(reply.trim(), '<tool_call>foo</tool_call>');
});

test("userAskedForLiteralToolCallMarkup matches explicit tag mentions", () => {
  assert.equal(userAskedForLiteralToolCallMarkup("plain"), false);
  assert.equal(userAskedForLiteralToolCallMarkup("use <tool_call> syntax"), true);
});

test("formatDelegateToolTaskFakeToolMarkupFailureReply is stable", () => {
  const s = formatDelegateToolTaskFakeToolMarkupFailureReply();
  assert.ok(s.startsWith("[delegate_tool_task] failed"));
});

test("resolveToolAgentDelegationTimeoutMs clamps to bounds", () => {
  assert.equal(resolveToolAgentDelegationTimeoutMs(undefined), TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveToolAgentDelegationTimeoutMs({}), TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveToolAgentDelegationTimeoutMs({ TOOL_AGENT_DELEGATION_TIMEOUT_MS: "5000" }), 10_000);
  assert.equal(resolveToolAgentDelegationTimeoutMs({ TOOL_AGENT_DELEGATION_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(resolveToolAgentDelegationTimeoutMs({ TOOL_AGENT_DELEGATION_TIMEOUT_MS: "999999999" }), 3_600_000);
});

test("raceToolAgentDelegationRpc resolves with timeout-shaped SubAgentResult", async () => {
  const slow = new Promise<{ text: string; events: []; ok: boolean }>(() => {
    /* never resolves */
  });
  const out = await raceToolAgentDelegationRpc(slow as never, 15);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /^tool_agent_delegation_timeout_after_15_ms$/);
});

test("computeDelegateToolTaskTurnLatchesAndReply: timeout token → terminal failure copy", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: false, error: "tool_agent_delegation_timeout_after_120000_ms", text: "" },
  });
  assert.equal(latches.delegationFailed, true);
  assert.ok(reply.includes("timed out"));
  assert.ok(reply.includes("120000"));
});

test("computeDelegateToolTaskTurnLatchesAndReply: ToolAgent envelope failure is surfaced with retry prompt", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: {
      ok: false,
      text: "",
      toolAgentResult: {
        ok: false,
        failure: {
          type: "missing_tool_input",
          where: "tools_call",
          summary: "Required MCP input missing",
          evidence: "please specify account_id",
          suggestedFix: "Provide account_id",
          suggestedRetryPrompt: "Retry with explicit account_id.",
        },
        partialResultText: "Partial: discovered two candidate accounts.",
      },
    },
  });
  assert.equal(latches.delegationFailed, true);
  assert.ok(reply.includes("Failure type: missing_tool_input"));
  assert.ok(reply.includes("Where: tools_call"));
  assert.ok(reply.includes("Retry prompt:"));
  assert.ok(reply.includes("Partial findings:"));
});

test("computeDelegateToolTaskTurnLatchesAndReply: compact result with matchedCount injects visible reply when rpc text is empty", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: {
      ok: true,
      text: "",
      toolAgentResult: {
        ok: true,
        scannedCount: 30,
        matchedCount: 26,
        matched: Array.from({ length: 2 }, (_, i) => ({ rule_id: `rule-${i + 1}` })),
      },
    },
  });
  assert.equal(latches.delegateOk, true);
  assert.equal(latches.resultEmpty, false);
  assert.ok(reply.includes("Matched 26 of 30 scanned item(s)."));
  assert.ok(reply.includes("| rule id |"));
});

test("computeDelegateToolTaskTurnLatchesAndReply: compact matched rule_id/name renders table columns", () => {
  const { reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: {
      ok: true,
      text: "",
      toolAgentResult: {
        ok: true,
        scannedCount: 3,
        matchedCount: 2,
        matched: [
          { rule_id: "r-1", name: "Allow A" },
          { rule_id: "r-2", name: "Allow B" },
        ],
      },
    },
  });
  assert.ok(reply.includes("| rule id | rule name |"));
  assert.ok(reply.includes("Allow A"));
});
