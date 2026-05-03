/**
 * Browser session tool schema/wiring tests.
 *
 * These tests validate that the public browser_session surface exposes the
 * structured action flow and forwards fields into BrowserSessionManager.
 */

import fs from "node:fs";
import path from "node:path";

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy, got ${value}`);
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(message || `Expected source to include: ${needle}`);
  }
}

const sourcePath = path.resolve(process.cwd(), "src/tools/browserSession.ts");
const source = fs.readFileSync(sourcePath, "utf8");

test("launch schema includes actions and reusable-session controls", () => {
  assertIncludes(source, "operation: z.literal(\"launch\")");
  assertIncludes(source, "actions: z");
  assertIncludes(source, ".array(BrowserActionSchema)");
  assertIncludes(source, "sessionMode: z");
  assertIncludes(source, "keepAliveMs: z");
  assertIncludes(source, "reuseSessionId: z");
  assertIncludes(source, "pauseForHuman: z");
  assertIncludes(source, "pauseForHumanOnBlocker: z");
  assertIncludes(source, "recordingEnabled: z");
});

test("step and resume schema include actions with optional cdpScript", () => {
  assertIncludes(source, "operation: z.literal(\"step\")");
  assertIncludes(source, "operation: z.literal(\"resume\")");
  assertIncludes(source, "cdpScript: z.string().optional()");
  assertIncludes(source, "Structured actions to execute: navigate, click, type, wait, screenshot.");
  assertIncludes(source, "Structured actions to execute after reconnect: navigate, click, type, wait, screenshot.");
});

test("BrowserAction schema is imported and reused", () => {
  assertIncludes(source, "import { BrowserActionSchema } from \"../browserSession/browserActions\";");
  const count = (source.match(/\.array\(BrowserActionSchema\)/g) || []).length;
  assertTrue(count >= 3, "Expected BrowserActionSchema to be reused in launch, step, and resume");
});

test("execute wiring forwards actions to manager launch and resume", () => {
  assertIncludes(source, "actions: args.actions,");
  assertIncludes(source, "return manager.launch({");
  assertIncludes(source, "return manager.resume(args.sessionId, {");
});

test("description explicitly shows actions-array example and task guidance", () => {
  assertIncludes(source, "Search for backpacks on Amazon");
  assertIncludes(source, "\\\"actions\\\": [");
  assertIncludes(source, "For normal browsing tasks, prefer actions over cdpScript.");
  assertIncludes(source, "Do not encode JSON, selectors, or action syntax inside the task string.");
  assertIncludes(source, "Task should be a short summary only");
});
