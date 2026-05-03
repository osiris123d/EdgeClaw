/**
 * Threshold-driven compaction eligibility smoke tests.
 *
 * Verifies:
 * - below-threshold classification just under threshold
 * - eligible-at-or-above-threshold classification just above threshold
 * - hygiene can reduce low-value clutter enough to move from above to below threshold
 */

const COMPACTION_THRESHOLD_TOKENS = 45_000;

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
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

function normalizeSimpleText(text) {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "");
}

function isSimpleGreeting(text) {
  const normalized = normalizeSimpleText(text);
  return (
    normalized === "hi" ||
    normalized === "hello" ||
    normalized === "hey" ||
    normalized === "hi there" ||
    normalized === "hello there"
  );
}

function isAssistantStatusOnly(text) {
  const normalized = normalizeSimpleText(text);
  if (normalized.length === 0 || normalized.length > 64) return false;
  return /^(ok|okay|got it|understood|on it|working on it|one moment|just a moment|let me check|checking now|thinking|stand by)$/.test(
    normalized
  );
}

function messageCarriesToolData(message) {
  if (!message || typeof message !== "object") return false;

  if (
    Array.isArray(message.toolCalls) ||
    Array.isArray(message.toolInvocations) ||
    Array.isArray(message.tool_results) ||
    Array.isArray(message.toolResult)
  ) {
    return true;
  }

  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    if (typeof part.toolName === "string" || typeof part.toolCallId === "string") return true;
    return typeof part.type === "string" && part.type !== "text";
  });
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  const pieces = [];
  for (const part of message.content) {
    if (typeof part === "string") {
      pieces.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") pieces.push(part.text);
  }
  return pieces.join(" ");
}

function applyLightweightHistoryHygiene(messages) {
  const kept = [];
  let previousKeptUserGreeting;
  let previousKeptAssistantStatus;

  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : undefined;
    const text = extractMessageText(message).trim();
    const normalizedText = normalizeSimpleText(text);
    const hasToolData = messageCarriesToolData(message);

    if (role === "assistant") {
      if (!hasToolData && text.length === 0) continue;
      if (!hasToolData && isAssistantStatusOnly(text) && previousKeptAssistantStatus === normalizedText) {
        continue;
      }

      previousKeptAssistantStatus =
        !hasToolData && isAssistantStatusOnly(text) ? normalizedText : undefined;
      previousKeptUserGreeting = undefined;
    } else if (role === "user") {
      if (isSimpleGreeting(text) && previousKeptUserGreeting === normalizedText) continue;
      previousKeptUserGreeting = isSimpleGreeting(text) ? normalizedText : undefined;
      previousKeptAssistantStatus = undefined;
    } else {
      previousKeptUserGreeting = undefined;
      previousKeptAssistantStatus = undefined;
    }

    kept.push(message);
  }

  return kept;
}

function estimatePromptTokens(messages) {
  const chars = messages.reduce((acc, message) => acc + extractMessageText(message).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function compactionPreReason(promptTokensAfterHygiene, thresholdTokens = COMPACTION_THRESHOLD_TOKENS) {
  return promptTokensAfterHygiene >= thresholdTokens
    ? "eligible-at-or-above-threshold"
    : "below-threshold";
}

test("just below threshold logs below-threshold", () => {
  const tokensAfterHygiene = COMPACTION_THRESHOLD_TOKENS - 1;
  assertEqual(compactionPreReason(tokensAfterHygiene), "below-threshold");
});

test("just above threshold logs eligible-at-or-above-threshold", () => {
  const tokensAfterHygiene = COMPACTION_THRESHOLD_TOKENS + 1;
  assertEqual(compactionPreReason(tokensAfterHygiene), "eligible-at-or-above-threshold");
});

test("hygiene can move a noisy conversation from above-threshold to below-threshold", () => {
  const lowValueNoise = [];
  for (let i = 0; i < 16_500; i += 1) {
    lowValueNoise.push({ role: "assistant", content: "" });
    lowValueNoise.push({ role: "user", content: "Hi" });
    lowValueNoise.push({ role: "assistant", content: "On it" });
    lowValueNoise.push({ role: "assistant", content: "On it" });
  }

  const meaningful = [
    {
      role: "user",
      content:
        "Please continue the active browser session and confirm the saved invoice total after tool execution.",
    },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolName: "browser_session", text: "session status" },
      ],
    },
  ];

  const noisyMessages = [...lowValueNoise, ...meaningful];
  const beforeTokens = estimatePromptTokens(noisyMessages);
  const cleanedMessages = applyLightweightHistoryHygiene(noisyMessages);
  const afterTokens = estimatePromptTokens(cleanedMessages);

  assertEqual(compactionPreReason(beforeTokens), "eligible-at-or-above-threshold");
  assertEqual(compactionPreReason(afterTokens), "below-threshold");
});

console.log("\nCompaction eligibility tests completed.\n");
