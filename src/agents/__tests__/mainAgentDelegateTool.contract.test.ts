/**
 * Structural contract checks for MainAgent `delegate_tool_task` wiring (no full DO construction).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("MainAgent.ts defines delegate_tool_task and delegateToToolAgent", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const surfacePath = join(here, "..", "mainAgentDelegationToolSurface.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  const surfaceSrc = readFileSync(surfacePath, "utf8");
  assert.ok(/\bdelegate_tool_task\b/.test(mainSrc), "delegate_tool_task tool");
  assert.ok(/\bdelegateToToolAgent\b/.test(mainSrc), "delegateToToolAgent()");
  assert.match(mainSrc, /\bawait import\(["']\.\/subagents\/ToolAgent["']\)/);
  assert.match(mainSrc, /\brpcSyncMcpConfigFromMainAgent\b/, "MCP mirror RPC before ToolAgent turn");
  assert.match(mainSrc, /\bshouldReuseLiveMcpSdkServer\b/, "live MCP SDK reuse gate for delegation mirror");
  assert.match(mainSrc, /\bbuildMcpMirrorToolDescriptors\b/, "snapshot parent wrapped MCP tools for ToolAgent mirrors");
  assert.match(mainSrc, /\bdelegatedParentAgentName:\s*this\.name\b/, "ToolAgent RPC forward resolves parent DO");
  assert.match(mainSrc, /\bmcpMirrorToolDescriptors\b/, "mirror descriptors cross RPC with server rows");
  assert.match(mainSrc, /\bmergePersistedMcpServersWithDiscoverySnapshot\b/, "delegation sends live MCP auth hints");
  assert.match(mainSrc, /\boauthCallbackHost\b/, "pass OAuth callback origin into ToolAgent MCP sync");
  assert.match(mainSrc, /\bsyncResult\.ok === false\b/, "abort delegation when ToolAgent MCP sync fails");
  assert.match(mainSrc, /\b_turnToolAgentDelegationTerminal\b/, "terminal delegation latch");
  assert.match(mainSrc, /\b_turnToolAgentDelegationFailed\b/, "delegate failure latch blocks follow-up tools");
  assert.match(mainSrc, /\b_turnToolAgentBootstrapFailed\b/, "MCP bootstrap failure telemetry latch");
  assert.match(mainSrc, /\bcomputeDelegateToolTaskTurnLatchesAndReply\b/, "delegation outcome routed through shared module");
  assert.match(mainSrc, /\braceToolAgentDelegationRpc\b/, "delegate_to_tool bounded wait on child rpcCollectChatTurn");
  assert.match(mainSrc, /\bresolveToolAgentDelegationTimeoutMs\b/, "delegation timeout resolved from env Variables");
  assert.match(mainSrc, /\bmergeStepConfigFreezeToolsForDelegationTerminal\b/, "beforeStep terminal freeze helper");
  assert.match(mainSrc, /\bevaluateMainAgentDelegateBeforeToolCallDecision\b/, "beforeToolCall delegate guards");
  assert.match(surfaceSrc, /\btoolAgentBootstrapFailed\b/, "telemetry: toolAgentBootstrapFailed");
  assert.match(surfaceSrc, /\btoolAgentTerminal\b/, "telemetry: toolAgentTerminal");
});

test("delegateToToolAgent reaches ToolAgent rpcCollectChatTurn after MCP sync (successful sync → child LLM)", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(
    mainSrc,
    /async delegateToToolAgent\([\s\S]*?rpcSyncMcpConfigFromMainAgent[\s\S]*?\bstub\.rpcCollectChatTurn\b/s,
    "child chat turn follows MCP mirror RPC inside delegateToToolAgent"
  );
  assert.match(mainSrc, /\brpcExecuteDelegatedMcpTool\b/, "MainAgent exposes MCP execute RPC for live mirrors");
});

test("MainAgent retains established orchestration/browser tool wiring", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.ok(/\blist_workflows\b/.test(src));
  assert.ok(/\brun_workflow\b/.test(src));
  assert.ok(/\bcreateAgentTools\b/.test(src), "base domain tools bundle (tasks, notes, …)");
  assert.ok(/browser_search/.test(src) || /createAgentBrowserTools/.test(src));
});

test("Avoid static ES import of ToolAgent (dynamic import keeps graph lean)", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.ok(
    !/\bfrom\s+["']\.\/subagents\/ToolAgent["']/.test(src),
    "no `from ./subagents/ToolAgent`"
  );
});

test("Failed delegate_tool_task uses terminal latch, visible failure prefix, and beforeStep tool freeze", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const outcomePath = join(here, "..", "delegateToolTaskTurnOutcome.ts");
  const guardsPath = join(here, "..", "mainAgentDelegateToolGuards.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  const outcomeSrc = readFileSync(outcomePath, "utf8");
  const guardsSrc = readFileSync(guardsPath, "utf8");
  assert.match(
    outcomeSrc,
    /\[delegate_tool_task\] failed:/,
    "failure replies start with [delegate_tool_task] failed: for downstream latch semantics"
  );
  assert.match(
    mainSrc,
    /_turnToolAgentDelegateFailureExactReply/,
    "store exact delegate_tool_task failure text for deterministic final step"
  );
  assert.match(
    mainSrc,
    /\bmergeDelegationFailureTerminalStepConfig\b/,
    "failed delegation forces guard model on next prepareStep"
  );
  assert.match(
    mainSrc,
    /if\s*\(\s*\n\s*this\._turnToolAgentDelegationFailed\s*&&[\s\S]*?_turnToolAgentDelegateFailureExactReply\.trim/s,
    "beforeStep prefers delegate failure deterministic completion ahead of success-terminal freeze"
  );
  assert.match(
    guardsSrc,
    /activeTools:\s*\[\s*\],\s*\n\s*toolChoice:\s*["']none["']/,
    "terminal delegation clears activeTools and forces toolChoice none"
  );
  assert.match(
    mainSrc,
    /_turnToolAgentDelegationTerminal\s*=\s*latches\.delegationTerminal[\s\S]*?_turnToolAgentDelegationFailed\s*=\s*latches\.delegationFailed/s,
    "failed delegation applies terminal + failure latches from shared outcome"
  );
});

test("explicit ToolAgent delegation gate: forced tool choice, gateway logs, and required-tool violation UI", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(mainSrc, /this\._turnDelegateGateStrictToolCall\s*=\s*true/, "gate sets strict delegate flag");
  assert.match(mainSrc, /\[EdgeClaw\]\[delegate-gate-prepareStep\]/, "prepareStep coercion log");
  assert.match(mainSrc, /toolName:\s*["']delegate_tool_task["']/, "step-0 toolChoice pins delegate_tool_task");
  assert.match(mainSrc, /\[EdgeClaw\]\[delegate-gate-inference\]/, "per-step inference diag under gate");
  assert.match(mainSrc, /\[EdgeClaw\]\[delegate-gate-chat-response\]/, "chat-response diag under gate");
  assert.match(mainSrc, /\[EdgeClaw\]\[delegate-gate-violation\]/, "visible violation when zero tool calls + completed");
  assert.match(
    mainSrc,
    /delegate-gate-violation[\s\S]*?injectImmediateCodemodeAssistantMarkdown/s,
    "violation path injects user-visible assistant markdown"
  );
  assert.match(mainSrc, /\/webhook\/trigger-turn/, "onRequest handles Worker programmatic POST path");
});

test("delegate_tool_task success: onChatResponse injects visible assistant message when text is absent", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  // The method must exist and be called from onChatResponse.
  assert.match(
    src,
    /maybeInjectDelegateToolTaskSuccessAssistantMessage/,
    "finalization method exists"
  );
  assert.match(
    src,
    /await this\.maybeInjectDelegateToolTaskSuccessAssistantMessage\(result\)/,
    "method is awaited in onChatResponse"
  );
  // Must guard on _turnToolAgentDelegateOk to avoid injecting on failure or no-op turns.
  assert.match(
    src,
    /_turnToolAgentDelegateOk/,
    "injects only when delegate succeeded"
  );
  // Must check for existing visible text to prevent duplication.
  assert.match(
    src,
    /existingText\.length\s*>\s*0/,
    "deduplicates when assistant already has visible text"
  );
  // Must emit [EdgeClaw][delegate-finalize] logs.
  assert.match(src, /\[EdgeClaw\]\[delegate-finalize\]/, "delegate-finalize logs present");
  assert.match(src, /injectedVisibleAssistantMessage=yes/, "logs yes when injected");
  assert.match(src, /injectedVisibleAssistantMessage=no/, "logs no with reason when skipped");
  assert.match(src, /resultTextLength=/, "logs resultTextLength");
});

test("delegate_tool_task success finalization: does not modify ToolAgent, MCP, OpenAPI, or RPC files", () => {
  // Verify the only changed file for the finalization seam is MainAgent.ts.
  const guardedPaths = [
    join(here, "..", "subagents", "ToolAgentThinkFacet.ts"),
    join(here, "..", "subagents", "rpcCollectChatTurnShared.ts"),
    join(here, "../../tools/mcpLiveMirrorTools.ts"),
    join(here, "../../tools/codemodeRouterHelpers.ts"),
    join(here, "../../tools/codemodeOpenApiExecutionPlan.ts"),
  ];
  for (const p of guardedPaths) {
    const s = readFileSync(p, "utf8");
    assert.ok(
      !s.includes("maybeInjectDelegateToolTaskSuccessAssistantMessage"),
      `${p} must not reference the finalization helper`
    );
  }
});

test("delegate_tool_task empty result does not inject junk", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  // The guard must check resultTextLength === 0 / empty reply.
  assert.match(
    src,
    /resultTextLength\s*===\s*0|replyText\.length\s*===\s*0|resultTextLength === 0/,
    "empty reply short-circuits injection"
  );
});
