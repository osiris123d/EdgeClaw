import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_TOOLS_FALLBACK_RESPONSE,
  buildBrowserCapabilityAuditSnapshot,
  buildBrowserDisabledWarningLine,
  decideBrowserRequestGuard,
  hasBrowserToolPair,
  parseBooleanFlag,
  shouldIncludeBrowserTools,
} from "../dist/agents/browserToolAvailability.js";

test("browser flag true => browser tools included", () => {
  const parsed = parseBooleanFlag("true", false);
  assert.equal(parsed, true);
  assert.equal(
    shouldIncludeBrowserTools({
      enableBrowserTools: parsed,
      hasBrowserBinding: true,
      hasLoaderBinding: true,
    }),
    true
  );
});

test("browser flag false => browser tools excluded", () => {
  const parsed = parseBooleanFlag("false", true);
  assert.equal(parsed, false);
  assert.equal(
    shouldIncludeBrowserTools({
      enableBrowserTools: parsed,
      hasBrowserBinding: true,
      hasLoaderBinding: true,
    }),
    false
  );
});

test("browser request when tools absent => honest fallback response", () => {
  const availableToolNames = ["create_note", "search_workspace"];
  assert.equal(hasBrowserToolPair(availableToolNames), false);

  const decision = decideBrowserRequestGuard({
    userMessage: "Please browse example.com and inspect the DOM title.",
    availableToolNames,
  });

  assert.equal(decision.shouldShortCircuit, true);
  assert.equal(decision.responseText, BROWSER_TOOLS_FALLBACK_RESPONSE);
});

test("browser request when tools present => normal tool flow", () => {
  const availableToolNames = ["browser_search", "browser_execute", "create_note"];
  assert.equal(hasBrowserToolPair(availableToolNames), true);

  const decision = decideBrowserRequestGuard({
    userMessage: "Use browser_search then browser_execute to inspect page content.",
    availableToolNames,
  });

  assert.equal(decision.shouldShortCircuit, false);
  assert.equal(decision.responseText, undefined);
});

test("deploy overwrites ENABLE_BROWSER_TOOLS=false => logs clearly reveal it", () => {
  const snapshot = buildBrowserCapabilityAuditSnapshot({
    rawEnableBrowserTools: "false",
    parsedEnableBrowserTools: false,
    finalToolNames: ["create_note", "search_workspace"],
  });
  const warningLine = buildBrowserDisabledWarningLine(snapshot);

  assert.match(warningLine, /ENABLE_BROWSER_TOOLS raw=false/);
  assert.match(warningLine, /parsed=false/);
  assert.match(warningLine, /browserCapabilityAvailable=false/);
});
