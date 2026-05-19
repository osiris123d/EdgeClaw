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

test("delegate_tool_task wiring passes runtimeAccountId + targetAccountId to formatter", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(
    mainSrc,
    /const\s+runtimeAccountId\s*=\s*this\.resolveCloudflareAccountIdForRouter\(\)/,
    "runtime account resolved via router helper"
  );
  assert.match(
    mainSrc,
    /extractTargetAccountIdFromUserRequest\(args\.userRequest,\s*runtimeAccountId\)/,
    "target account extracted from user request with runtime exclusion"
  );
  assert.match(
    mainSrc,
    /formatDelegateToolAgentMessage\([\s\S]*?runtimeAccountId[\s\S]*?targetAccountId/s,
    "delegation message includes both runtime and target account ids"
  );
  const formatterCall = mainSrc.match(/formatDelegateToolAgentMessage\(\{[\s\S]*?\}\);/);
  assert.ok(formatterCall, "formatDelegateToolAgentMessage call exists");
  assert.ok(
    !/cloudflareAccountId\s*:/.test(formatterCall![0]),
    "legacy cloudflareAccountId formatter arg removed from formatter call"
  );
});

test("extractTargetAccountIdFromUserRequest includes required target/account_id patterns", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(mainSrc, /export function extractTargetAccountIdFromUserRequest\(/, "target extractor exported");
  assert.match(mainSrc, /target\\s\+account\[_\\s\]\?id\\s\*\[:=\]/, "matches target account_id and target account id");
  assert.match(mainSrc, /target\\s\+account\\s\*\[:=\]/, "matches target account: and target account=");
  assert.match(mainSrc, /account\[_\\s\]\?id\\s\*\[:=\]/, "matches account_id: and account_id=");
  assert.match(mainSrc, /\[a-f0-9\]\{32\}/, "extractor enforces 32-hex account id pattern");
  assert.match(mainSrc, /if \(runtime && raw === runtime\) continue;/, "runtime account excluded from target selection");
  assert.doesNotMatch(mainSrc, /\(\?<\!runtime\.\{0,20\}\)/, "no variable-length lookbehind in extractor");
  assert.match(mainSrc, /isTargetLabeled/, "extractor prioritizes explicit target-labeled candidates");
});

test("MainAgent default delegation path is deterministic direct execution", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(
    mainSrc,
    /if \(!this\.enableModelMediatedDelegateGate\)[\s\S]*?executeToolAgentDelegationDirectly\(\{[\s\S]*?taskKind[\s\S]*?\}\)/s,
    "beforeTurn uses direct delegation helper by default"
  );
  assert.match(mainSrc, /mode=deterministic_direct_delegation/, "direct path emits deterministic mode log");
  assert.match(mainSrc, /activeTools:\s*\[\],\s*[\s\S]*?toolChoice:\s*["']none["']/s, "direct path disables tools for final assistant response");
  assert.match(mainSrc, /model:\s*createDeterministicTextModel\(/, "direct path finalizes with deterministic text model");
});

test("legacy model-mediated delegation gate remains available behind feature flag", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(mainSrc, /enableModelMediatedDelegateGate/, "feature flag is wired in MainAgent");
  assert.match(mainSrc, /mode=model_mediated_delegate_gate/, "legacy path emits model-mediated mode log");
  assert.match(mainSrc, /this\._turnDelegateGateStrictToolCall\s*=\s*true/, "legacy path enables strict tool-call gate");
  assert.match(mainSrc, /activeTools:\s*\["delegate_tool_task"\]/, "legacy gate still forces delegate tool surface");
});

test("env/runtime config includes ENABLE_MODEL_MEDIATED_DELEGATE_GATE with false default", () => {
  const envPath = join(here, "..", "..", "lib", "env.ts");
  const envSrc = readFileSync(envPath, "utf8");
  assert.match(envSrc, /ENABLE_MODEL_MEDIATED_DELEGATE_GATE\?:\s*string;/, "Variables interface includes env key");
  assert.match(envSrc, /enableModelMediatedDelegateGate:\s*boolean;/, "RuntimeFeatureFlags includes parsed boolean");
  assert.match(
    envSrc,
    /enableModelMediatedDelegateGate:\s*parseBooleanFlag\([\s\S]*?ENABLE_MODEL_MEDIATED_DELEGATE_GATE[\s\S]*?,\s*false\s*\)/s,
    "runtime parser reads key with default false"
  );
});

test("delegate_tool_task.execute routes through direct delegation helper", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(
    mainSrc,
    /execute:\s*async\s*\([^)]*\):\s*Promise<string>\s*=>\s*\{\s*return agent\.executeToolAgentDelegationDirectly\(args\);\s*\}/s,
    "tool execute body delegates to shared helper"
  );
  assert.match(mainSrc, /private async executeToolAgentDelegationDirectly\(/, "shared helper is defined on MainAgent");
});

test("MCP/OpenAPI delegation gate keeps MainAgent off codemode and routes through delegate_tool_task path", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const guardsPath = join(here, "..", "mainAgentDelegateToolGuards.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  const guardsSrc = readFileSync(guardsPath, "utf8");

  assert.match(
    guardsSrc,
    /route_cue_trigger/,
    "delegation intent detector includes route-cue path for account_id/gateway rules style API tasks"
  );
  assert.ok(
    guardsSrc.includes("gateway") && guardsSrc.includes("rules"),
    "detector recognizes gateway/rules cues"
  );
  assert.ok(
    guardsSrc.includes("account") && guardsSrc.includes("id"),
    "detector recognizes account_id cues"
  );

  assert.match(
    mainSrc,
    /executeToolAgentDelegationDirectly\([\s\S]*?taskKind[\s\S]*?\)/,
    "delegation branch executes ToolAgent direct path for matched MCP/API intent"
  );
  assert.match(
    mainSrc,
    /mode=deterministic_direct_delegation/,
    "deterministic direct delegation remains the default behavior"
  );
  assert.match(
    mainSrc,
    /activeTools:\s*\[\s*\],\s*[\s\S]*?toolChoice:\s*["']none["']/s,
    "deterministic direct delegation hides MainAgent tool surface after delegation"
  );
  assert.match(
    mainSrc,
    /activeTools:\s*\["delegate_tool_task"\],\s*[\s\S]*?toolChoice:\s*"required"/s,
    "legacy model-mediated path keeps only delegate_tool_task visible"
  );
  const gateCfgMatch = mainSrc.match(
    /mode=model_mediated_delegate_gate[\s\S]*?return this\.finalizeBeforeTurnGatewayAuditAndFreeze\(thinkMergedTools, \{([\s\S]*?)\}\);/s
  );
  assert.ok(gateCfgMatch, "model-mediated delegation gate return config exists");
  const gateCfg = gateCfgMatch![1];
  assert.match(
    gateCfg,
    /activeTools:\s*\["delegate_tool_task"\]/,
    "beforeTurn returns activeTools exactly delegate_tool_task in model-mediated delegation gate"
  );
  assert.match(gateCfg, /toolChoice:\s*"required"/, "beforeTurn returns required toolChoice");
  assert.match(gateCfg, /maxSteps:\s*1/, "beforeTurn limits model-mediated delegation gate to one step");
  assert.doesNotMatch(gateCfg, /"codemode"|'codemode'|\bcodemode\b/, "MainAgent codemode is not visible in delegation-gated activeTools");
  assert.match(
    mainSrc,
    /do \*\*not\*\* use `codemode`, `execute`, or raw `tool_\*` MCP tools on MainAgent this turn/,
    "delegation gate explicitly forbids MainAgent codemode execution for delegated tasks"
  );
  assert.match(
    mainSrc,
    /must[\s\S]{0,80}call\s+this\s+tool[\s\S]*?do\s+not\s+run\s+`codemode`\s+or\s+MCP\s+mirror\s+tools\s+on\s+MainAgent/i,
    "delegate_tool_task contract text forbids direct MainAgent codemode for delegated requests"
  );
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

test("model-mediated ToolAgent delegation gate: forced tool choice, gateway logs, and required-tool violation UI", () => {
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
  assert.match(
    src,
    /_turnToolAgentDelegateSuccessAssistantInsertedOk/,
    "uses per-turn insertion latch to prevent duplicate assistant bubbles"
  );
  assert.match(
    src,
    /this\._turnToolAgentDelegateSuccessAssistantInsertedOk\s*=\s*true/,
    "success injection marks latch true after append/dedup"
  );
  assert.match(
    src,
    /shouldInjectVisibleAssistantMessage\(/,
    "success injection delegates latch + duplicate suppression to helper"
  );
  assert.match(
    src,
    /reason=\$\{existingText\.length > 0 \? "existing_visible_non_duplicate" : "maxSteps1_no_terminal_step"\}/,
    "non-duplicate existing preamble/status text still allows success injection"
  );
  assert.ok(
    !src.includes("existing_substantive_text"),
    "success injection no longer suppresses output for non-duplicate visible preamble/status text"
  );
  const helperPath = join(here, "..", "visibleAssistantInjectionHelper.ts");
  const helperSrc = readFileSync(helperPath, "utf8");
  assert.match(helperSrc, /already_injected_this_turn/, "helper reason includes latch suppression");
  // Must emit [EdgeClaw][delegate-finalize] logs.
  assert.match(src, /\[EdgeClaw\]\[delegate-finalize\]/, "delegate-finalize logs present");
  assert.match(src, /injectedVisibleAssistantMessage=yes/, "logs yes when injected");
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
  const helperPath = join(here, "..", "visibleAssistantInjectionHelper.ts");
  const helperSrc = readFileSync(helperPath, "utf8");
  assert.match(
    helperSrc,
    /trimmedReply\.length\s*===\s*0/,
    "helper treats empty reply text as a no-inject condition"
  );
  assert.match(
    helperSrc,
    /reason:\s*["']empty_reply_text["']/,
    "empty reply emits explicit no-inject reason"
  );
});

test("delegate_tool_task failure finalization: onChatResponse injects visible assistant message when text is absent", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(
    src,
    /maybeInjectDelegateToolTaskFailureAssistantMessage/,
    "failure finalization method exists"
  );
  assert.match(
    src,
    /await this\.maybeInjectDelegateToolTaskFailureAssistantMessage\(result\)/,
    "method is awaited in onChatResponse"
  );
  assert.match(
    src,
    /_turnToolAgentDelegationFailed/,
    "injects only when delegate failed"
  );
  assert.match(
    src,
    /_turnToolAgentDelegateFailureExactReply/,
    "uses deterministic failure reply text"
  );
  assert.match(
    src,
    /injectedVisibleAssistantMessage=yes/,
    "logs visible assistant insertion on failure path"
  );
});

test("delegate_tool_task failure finalization: honors latch and duplicate suppression", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  const helperPath = join(here, "..", "visibleAssistantInjectionHelper.ts");
  const helperSrc = readFileSync(helperPath, "utf8");

  // The failure injection method must exist
  assert.match(
    src,
    /private async maybeInjectDelegateToolTaskFailureAssistantMessage/,
    "failure injection method exists in MainAgent"
  );

  // Extract just the maybeInjectDelegateToolTaskFailureAssistantMessage method body
  // (between its declaration and the next private async method).
  const methodMatch = src.match(
    /private async maybeInjectDelegateToolTaskFailureAssistantMessage[\s\S]*?(?=private async maybe)/
  );
  assert.ok(methodMatch, "failure injection method body must be extractable from MainAgent.ts");
  const methodBody = methodMatch![0];

  // Failure method uses shared helper for latch + duplicate suppression semantics.
  assert.match(
    methodBody,
    /shouldInjectVisibleAssistantMessage\(/,
    "failure injection delegates suppression semantics to helper"
  );
  assert.match(
    helperSrc,
    /already_visible_exact_or_contained/,
    "duplicate suppression reason is available from helper"
  );
  assert.match(
    methodBody,
    /_turnToolAgentDelegateFailureAssistantInsertedOk/,
    "failure injection has per-turn insertion latch"
  );
  assert.match(
    methodBody,
    /this\._turnToolAgentDelegateFailureAssistantInsertedOk/,
    "failure injection reads/writes latch to avoid duplicate assistant bubbles"
  );

  // The success method must still have the existingText deduplication guard
  assert.match(
    src,
    /maybeInjectDelegateToolTaskSuccessAssistantMessage[\s\S]*?shouldInjectVisibleAssistantMessage\(/s,
    "success path also uses shared helper for suppression"
  );
});

test("delegate_tool_task failure injection logs no-inject reason for observability", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  const helperPath = join(here, "..", "visibleAssistantInjectionHelper.ts");
  const helperSrc = readFileSync(helperPath, "utf8");

  // Must log injectedVisibleAssistantMessage=no when skipping
  assert.match(
    src,
    /injectedVisibleAssistantMessage=no/,
    "logs no-injection marker when skipping failure injection"
  );

  // reason must include helper-driven skip conditions
  assert.match(
    src,
    /reason=\$\{injectResult\.reason\}/,
    "MainAgent logs helper-provided no-inject reason"
  );
  assert.match(
    helperSrc,
    /not_applicable/,
    "skip reason not_applicable is present in helper"
  );
  assert.match(
    helperSrc,
    /empty_reply_text/,
    "skip reason empty_reply_text is present in helper"
  );
  assert.match(
    helperSrc,
    /already_injected_this_turn/,
    "skip reason already_injected_this_turn is present in helper"
  );
});

test("delegate_tool_task failure + ok=false: computeDelegateToolTaskTurnLatchesAndReply sets delegationFailed=stop", () => {
  const outcomePath = join(here, "..", "delegateToolTaskTurnOutcome.ts");
  const src = readFileSync(outcomePath, "utf8");

  // The toolAgentResult.ok === false branch must exist
  assert.match(
    src,
    /rpc\.toolAgentResult\.ok === false/,
    "outcome module checks toolAgentResult.ok === false"
  );

  // delegationFailed must be set to stop when failure detected
  assert.match(
    src,
    /delegationFailed:\s*stop/,
    "delegationFailed is set to stop value on toolAgentResult failure"
  );

  // delegateToolTaskFailureShouldHardStopOrchestration must cover all task kinds
  assert.match(
    src,
    /mcp_api/,
    "delegateToolTaskFailureShouldHardStopOrchestration covers mcp_api"
  );
  assert.match(
    src,
    /external_api/,
    "delegateToolTaskFailureShouldHardStopOrchestration covers external_api"
  );
  assert.match(
    src,
    /tool_orchestration/,
    "delegateToolTaskFailureShouldHardStopOrchestration covers tool_orchestration"
  );
});

test("rpcExecuteDelegatedMcpTool healthy-path enter/recv/exit logs are gated behind isCodemodeWireDebugEnabled, not unconditional", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  // Verify the debug gate helper is imported/used in MainAgent.ts at all.
  assert.match(src, /isCodemodeWireDebugEnabled/, "isCodemodeWireDebugEnabled is referenced in MainAgent.ts");

  // For each healthy-path RPC log marker, confirm it is always preceded (on its line or the line above)
  // by isCodemodeWireDebugEnabled() — i.e., it does NOT appear in a bare console.warn/console.log call.
  const unconditionalWarnPattern = /console\.warn\s*\(\s*[`'"][^`'"]*\[rpcExecuteDelegatedMcp\]\s+(?:enter|recv|exit)/;
  const unconditionalLogPattern = /(?<![Dd]ebug[^\n]{0,60})\bconsole\.log\s*\(\s*[`'"][^`'"]*\[rpcExecuteDelegatedMcp\]\s+(?:enter|recv|exit)/;

  assert.ok(
    !unconditionalWarnPattern.test(src),
    "[rpcExecuteDelegatedMcp] enter/recv/exit must not appear in a bare console.warn() call"
  );

  // Verify each log marker appears gated: isCodemodeWireDebugEnabled() immediately wraps each console.log.
  const gatedEnter = /isCodemodeWireDebugEnabled\(\)\s*\)?\s*(?:&&\s*)?console\.log[^)]*\[rpcExecuteDelegatedMcp\]\s+enter|isCodemodeWireDebugEnabled\(\)\s*\)\s*\{[\s\S]{0,200}?\[rpcExecuteDelegatedMcp\]\s+enter/;
  const gatedRecv = /isCodemodeWireDebugEnabled\(\)\s*\)?\s*(?:&&\s*)?console\.log[^)]*\[rpcExecuteDelegatedMcp\]\s+recv|isCodemodeWireDebugEnabled\(\)\s*\)\s*(console\.log|\{)[\s\S]{0,400}?\[rpcExecuteDelegatedMcp\]\s+recv/;
  const gatedExit = /isCodemodeWireDebugEnabled\(\)\s*\)?\s*(?:&&\s*)?console\.log[^)]*\[rpcExecuteDelegatedMcp\]\s+exit|isCodemodeWireDebugEnabled\(\)\s*\)\s*(console\.log|\{)[\s\S]{0,400}?\[rpcExecuteDelegatedMcp\]\s+exit/;

  assert.ok(gatedEnter.test(src), "[rpcExecuteDelegatedMcp] enter log is preceded by isCodemodeWireDebugEnabled() gate");
  assert.ok(gatedRecv.test(src), "[rpcExecuteDelegatedMcp] recv log is preceded by isCodemodeWireDebugEnabled() gate");
  assert.ok(gatedExit.test(src), "[rpcExecuteDelegatedMcp] exit log is preceded by isCodemodeWireDebugEnabled() gate");
});

test("rpcExecuteDelegatedMcpTool host boundary injects required top-level MCP inputs before native execute", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  assert.match(
    src,
    /resolveRequiredToolInputsForHostBoundary\(/,
    "rpc boundary uses shared required-input resolver"
  );
  assert.match(
    src,
    /getToolEntryDescription\(def\)/,
    "rpc boundary inspects native tool description"
  );
  assert.match(
    src,
    /getToolEntrySchema\(def\)/,
    "rpc boundary inspects native tool schema"
  );
  assert.match(
    src,
    /await exec\(delegatedInputWithInjection\)/,
    "native execute receives injected top-level tool input object"
  );
  assert.match(
    src,
    /\[EdgeClaw\]\[mcp-required-input-inject\]/,
    "breadcrumb emitted for host-side required input injection"
  );
});

test("delegated task text correlation is propagated from delegateToToolAgent into sync payload", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(src, /const delegationCorrelationId = `tool-agent-\$\{this\.requestId\}-\$\{Date\.now\(\)\.toString\(36\)\}`/);
  assert.match(src, /rememberDelegatedTaskTextForCorrelation\(delegationCorrelationId, safeMessage\)/);
  assert.match(src, /delegationCorrelationId,\s*\n\s*mcpMirrorToolDescriptors/s);
});

test("rpcExecuteDelegatedMcpTool resolves explicitTaskText from correlation before latest user fallback", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(src, /resolveDelegatedTaskTextForHostBoundary\(/);
  assert.match(src, /correlationId:\s*delegationCorrelationId/);
  assert.match(src, /payloadDelegatedTaskText:\s*delegatedTaskText/);
  assert.match(src, /latestUserText/);
  assert.match(src, /explicitTaskText/);
  assert.match(src, /resolveRequiredToolInputsForHostBoundary\([\s\S]*explicitTaskText/s);
});

test("host boundary extractor supports Target account_id and ID lines", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  assert.match(
    src,
    /Target\\s\+account_id\\s\*:/,
    "extractor parses 'Target account_id: <id>'"
  );
  assert.match(
    src,
    /ID\\s\*:/,
    "extractor parses legacy 'ID: <id>' for account_id"
  );
});

test("rpcExecuteDelegatedMcpTool conflict returns before native execute", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  assert.match(
    src,
    /mcp-required-input-inject-conflict/,
    "conflict marker exists"
  );
  assert.match(
    src,
    /diagPhase = "return_required_input_conflict"/,
    "rpc phase labels conflict short-circuit"
  );
  assert.match(
    src,
    /return rpcDelegatedStubPlainEnvelope\([\s\S]{0,200}resolvedInput\.error/s,
    "conflict exits with rpc plain error envelope"
  );
});

test("rpcExecuteDelegatedMcpTool keeps single native execute call on non-retryable spec errors", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  const method = src.match(
    /async rpcExecuteDelegatedMcpTool\([\s\S]*?\n\s*async delegateTo</
  );
  assert.ok(method, "rpcExecuteDelegatedMcpTool method body must be extractable");
  const body = method![0];

  const execAwaitCount = (body.match(/await exec\(/g) ?? []).length;
  assert.equal(execAwaitCount, 1, "host boundary performs exactly one native execute await");
  assert.ok(
    !body.includes("feedback_retry"),
    "host boundary must not retry via helper feedback loops after non-retryable spec errors"
  );
});

test("host boundary injection: explicit account_id is injected when description supports parameter without required wording", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  assert.match(
    src,
    /extractExplicitToolInputHintsFromTaskText\(/,
    "explicit task hints are extracted before required/injectable resolution"
  );
  assert.match(
    src,
    /schemaSupportsMappedToolInput\(args\.toolSchema, param\)\s*\|\|\s*descriptionMentionsMappedToolInput\(args\.toolDescription, param\)/,
    "explicit hint becomes injectable when schema supports OR description mentions parameter"
  );
  assert.match(
    src,
    /new RegExp\(String\.raw`\\b\$\{escaped\}\\b`,\s*"i"\)\.test\(description\)/,
    "description support check uses plain parameter mention (not required-only phrasing)"
  );
  assert.match(
    src,
    /inputObj\[param\] = candidate/,
    "top-level parameter is injected into native execute input"
  );
});

test("host boundary injection logs skip breadcrumb with required and explicit sets", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(src, /\[EdgeClaw\]\[mcp-required-input-inject-skip\]/);
  assert.match(src, /required=\$\{requiredList\} explicit=\$\{explicitList\}/);
});

// ── Phase 7 Regression Tests ──────────────────────────────────────────────────

test("Phase 7: Host injection tracks injectedKeys explicitly; code-only input does not count as injection", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  // Verify injectedKeys set is created at function start
  assert.match(
    src,
    /const injectedKeys = new Set<MappedToolInputParam>\(\);/,
    "injectedKeys set is explicitly tracked"
  );

  // Verify injection is tracked only when adding missing keys
  assert.match(
    src,
    /if \(!existing\) \{[\s\S]{0,200}?injectedKeys\.add\(param\)/,
    "injectedKeys is populated only when parameter was missing and is being added"
  );

  // Verify skip breadcrumb uses injectedKeys.size check
  assert.match(
    src,
    /if \(injectedKeys\.size === 0\)/,
    "skip breadcrumb is logged only when no keys were actually injected"
  );

  // Verify return logic checks injectedKeys.size
  assert.match(
    src,
    /injectedKeys\.size === 0[\s\S]{0,400}?return \{ ok: true, injectedInput: args\.delegatedInput \};/,
    "returns original input when no keys were injected"
  );
});

test("Phase 7: Native execute receives top-level account_id in delegated input when task text has 'Target account_id: <id>'", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  // Verify explicit hints are extracted
  assert.match(
    src,
    /const explicit = extractExplicitToolInputHintsFromTaskText\(args\.explicitTaskText\)/,
    "explicit task hints are extracted from task text"
  );

  // Verify account_id is injected when explicitly present
  assert.match(
    src,
    /inputObj\[param\] = candidate;[\s\S]{0,100}?injectedKeys\.add\(param\)/,
    "parameter is injected into native input object"
  );

  // Verify native exec receives the injected input
  assert.match(
    src,
    /await exec\(delegatedInputWithInjection\)/,
    "native execute is called with injected input containing top-level account_id"
  );
});

test("Phase 7: Host boundary does not move account_id into path/query/knownValues as a substitute for top-level tool input", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  const delegatePath = join(here, "..", "subagents", "ToolAgentThinkFacet.ts");
  const delegateSrc = readFileSync(delegatePath, "utf8");

  // The host boundary must NOT contain workarounds to move account_id into path
  assert.ok(
    !src.match(/account_id[\s\S]{0,200}?path\[/),
    "MainAgent host boundary must not move account_id into path"
  );
  assert.ok(
    !src.match(/account_id[\s\S]{0,200}?query\[/),
    "MainAgent host boundary must not move account_id into query"
  );
  assert.ok(
    !src.match(/account_id[\s\S]{0,200}?knownValues/),
    "MainAgent host boundary must not move account_id into knownValues"
  );

  // Helper wrappers (in ToolAgentThinkFacet or tools) must not compensate
  assert.ok(
    !delegateSrc.match(/\/\/ Move account_id to path|\/\/ Workaround: insert account_id/),
    "ToolAgent must not have fallback workarounds to move account_id into query/path"
  );
});

test("Phase 7: Auth errors should not return retry-able envelope; no retries on authentication failure", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  const envelopePath = join(here, "..", "toolAgentResultEnvelope.ts");
  const envelopeSrc = readFileSync(envelopePath, "utf8");

  // The envelope must have auth_error with appropriate messaging
  assert.match(
    envelopeSrc,
    /type:\s*["']auth_error["']/,
    "toolAgentResultEnvelope classifies auth_error as a distinct type"
  );

  // The auth_error classification must have non-retry fix/prompt
  assert.match(
    envelopeSrc,
    /auth_error[\s\S]{0,1400}?suggestedRetryPrompt/,
    "auth_error section has explicit retry prompt guidance"
  );

  // The suggested fix must warn against workaround attempts
  assert.match(
    envelopeSrc,
    /Do not retry[\s\S]{0,100}?moving account_id/,
    "auth_error fix explicitly warns against moving account_id as a workaround"
  );
});

test("delegated task text is preserved through sync + mirror RPC payload for host-boundary explicit input extraction", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const toolFacetPath = join(here, "..", "subagents", "ToolAgentThinkFacet.ts");
  const mirrorPath = join(here, "..", "..", "tools", "mcpLiveMirrorTools.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  const facetSrc = readFileSync(toolFacetPath, "utf8");
  const mirrorSrc = readFileSync(mirrorPath, "utf8");

  assert.match(mainSrc, /delegatedTaskText:\s*safeMessage/, "MainAgent passes delegated task text during MCP sync");
  assert.match(facetSrc, /delegatedTaskText\?: string/, "ToolAgent sync payload accepts delegatedTaskText");
  assert.match(facetSrc, /_delegatedTaskTextForMirror/, "ToolAgent stores delegated task text for mirror forwarding");
  assert.match(mirrorSrc, /delegatedTaskText\?: string/, "mirror RPC payload supports delegatedTaskText");
  assert.match(mirrorSrc, /const rpcPayload = \{ toolName, input: wiredInput, delegatedTaskText, delegationCorrelationId \}/,
    "mirror forwards delegatedTaskText to MainAgent rpcExecuteDelegatedMcpTool");
});

test("host boundary emits required extraction and native execute input breadcrumbs", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");

  assert.match(src, /\[EdgeClaw\]\[mcp-required-input-extracted\]/,
    "logs extracted explicit task inputs before host-boundary injection");
  assert.match(src, /\[EdgeClaw\]\[mcp-native-exec-input\]/,
    "logs sanitized native execute input keys before invoke");
  assert.match(src, /hasAccountId=\$\{hasAccountId \? "yes" : "no"\}/,
    "native input breadcrumb includes account_id presence marker");
});

