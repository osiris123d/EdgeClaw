/**
 * Node-safe integration regression: failed `delegate_tool_task` (ToolAgent MCP bootstrap) must make the
 * turn terminal — same latch/guard/surface logic as {@link MainAgent} without instantiating Think.
 *
 * MainAgent cannot be loaded under `tsx`/Node (`@cloudflare/think` subpath exports). This test exercises
 * the extracted modules that MainAgent calls so behavior stays aligned with production.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import type { StepConfig } from "@cloudflare/think";
import { computeDelegateToolTaskTurnLatchesAndReply, isLikelyToolAgentMcpBootstrapFailureMessage } from "../delegateToolTaskTurnOutcome";
import {
  evaluateMainAgentDelegateBeforeToolCallDecision,
  mergeDelegationFailureTerminalStepConfig,
  mergeStepConfigFreezeToolsForDelegationTerminal,
} from "../mainAgentDelegateToolGuards";
import { buildDelegationToolAgentToolSurfaceFields } from "../mainAgentDelegationToolSurface";

const here = dirname(fileURLToPath(import.meta.url));

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

nodeTest("integration-style delegated ToolAgent failure visibility: envelope content + maxSteps=1 finalize wiring", () => {
  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "tool_orchestration",
    rpc: {
      ok: false,
      text: "",
      toolAgentResult: {
        ok: false,
        failure: {
          type: "too_much_data",
          where: "tools_call",
          summary: "ToolAgent response exceeded useful output limits and ended before final synthesis.",
          evidence: "TRUNCATED: Response was ~135000 tokens and hit output limit.",
          suggestedFix: "Narrow scope and request a compact summary with essential fields only.",
          suggestedRetryPrompt:
            "Retry delegated tool task. Keep objective unchanged, but fetch in pages and return concise summarized results only.",
        },
        partialResultText: "Partial findings: identified 12 candidate items and top 3 high-priority anomalies.",
      },
    },
  });

  assert.equal(latches.delegationTerminal, true);
  assert.equal(latches.delegationFailed, true);

  // Clear failure heading/body
  assert.ok(reply.startsWith("[delegate_tool_task] failed:"));
  assert.ok(reply.includes("ToolAgent could not complete the delegated task"));

  // Failure type or plain-language reason
  assert.ok(
    reply.includes("Failure type: too_much_data") ||
      /exceeded useful output limits|too much data|truncated/i.test(reply),
    "failure type or plain-language reason should be present"
  );

  // Required failure detail fields
  assert.ok(reply.includes("Where: tools_call"));
  assert.ok(reply.includes("Evidence: TRUNCATED:"));
  assert.ok(reply.includes("What to do next: Narrow scope"));
  assert.ok(reply.includes("Retry prompt:"));
  assert.ok(reply.includes("Retry delegated tool task."));
  assert.ok(reply.includes("Partial findings:"));
  assert.ok(reply.includes("identified 12 candidate items"));

  // maxSteps=1 / no-terminal-step finalize path wiring in MainAgent:
  // failure text is appended as a visible assistant message when result.message has no text.
  const mainSrc = readFileSync(join(here, "..", "MainAgent.ts"), "utf8");
  assert.match(mainSrc, /maybeInjectDelegateToolTaskFailureAssistantMessage/);
  assert.match(mainSrc, /await this\.maybeInjectDelegateToolTaskFailureAssistantMessage\(result\)/);
  assert.match(mainSrc, /if \(!this\._turnToolAgentDelegationFailed \|\| replyText\.length === 0\)/);
  assert.match(mainSrc, /existingText\.length > 0/);
  assert.match(mainSrc, /session\.appendMessage\(msg\)/);
});
