import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isExplicitDelegateToToolAgentUserMessage } from "../mainAgentDelegateToolGuards";
import { detectMcpToolApiDelegationIntent } from "../mainAgentDelegateToolGuards";

const here = dirname(fileURLToPath(import.meta.url));

test("detects Delegate … to ToolAgent (canonical user phrasing)", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage(
      "Delegate this MCP/OpenAPI task to ToolAgent: list Workers scripts."
    ),
    true
  );
});

test("rejects MCP task without delegation + ToolAgent", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage("List my Cloudflare Workers scripts via MCP."),
    false
  );
});

test("rejects ToolAgent mentioned without delegate verb nearby", () => {
  assert.equal(isExplicitDelegateToToolAgentUserMessage("What does ToolAgent do?"), false);
});

test("delegating near ToolAgent", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage("delegating openapi search to ToolAgent now"),
    true
  );
});

test("detects spaced tool agent phrasing", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage(
      "Please delegate this to tool agent: list Workers scripts."
    ),
    true
  );
});

test("detects hyphen tool-agent", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage("Delegate to tool-agent: ping MCP."),
    true
  );
});

// ─── detectMcpToolApiDelegationIntent ─────────────────────────────────────────

// Regression test 1
test("MCP server + list action → forces delegation with taskKind=mcp_api", () => {
  const r = detectMcpToolApiDelegationIntent("Please use MCP server to list my AI Gateways");
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

// Regression test 2
test("MCP tool + fetch action → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Use the MCP tool to fetch deployments");
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

// Regression test 3
test("Search the OpenAPI spec → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Search the OpenAPI spec for durable objects");
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

// Regression test 4
test("Call the API to list gateways → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Call the API to list gateways");
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

// Regression test 5
test("'What is MCP?' → no forced delegation (conceptual question)", () => {
  const r = detectMcpToolApiDelegationIntent("What is MCP?");
  assert.equal(r.matched, false);
});

// Regression test 6
test("'Explain what an API gateway is' → no forced delegation (conceptual question)", () => {
  const r = detectMcpToolApiDelegationIntent("Explain what an API gateway is");
  assert.equal(r.matched, false);
});

// Regression test 7
test("'Open the dashboard in browser' → no ToolAgent delegation (browser task)", () => {
  const r = detectMcpToolApiDelegationIntent("Open the dashboard in browser");
  assert.equal(r.matched, false);
});

// Regression test 8 — existing explicit delegation still routes through isExplicitDelegateToToolAgentUserMessage
test("Existing explicit delegation phrase still detected by isExplicitDelegateToToolAgentUserMessage", () => {
  assert.equal(
    isExplicitDelegateToToolAgentUserMessage("Delegate this MCP/OpenAPI task to ToolAgent: list Workers scripts."),
    true
  );
});

// Additional edge cases
test("via MCP + search action → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Search for workers scripts via MCP");
  assert.equal(r.matched, true);
});

test("external tool + retrieve → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Use the external tool to retrieve the device list");
  assert.equal(r.matched, true);
});

test("product mention without use/call/MCP trigger → no delegation", () => {
  const r = detectMcpToolApiDelegationIntent("How many AI gateways do I have?");
  assert.equal(r.matched, false);
});

test("query the API → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Query the API for active Workers");
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

test("connected tool + list → forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent("List all namespaces using the connected tool");
  assert.equal(r.matched, true);
});

test("MCP mentioned without action verb → no delegation (no_action_verb)", () => {
  const r = detectMcpToolApiDelegationIntent("MCP server is great for tool integration");
  assert.equal(r.matched, false);
  assert.equal(r.reason, "no_action_verb");
});

// ─── Analysis/generation verb tests ───────────────────────────────────────────

// New test 1: review + produce a script via MCP
test("MCP server + review + draft script → matched=true, taskKind=mcp_api", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Please use the MCP server for policies to review policies and figure out a python script to clean them up"
  );
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

// New test 2: connected tool + audit + draft
test("connected tool + audit + draft → matched=true", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Use the connected tool to audit rules and draft a remediation script"
  );
  assert.equal(r.matched, true);
});

// New test 3: API + review + generate
test("API trigger + review + generate → matched=true", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Use the API to review records and generate a cleanup script"
  );
  assert.equal(r.matched, true);
});

// New test 4: 'explain how to write a script' — no MCP/tool/API trigger → no match
test("'Explain how to write a script for policies' — no trigger → matched=false", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Explain how to write a script for reviewing policies"
  );
  assert.equal(r.matched, false);
  assert.equal(r.reason, "conceptual_question");
});

// New test 5: 'review policies' alone — no MCP/tool/API trigger → no match
test("'Review policies' without MCP/tool/API trigger → matched=false", () => {
  const r = detectMcpToolApiDelegationIntent("Review all the policies for my account");
  assert.equal(r.matched, false);
});

test("Cloudflare account_id + gateway/rules read lookup cues force delegation", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Find Gateway rules where name starts with ht-gw_network-allow_3P for account_id 7012a2fac757cc12605e0faa9f5d056f"
  );
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
  assert.equal(r.reason, "route_cue_trigger");
});

test("Route-template cue with read-only/list API wording forces delegation", () => {
  const r = detectMcpToolApiDelegationIntent(
    "Read-only list API lookup for /accounts/{account_id}/gateway/rules"
  );
  assert.equal(r.matched, true);
  assert.equal(r.taskKind, "mcp_api");
});

test("plain read-only phrasing alone does not trigger ToolAgent delegation", () => {
  const r = detectMcpToolApiDelegationIntent("Read-only please");
  assert.equal(r.matched, false);
});

// ─── MainAgent gate regression ─────────────────────────────────────────────────

test("when detectMcpToolApiDelegationIntent matches, MainAgent sets activeTools=[delegate_tool_task], toolChoice, and delegateGateStrictToolCall (source contract)", () => {
  const src = readFileSync(join(here, "..", "MainAgent.ts"), "utf8");

  // mcpToolIntent.matched triggers wantsDelegation
  assert.match(
    src,
    /const wantsDelegation\s*=\s*wantsToolAgentDelegation\s*\|\|\s*mcpToolIntent\.matched/,
    "wantsDelegation ORs explicit and mcpToolIntent.matched"
  );

  // Gate sets _turnDelegateGateStrictToolCall
  assert.match(
    src,
    /this\._turnDelegateGateStrictToolCall\s*=\s*true/,
    "_turnDelegateGateStrictToolCall=true inside the delegation gate"
  );

  // Gate forces activeTools to delegate_tool_task only
  assert.match(
    src,
    /activeTools:\s*\[\s*["']delegate_tool_task["']\s*\]/,
    "activeTools pinned to [delegate_tool_task]"
  );

  // Gate forces toolChoice required
  assert.match(
    src,
    /toolChoice:\s*["']required["']/,
    "toolChoice set to required"
  );
});
