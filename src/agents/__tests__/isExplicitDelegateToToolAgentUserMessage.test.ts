import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitDelegateToToolAgentUserMessage } from "../mainAgentDelegateToolGuards";
import { detectMcpToolApiDelegationIntent } from "../mainAgentDelegateToolGuards";

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
