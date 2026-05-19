import { describe, it, expect, vi } from "vitest";
import { emitTestOnlyDelegateToolAgentStructuredLogs } from "../subagents/delegateToolAgentTaskHelper";
import { logMcpApiSummary } from "../../lib/observability";

describe("Structured Logs", () => {
  it("logs visible assistant injection metadata", async () => {
    const logSpy = vi.spyOn(console, "log");

    // Simulate injection
    await emitTestOnlyDelegateToolAgentStructuredLogs("test-request-id", "delegate_tool_task");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[EdgeClaw][visible-assistant-injection]"),
      expect.objectContaining({
        requestId: "test-request-id",
        source: "delegate_tool_task",
        outcome: "success",
        destination: "chat",
        markdownTableDetected: true,
        tableHeaders: ["rule id", "rule name"],
      })
    );

    logSpy.mockRestore();
  });

  it("logs ToolAgent delegation start and end", async () => {
    const logSpy = vi.spyOn(console, "log");

    await emitTestOnlyDelegateToolAgentStructuredLogs("test-request-id", "delegate_tool_task");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[EdgeClaw][tool-agent-delegation-start]"),
      expect.objectContaining({
        requestId: "test-request-id",
        taskKind: "delegate_tool_task",
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[EdgeClaw][tool-agent-delegation-end]"),
      expect.objectContaining({
        requestId: "test-request-id",
        taskKind: "delegate_tool_task",
        status: "success",
        hasMarkdownTable: true,
        tableHeaders: ["rule id", "rule name"],
      })
    );

    logSpy.mockRestore();
  });

  it("logs MCP API execution summary", () => {
    const logSpy = vi.spyOn(console, "log");

    logMcpApiSummary("test-request-id", "GET", "/mcp/api/path", 10, 100, ["rule id", "rule name"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[EdgeClaw][tool-agent-mcp-api-summary]"),
      expect.objectContaining({
        requestId: "test-request-id",
        method: "GET",
        operationPathTemplate: "/mcp/api/path",
        matchedCount: 10,
        scannedCount: 100,
        returnedFields: ["rule id", "rule name"],
      })
    );

    logSpy.mockRestore();
  });
});