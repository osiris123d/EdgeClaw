import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitDelegateToToolAgentUserMessage } from "../mainAgentDelegateToolGuards";

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
