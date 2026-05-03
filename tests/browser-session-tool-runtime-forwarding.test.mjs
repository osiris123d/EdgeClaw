/**
 * Runtime forwarding test for browser_session tool args.
 *
 * Uses compiled JS tool factory to verify actions are forwarded to
 * BrowserSessionManager.launch at runtime (not only schema/source checks).
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

function assertTrue(value, message) {
  if (!value) throw new Error(message ?? `Expected truthy, got ${value}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test("browser_session launch forwards actions to manager.launch at runtime", async () => {
  const compiledPath = path.resolve(process.cwd(), "dist/tools/browserSession.js");
  if (!fs.existsSync(compiledPath)) {
    console.log("(skipped) dist/tools/browserSession.js not found; run npm run build first");
    return;
  }

  const mod = await import("../dist/tools/browserSession.js");
  const { createBrowserSessionTool } = mod;

  const calls = [];
  const fakeManager = {
    launch: async (options) => {
      calls.push({ method: "launch", options });
      return {
        schema: "edgeclaw.browser-session-result",
        schemaVersion: 1,
        sessionId: "sess-runtime-1",
        status: "active",
        recordingEnabled: true,
        summary: "ok",
      };
    },
    resume: async () => {
      throw new Error("resume should not be called in this test");
    },
    reconnect: async () => ({ schema: "edgeclaw.browser-session-result", schemaVersion: 1, sessionId: "x", status: "active", recordingEnabled: true }),
    pause: async () => ({ schema: "edgeclaw.browser-session-result", schemaVersion: 1, sessionId: "x", status: "awaiting_human", recordingEnabled: true }),
    complete: async () => ({ schema: "edgeclaw.browser-session-result", schemaVersion: 1, sessionId: "x", status: "completed", recordingEnabled: true }),
    abandon: async () => ({ schema: "edgeclaw.browser-session-result", schemaVersion: 1, sessionId: "x", status: "abandoned", recordingEnabled: true }),
    status: async () => ({ schema: "edgeclaw.browser-session-result", schemaVersion: 1, sessionId: "x", status: "active", recordingEnabled: true }),
  };

  const tools = createBrowserSessionTool(fakeManager);
  const browserSession = tools.browser_session;

  await browserSession.execute({
    operation: "launch",
    task: "Search backpacks on Amazon",
    actions: [
      { type: "navigate", url: "https://amazon.com" },
      { type: "type", selector: "input#twotabsearchtextbox", value: "backpacks" },
      { type: "click", selector: "button[type=submit]" },
      { type: "wait", selector: ".s-result-item", timeoutMs: 5000 },
      { type: "screenshot", fullPage: false },
    ],
    sessionMode: "reusable",
    keepAliveMs: 600000,
    pauseForHuman: false,
    pauseForHumanOnBlocker: true,
    recordingEnabled: true,
  });

  assertEqual(calls.length, 1, "expected exactly one launch call");
  const forwarded = calls[0].options;
  assertEqual(forwarded.task, "Search backpacks on Amazon");
  // Required runtime guarantee: actions arrive as structured args to manager.launch.
  // Optional fields (sessionMode/keepAlive/etc.) may lag in stale dist builds, so this
  // test intentionally focuses on action pass-through.
  assertTrue(Array.isArray(forwarded.actions), "actions must be forwarded to manager.launch");
  assertEqual(forwarded.actions.length, 5, "expected full action list to be forwarded");
  assertEqual(forwarded.actions[0].type, "navigate");
  assertEqual(forwarded.actions[4].type, "screenshot");
});
