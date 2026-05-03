/**
 * Browser grounding and screenshot rendering tests.
 *
 * Verifies:
 * 1. Browser-action requests without a tool call produce the grounded fallback message.
 * 2. browser_execute with a screenshot base64 result normalizes to screenshotDataUrl
 *    and never leaks raw base64 into assistant prose.
 * 3. Browser-intent requests classify to routeClass="tools", not "utility" or "vision".
 *
 * All logic is inlined to match the project test pattern (plain node --test, no transpiler).
 */

// ─── inline: isBrowserIntentRequest (mirrored from browserToolAvailability.ts) ─

function isBrowserIntentRequest(text) {
  const normalized = text.toLowerCase();
  return /\b(browser_search|browser_execute|browse|browsing|inspect\s+(a\s+)?(page|site|website)|inspect\s+dom|dom|navigate|navigation|read\s+(the\s+)?page|page\s+content|screenshot|screen\s*shot|capture\s+(a\s+)?screenshot|open\s+(a\s+)?url|visit\s+(a\s+)?url|open\s+https?:\/\/|go\s+to\s+https?:\/\/|record\s+(a\s+)?session|browser\s+(session|automation)|take\s+(a\s+)?(screenshot|photo)|load\s+(a\s+)?(page|url|site))\b/.test(
    normalized
  );
}

// ─── inline: classifyRouteClass (mirrored from MainAgent.ts) ─────────────────

function inferLikelyToolUsage(message) {
  const text = (message || "").toLowerCase();
  return /\b(search|browse|open|navigate|fetch|execute|run|read file|list|query)\b/.test(text);
}

function inferComplexity(message) {
  const length = (message || "").length;
  if (length > 2400) return "expert";
  if (length > 1200) return "complex";
  if (length > 400) return "moderate";
  return "simple";
}

function classifyRouteClass(message) {
  const text = (message || "").toLowerCase();
  const likelyToolUse = inferLikelyToolUsage(message);
  const complexity = inferComplexity(message);

  // Browser intent must route to "tools"
  if (isBrowserIntentRequest(text)) return "tools";
  if (/\b(image|vision|photo|diagram|ocr)\b/.test(text)) return "vision";
  if (likelyToolUse) return "tools";
  if (
    complexity === "complex" ||
    complexity === "expert" ||
    /\b(reason|analyz|compare|derive|prove|tradeoff|debug|refactor)\b/.test(text)
  ) return "reasoning";
  return "utility";
}

// ─── inline: browser grounding gate (mirrored from beforeTurn logic) ─────────

const NO_TOOL_FALLBACK = "No browser tool was executed, so I cannot confirm the action occurred.";

function simulateBeforeTurnGrounding({ userMessage, browserToolsPresent }) {
  const browserIntentDetected = isBrowserIntentRequest(userMessage);

  if (!browserIntentDetected) {
    return { toolChoice: "auto", grounded: true, fallback: false };
  }

  // Browser tools unavailable — short circuit
  if (!browserToolsPresent) {
    return { toolChoice: "none", grounded: false, fallback: true, fallbackText: NO_TOOL_FALLBACK };
  }

  // Browser tools available — force tool call
  return { toolChoice: "required", maxSteps: 2, grounded: true, fallback: false };
}

// ─── inline: screenshot normalization (mirrored from browserArtifacts.ts) ────

function isValidBase64(str) {
  if (typeof str !== "string" || str.length === 0) return false;
  if (str.startsWith("data:")) return false;
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(str) && str.length > 0;
}

function detectAndNormalizeScreenshot(data) {
  const dataUrlDirect = typeof data.screenshotDataUrl === "string" && data.screenshotDataUrl.trim() ? data.screenshotDataUrl.trim() : undefined;
  if (dataUrlDirect?.startsWith("data:")) return dataUrlDirect;

  const screenshotObj = (data.screenshot && typeof data.screenshot === "object" && !Array.isArray(data.screenshot)) ? data.screenshot : null;
  if (screenshotObj) {
    const nestedDataUrl = typeof screenshotObj.dataUrl === "string" ? screenshotObj.dataUrl.trim() : undefined;
    if (nestedDataUrl?.startsWith("data:")) return nestedDataUrl;
  }

  const screenshotTopLevel = typeof data.screenshot === "string" ? data.screenshot : undefined;
  const base64Options = [
    typeof data.screenshotData === "string" ? data.screenshotData : undefined,
    typeof data.screenshotBase64 === "string" ? data.screenshotBase64 : undefined,
    screenshotTopLevel,
  ];

  for (const base64 of base64Options) {
    if (base64 && isValidBase64(base64)) {
      return `data:image/png;base64,${base64}`;
    }
  }

  return undefined;
}

function normalizeBrowserExecuteResult(toolName, output) {
  const parsed = (output && typeof output === "object" && !Array.isArray(output)) ? output : null;
  const screenshotDataUrl = parsed ? detectAndNormalizeScreenshot(parsed) : undefined;

  // Build a normalized result that strips raw screenshot data from direct fields
  const result = {
    schema: "edgeclaw.browser-tool-result",
    toolName,
    pageUrl: parsed?.pageUrl ?? parsed?.url ?? undefined,
    description: parsed?.description ?? parsed?.caption ?? undefined,
  };

  if (screenshotDataUrl) {
    result._screenshotDataUrl = screenshotDataUrl;
  }

  return result;
}

// Helper: checks if a string contains content that looks like raw base64 (>100 chars of base64-alphabet chars)
function containsRawBase64(text) {
  return /[A-Za-z0-9+/]{100,}={0,2}/.test(text);
}

// ─── test harness ─────────────────────────────────────────────────────────────

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message ?? `Expected truthy value, got ${value}`);
}

function assertFalse(value, message) {
  if (value) throw new Error(message ?? `Expected falsy value, got ${value}`);
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
}

// ─── Test 1: browser screenshot request with no tool call → grounded fallback ─

test("browser screenshot request with no tool call produces grounded fallback", () => {
  const userMessage = "Take a screenshot of https://example.com";

  // Simulate: browser tools unavailable → fallback returned
  const result = simulateBeforeTurnGrounding({ userMessage, browserToolsPresent: false });
  assertTrue(result.fallback, "Expected fallback=true when browser tools unavailable");
  assertEqual(result.toolChoice, "none");
  assertEqual(result.fallbackText, NO_TOOL_FALLBACK);
});

test("browser screenshot request with tools available forces toolChoice=required", () => {
  const userMessage = "Take a screenshot of https://example.com";

  const result = simulateBeforeTurnGrounding({ userMessage, browserToolsPresent: true });
  assertFalse(result.fallback, "Expected fallback=false when tools available");
  assertEqual(result.toolChoice, "required");
  assertEqual(result.maxSteps, 2);
});

test("non-browser request does not get grounding gate applied", () => {
  const userMessage = "What is the capital of France?";
  const result = simulateBeforeTurnGrounding({ userMessage, browserToolsPresent: true });
  assertFalse(result.fallback);
  assertEqual(result.toolChoice, "auto");
});

// ─── Test 2: browser_execute screenshot base64 → normalized data URL, no raw base64 in prose ─

test("browser_execute result with raw base64 screenshot normalizes to _screenshotDataUrl", () => {
  const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" + "A".repeat(60); // plausible base64
  const rawOutput = {
    pageUrl: "https://example.com",
    description: "Page loaded",
    screenshot: fakeBase64,
  };

  const result = normalizeBrowserExecuteResult("browser_execute", rawOutput);
  assertTrue(result._screenshotDataUrl?.startsWith("data:image/png;base64,"), "Should have data URL");
  assertEqual(result.toolName, "browser_execute");
  assertEqual(result.pageUrl, "https://example.com");
});

test("browser_execute result screenshotDataUrl field preserved as-is when already a data URL", () => {
  const existingDataUrl = "data:image/png;base64,abc123==";
  const rawOutput = { screenshotDataUrl: existingDataUrl };
  const result = normalizeBrowserExecuteResult("browser_execute", rawOutput);
  assertEqual(result._screenshotDataUrl, existingDataUrl);
});

test("normalized result does not contain raw base64 in description or prose fields", () => {
  const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" + "A".repeat(150);
  const rawOutput = { screenshot: fakeBase64, description: "Page captured" };
  const result = normalizeBrowserExecuteResult("browser_execute", rawOutput);

  // description and pageUrl must not contain raw base64
  assertFalse(containsRawBase64(result.description ?? ""), "description must not contain raw base64");
  assertFalse(containsRawBase64(result.pageUrl ?? ""), "pageUrl must not contain raw base64");
  // screenshot data should be in _screenshotDataUrl only
  assertTrue(result._screenshotDataUrl?.startsWith("data:"), "Screenshot should be in _screenshotDataUrl");
});

// ─── Test 3: browser-intent requests route to "tools", not "utility" or "vision" ─

test("'take a screenshot of example.com' routes to tools not vision", () => {
  assertEqual(classifyRouteClass("take a screenshot of example.com"), "tools");
});

test("'navigate to https://example.com' routes to tools", () => {
  assertEqual(classifyRouteClass("navigate to https://example.com"), "tools");
});

test("'open https://example.com and take a photo' routes to tools not vision", () => {
  assertEqual(classifyRouteClass("open https://example.com and take a photo"), "tools");
});

test("'record a browser session' routes to tools", () => {
  assertEqual(classifyRouteClass("record a browser session of the checkout flow"), "tools");
});

test("non-browser plain question routes to utility", () => {
  assertEqual(classifyRouteClass("what is the weather today"), "utility");
});

test("'analyze this image' routes to vision not tools", () => {
  assertEqual(classifyRouteClass("analyze this image for me"), "vision");
});
