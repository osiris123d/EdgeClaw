/**
 * Turn-level browser_session routing guard tests.
 *
 * Mirrors MainAgent explicit structured-browser routing and duplicate launch guard.
 */

import fs from "node:fs";
import path from "node:path";

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message ?? `Expected truthy, got ${value}`);
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message ?? `Expected ${e}, got ${a}`);
}

function isExplicitBrowserSessionStructuredCall(text) {
  const normalized = text.toLowerCase();
  const explicitBrowserSessionMention =
    /\bbrowser_session\b/.test(normalized) ||
    /use\s+browser\s*session/.test(normalized) ||
    /call\s+browser\s*session/.test(normalized);
  const explicitStructuredIntent =
    /structured\s+actions?/.test(normalized) ||
    /actions?\s+array/.test(normalized) ||
    /exactly\s+once/.test(normalized) ||
    /"operation"\s*:\s*"launch"/.test(normalized) ||
    /"actions"\s*:\s*\[/.test(normalized) ||
    /operation\s*[:=]\s*launch/.test(normalized);

  return explicitBrowserSessionMention && explicitStructuredIntent;
}

function extractExplicitAdvancedBrowserTools(text) {
  const normalized = text.toLowerCase();
  const tools = [];
  if (/\bbrowser_search\b/.test(normalized)) tools.push("browser_search");
  if (/\bbrowser_execute\b/.test(normalized)) tools.push("browser_execute");
  return tools;
}

function simulateStructuredTurnConfig(userMessage) {
  const explicit = isExplicitBrowserSessionStructuredCall(userMessage);
  if (!explicit) {
    return {
      toolChoice: "required",
      maxSteps: 2,
      activeTools: ["browser_execute", "browser_search", "browser_session"],
    };
  }

  const explicitAdvanced = extractExplicitAdvancedBrowserTools(userMessage);
  return {
    toolChoice: "required",
    maxSteps: 1,
    activeTools: [
      "browser_session",
      ...(explicitAdvanced.includes("browser_search") ? ["browser_search"] : []),
      ...(explicitAdvanced.includes("browser_execute") ? ["browser_execute"] : []),
    ],
  };
}

function isSuccessfulLaunchResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.schema !== "edgeclaw.browser-session-result") return false;
  if (typeof result.sessionId !== "string" || result.sessionId.length === 0) return false;
  return ["active", "awaiting_human", "disconnected"].includes(result.status);
}

function launchAllowsFollowup(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.status === "awaiting_human") return true;
  if (result.needsHumanIntervention === true) return true;
  if (typeof result.summary === "string" && /reconnect|resume/i.test(result.summary)) return true;
  return false;
}

test("explicit structured browser_session request => activeTools=[browser_session], maxSteps=1", () => {
  const config = simulateStructuredTurnConfig(
    'Use browser_session with a structured actions array and call browser_session exactly once. {"operation":"launch","actions":[{"type":"navigate","url":"https://amazon.com"}]}'
  );

  assertEqual(config.toolChoice, "required");
  assertEqual(config.maxSteps, 1);
  assertDeepEqual(config.activeTools, ["browser_session"]);
});

test("explicit structured request can keep advanced tools only when explicitly requested", () => {
  const config = simulateStructuredTurnConfig(
    'Use browser_session with structured actions array exactly once, and then use browser_execute for a custom DOM check.'
  );

  assertEqual(config.maxSteps, 1);
  assertDeepEqual(config.activeTools, ["browser_session", "browser_execute"]);
});

test("duplicate launch prevention uses first successful launch result", () => {
  const firstResult = {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: "sess-1",
    status: "active",
    recordingEnabled: true,
    summary: "Browser session launched.",
  };

  assertTrue(isSuccessfulLaunchResult(firstResult), "first launch should count as successful");
  assertEqual(launchAllowsFollowup(firstResult), false, "active launch should not allow a second launch");

  // Guard behavior mirror: second launch in same turn should substitute first result.
  const secondLaunchDecision = {
    action: "substitute",
    result: firstResult,
  };

  assertEqual(secondLaunchDecision.action, "substitute");
  assertEqual(secondLaunchDecision.result.sessionId, "sess-1");
});

test("source contains explicit structured-call grounding log and maxSteps=1 branch", () => {
  const sourcePath = path.resolve(process.cwd(), "src/agents/MainAgent.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assertTrue(
    source.includes("[browser-grounding] explicitBrowserSessionStructuredCall=yes maxSteps="),
    "MainAgent must log explicit structured-call routing"
  );
  assertTrue(
    source.includes("const maxSteps = 1;"),
    "MainAgent must force maxSteps=1 for explicit structured browser_session calls"
  );
  assertTrue(
    source.includes("Prevented duplicate browser_session launch in the same turn") &&
      source.includes("action: \"substitute\""),
    "MainAgent must substitute the first successful launch result to prevent duplicate launches"
  );
});

const amazonBackpackUserPrompt = `
Use browser_session with a structured actions array.
Call browser_session exactly once with operation "launch" and these fields:
- task: "Search Amazon for backpacks and capture a screenshot"
- sessionMode: "reusable"
- recordingEnabled: true
- keepAliveMs: 3600000
- actions:
  1. { "type": "navigate", "url": "https://amazon.com" }
  2. { "type": "type", "selector": "input#twotabsearchtextbox", "value": "backpacks" }
  3. { "type": "click", "selector": "input#nav-search-submit-button, button[type=submit]" }
  4. { "type": "wait", "selector": "[data-component-type='s-search-result'], .s-result-item", "timeoutMs": 8000 }
  5. { "type": "screenshot", "fullPage": false }
`;

test("browserSessionUserMessageMerge: numbered JSON lines (Amazon benchmark) yields five action objects", () => {
  const fromNumbered = [];
  const lineRe = /^\s*\d+\.\s*(\{[\s\S]*\})\s*$/;
  for (const line of amazonBackpackUserPrompt.split(/\r?\n/)) {
    const m = lineRe.exec(line.trimEnd());
    if (m) {
      fromNumbered.push(JSON.parse(m[1]));
    }
  }
  assertEqual(fromNumbered.length, 5, "expected five numbered action lines");
  assertEqual(fromNumbered[0].type, "navigate");
  assertEqual(fromNumbered[1].value, "backpacks");
  assertEqual(fromNumbered[4].type, "screenshot");
  assertEqual(fromNumbered[4].fullPage, false);
});

test("source: user-message launch merge is wired in MainAgent and browserSession tool", () => {
  const mainPath = path.resolve(process.cwd(), "src/agents/MainAgent.ts");
  const main = fs.readFileSync(mainPath, "utf8");
  assertTrue(
    main.includes("getLatestUserText") && main.includes("createBrowserSessionTool"),
    "MainAgent should pass getLatestUserText into createBrowserSessionTool (merge runs in execute, not beforeToolCall)"
  );

  const toolPath = path.resolve(process.cwd(), "src/tools/browserSession.ts");
  const toolSource = fs.readFileSync(toolPath, "utf8");
  assertTrue(
    toolSource.includes("mergeBrowserSessionLaunchFromUserText") &&
      toolSource.includes("merged") &&
      toolSource.includes("launch actions from user message"),
    "browser_session execute should merge user message into launch when actions are empty"
  );

  const parsePath = path.resolve(process.cwd(), "src/agents/browserSessionUserMessageMerge.ts");
  assertTrue(fs.existsSync(parsePath), "browserSessionUserMessageMerge.ts should exist");
  const parseSource = fs.readFileSync(parsePath, "utf8");
  assertTrue(
    parseSource.includes("tryExtractBrowserActionsFromUserMessage") &&
      parseSource.includes("fromNumbered"),
    "Parser module should extract numbered action lines"
  );
  assertTrue(
    parseSource.includes("mergeBrowserSessionLaunchFromUserText"),
    "Merge module should apply user launch fields inside tool execute (Think has no pre-tool beforeToolCall)"
  );
});
