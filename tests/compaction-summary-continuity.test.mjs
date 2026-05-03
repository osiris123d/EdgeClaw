/**
 * Focused integration-style compaction continuity test.
 *
 * Simulates a noisy history segment with:
 * - a durable fact (user name)
 * - browser session state (sessionId/currentUrl/status)
 * - repeated greeting clutter
 * - repeated contradictory old assistant chatter
 *
 * Verifies summary output preserves durable/browser state and excludes clutter.
 */

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy value, got ${value}`);
}

function assertFalse(value, message) {
  if (value) throw new Error(message || `Expected falsy value, got ${value}`);
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
    })
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
}

function mockCompactionSummarize(historySegment) {
  const lines = [];

  const nameMatch = historySegment.match(/\bname is\s+([A-Za-z][A-Za-z0-9_-]*)\b/i);
  if (nameMatch) {
    lines.push(`- Durable fact: user name is ${nameMatch[1]}.`);
  }

  const sessionIdMatch = historySegment.match(/\bsessionId\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  const statusMatch = historySegment.match(
    /\bstatus\s*[:=]\s*(awaiting_human|disconnected|active|completed|abandoned)/i
  );
  const urlMatch = historySegment.match(/\bcurrentUrl\s*[:=]\s*(https?:\/\/\S+)/i);

  if (sessionIdMatch || statusMatch || urlMatch) {
    lines.push(
      `- Browser session state: sessionId=${sessionIdMatch?.[1] ?? "unknown"}, ` +
        `status=${statusMatch?.[1] ?? "unknown"}, currentUrl=${urlMatch?.[1] ?? "unknown"}.`
    );
  }

  if (/tool outcome|tool result|browser_session/i.test(historySegment)) {
    lines.push("- Important tool outcomes retained for ongoing execution context.");
  }

  return lines.join("\n");
}

function summaryCarriesBrowserSessionState(summary) {
  const normalized = summary.toLowerCase();
  return (
    /\bbrowser session\b/.test(normalized) ||
    /\bsession(?:id)?\b/.test(normalized) ||
    /\bawaiting_human\b|\bdisconnected\b|\bactive\b|\bcompleted\b|\babandoned\b/.test(normalized) ||
    /\bcurrenturl\b|https?:\/\//.test(normalized)
  );
}

function summaryCarriesDurableFacts(summary) {
  const normalized = summary.toLowerCase();
  return (
    /\bname is\b|\buser name\b|\bprefers\b|\btimezone\b|\bemail\b/.test(normalized) ||
    /\bconstraint\b|\bdurable fact\b|\bremember\b/.test(normalized)
  );
}

test("compaction summary preserves durable/browser state and excludes clutter", async () => {
  const historySegment = [
    "User: My name is Taylor.",
    "Tool outcome: browser_session status -> sessionId=bs_123, status=awaiting_human, currentUrl=https://example.com/checkout",
    "User: Hi",
    "User: Hi",
    "Assistant: Browser tools are unavailable in this deployment.",
    "Assistant: Browser tools are unavailable in this deployment.",
    "Assistant: On it.",
    "Assistant: On it.",
  ].join("\n");

  const summary = mockCompactionSummarize(historySegment);

  assertTrue(/Taylor/.test(summary), "Summary should preserve durable user-name fact");
  assertTrue(/sessionId=bs_123/i.test(summary), "Summary should preserve browser session id");
  assertTrue(/status=awaiting_human/i.test(summary), "Summary should preserve browser session status");
  assertTrue(/currentUrl=https:\/\/example.com\/checkout/i.test(summary), "Summary should preserve browser currentUrl");

  assertFalse(/\bHi\b/.test(summary), "Summary should exclude greeting clutter");
  assertFalse(
    /browser tools are unavailable/i.test(summary),
    "Summary should exclude contradictory obsolete availability chatter"
  );

  assertTrue(
    summaryCarriesBrowserSessionState(summary),
    "Continuity heuristic should detect browser session state"
  );
  assertTrue(
    summaryCarriesDurableFacts(summary),
    "Continuity heuristic should detect durable facts"
  );
});

console.log("\nCompaction continuity test completed.\n");
