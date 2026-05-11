/**
 * Node-safe integration regression: failed `delegate_tool_task` (ToolAgent MCP bootstrap) must make the
 * turn terminal — same latch/guard/surface logic as {@link MainAgent} without instantiating Think.
 *
 * MainAgent cannot be loaded under `tsx`/Node (`@cloudflare/think` subpath exports). This test exercises
 * the extracted modules that MainAgent calls so behavior stays aligned with production.
 */

import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { StepConfig } from "@cloudflare/think";
import { computeDelegateToolTaskTurnLatchesAndReply, isLikelyToolAgentMcpBootstrapFailureMessage } from "../delegateToolTaskTurnOutcome";
import {
  evaluateMainAgentDelegateBeforeToolCallDecision,
  mergeDelegationFailureTerminalStepConfig,
  mergeStepConfigFreezeToolsForDelegationTerminal,
} from "../mainAgentDelegateToolGuards";
import { buildDelegationToolAgentToolSurfaceFields } from "../mainAgentDelegationToolSurface";

const MCP_SYNC_FAILURE =
  "ToolAgent MCP restore failed: Failed to connect to MCP server at https://mcp.cloudflare.com/mcp: OAuth configuration incomplete: missing authUrl";

nodeTest("failed delegate_tool_task (MCP bootstrap) — terminal latches, step freeze, tool blocks, telemetry", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: false, error: MCP_SYNC_FAILURE, text: "" },
  });

  assert.ok(
    reply.startsWith("[delegate_tool_task] failed:"),
    "tool result must use failure prefix for downstream semantics"
  );
  assert.match(reply, /missing authUrl/, "reply carries exact MCP bootstrap reason");
  assert.equal(latches.delegationTerminal, true);
  assert.equal(latches.delegationFailed, true);
  assert.equal(latches.bootstrapFailed, true);
  assert.ok(latches.bootstrapError.length > 0, "sanitized bootstrap error for telemetry");

  const frozen = mergeStepConfigFreezeToolsForDelegationTerminal({
    toolChoice: "required",
    activeTools: ["codemode", "delegate_tool_task"],
  } as unknown as StepConfig);
  assert.deepEqual(frozen.activeTools, []);
  assert.equal(frozen.toolChoice, "none");

  const blockedTools = [
    "codemode",
    "execute",
    "mcp_github_search",
    "openapi_widgets",
    "tool_cf_mcp_search",
    "tool_cf_mcp_execute",
  ] as const;
  for (const toolName of blockedTools) {
    const decision = evaluateMainAgentDelegateBeforeToolCallDecision(toolName, true, true);
    assert.equal(decision?.action, "block", `expected block for ${toolName}`);
  }

  const toolSurface = buildDelegationToolAgentToolSurfaceFields({
    delegatedToToolAgent: true,
    delegationMeta: { agent: "ToolAgent", task: "mcp_api" },
    delegateOk: false,
    delegationFailed: true,
    resultEmpty: false,
    delegationTerminal: true,
    orchestrationAfterDelegate: false,
    bootstrapFailed: true,
    bootstrapError: latches.bootstrapError,
  });
  assert.equal(toolSurface.toolAgentTerminal, true);
  assert.equal(toolSurface.toolAgentBootstrapFailed, true);
  assert.equal(toolSurface.delegatedToToolAgent, true);
  assert.deepEqual(toolSurface.toolAgentGateway, { agent: "ToolAgent", task: "mcp_api" });
});

nodeTest("successful delegation outcome still sets terminal latch without failure flags", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: true, text: "done" },
  });
  assert.equal(latches.delegationTerminal, true);
  assert.equal(latches.delegationFailed, false);
  assert.equal(latches.delegateOk, true);
  assert.equal(reply, "done");

  const codemodeBlocked = evaluateMainAgentDelegateBeforeToolCallDecision(
    "codemode",
    false,
    true
  );
  assert.equal(codemodeBlocked?.action, "block");

  const relayBlocked = evaluateMainAgentDelegateBeforeToolCallDecision(
    "tool_x_search",
    false,
    true
  );
  assert.equal(relayBlocked, undefined, "success terminal does not block tool_* relay tools");
});

nodeTest("bare OAuth missing authUrl is not MCP bootstrap classification", () => {
  assert.equal(
    isLikelyToolAgentMcpBootstrapFailureMessage("OAuth configuration incomplete: missing authUrl"),
    false
  );
});

nodeTest("ToolAgent-prefixed restore error stays bootstrap classification", () => {
  assert.ok(
    isLikelyToolAgentMcpBootstrapFailureMessage(
      "ToolAgent MCP restore failed: OAuth configuration incomplete: missing authUrl"
    )
  );
});

nodeTest("delegate failure with bare missing-authUrl uses generic latch copy", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: false, error: "OAuth configuration incomplete: missing authUrl", text: "" },
  });
  assert.equal(latches.bootstrapFailed, false);
  assert.match(reply, /\[delegate_tool_task\] failed: OAuth configuration incomplete/);
});

nodeTest("delegate failure terminal step config emits exact reply via deterministic model", async () => {
  const { reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: false, error: MCP_SYNC_FAILURE, text: "" },
  });
  assert.ok(reply.includes("[delegate_tool_task] failed:"));
  assert.match(reply, /No ToolAgent API call was made/);

  const cfg = mergeDelegationFailureTerminalStepConfig(
    { toolChoice: "required", activeTools: ["codemode", "delegate_tool_task"] } as unknown as StepConfig,
    reply
  );
  assert.deepEqual(cfg.activeTools, []);
  assert.equal(cfg.toolChoice, "none");
  const lm = cfg.model as unknown as {
    doGenerate: (opts?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
  const gen = await lm.doGenerate({});
  const text = gen.content.find((c) => c.type === "text")?.text ?? "";
  assert.equal(text, reply);
});

nodeTest("MCP bootstrap delegate failure reply is not a success template (stable copy for final step)", () => {
  const { reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: false, error: MCP_SYNC_FAILURE, text: "" },
  });
  const bannedSuccessPhrases = [
    "Resolved:",
    "Execution returned successfully",
    "| Method |",
    "GET /accounts",
    "Workers scripts were listed",
  ];
  for (const phrase of bannedSuccessPhrases) {
    assert.ok(
      !reply.includes(phrase),
      `delegate failure reply must not contain invented success marker: ${phrase}`
    );
  }
  assert.ok(reply.includes("MCP bootstrap") || reply.includes("MCP restore"));
});
