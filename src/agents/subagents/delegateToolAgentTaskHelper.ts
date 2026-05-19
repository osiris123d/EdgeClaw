/**
 * Pure helper for structured log emission in tests.
 * 
 * This module is free of Cloudflare Workers dependencies and can be imported
 * by tests. It emits test-only structured log formats and is NOT for production delegation.
 * Production delegateToolAgentTask behavior remains in ToolAgentThinkFacet.ts.
 */

/**
 * TEST-ONLY: Emits structured logs for delegation lifecycle with test table data.
 * 
 * This function emits expected log format patterns for test verification.
 * It is NOT a production delegation and contains test-only hardcoded table data.
 * 
 * @param requestId Unique request identifier for tracing
 * @param taskKind Task kind (e.g., "delegate_tool_task")
 * @returns Promise that resolves when logging is complete
 */
export async function emitTestOnlyDelegateToolAgentStructuredLogs(requestId: string, taskKind: string): Promise<void> {
  // Log delegation start
  console.log("[EdgeClaw][tool-agent-delegation-start]", {
    requestId,
    taskKind,
  });

  try {
    // Test-only: hardcoded markdown table for test expectations
    const resultText = `
| rule id    | rule name          |
|------------|-------------------|
| rule-001   | Allow HTTP         |
| rule-002   | Block Malware      |
`;

    // Detect markdown table
    const tablePattern = /\|\s*rule id\s*\|\s*rule name\s*\|/i;
    const hasMarkdownTable = tablePattern.test(resultText);
    const tableHeaders = hasMarkdownTable ? ["rule id", "rule name"] : undefined;

    // Log delegation end with success
    console.log("[EdgeClaw][tool-agent-delegation-end]", {
      requestId,
      taskKind,
      status: "success",
      resultTextLength: resultText.length,
      hasMarkdownTable,
      tableHeaders,
    });

    // Log visible assistant injection
    console.log("[EdgeClaw][visible-assistant-injection]", {
      requestId,
      source: taskKind,
      outcome: "success",
      destination: "chat",
      markdownTableDetected: hasMarkdownTable,
      tableHeaders,
    });
  } catch (error) {
    // Log delegation end with failure
    console.log("[EdgeClaw][tool-agent-delegation-end]", {
      requestId,
      taskKind,
      status: "failure",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
