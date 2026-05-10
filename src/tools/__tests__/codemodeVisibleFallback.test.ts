/**
 * Fallback assistant copy when Codemode fails visibly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCodemodeFailureAssistantMarkdown,
  isAssistantReplySilentAfterCodemodes,
} from "../codemodeVisibleFallback";

test("silent detection: empty and Done variants", () => {
  assert.equal(isAssistantReplySilentAfterCodemodes(""), true);
  assert.equal(isAssistantReplySilentAfterCodemodes("   "), true);
  assert.equal(isAssistantReplySilentAfterCodemodes("Done"), true);
  assert.equal(isAssistantReplySilentAfterCodemodes("done."), true);
  assert.equal(isAssistantReplySilentAfterCodemodes("Here's the answer."), false);
});

test("formatCodemodeFailureAssistantMarkdown emits non-empty visible summary", () => {
  const md = formatCodemodeFailureAssistantMarkdown(["Code execution failed: spec is not defined"]);
  assert.ok(md.includes("Codemode error"));
  assert.ok(md.includes("spec is not defined"));
  assert.ok(md.includes("openapi_search"));
});

test("fallback markdown includes nested code hint when appropriate", () => {
  const md = formatCodemodeFailureAssistantMarkdown(["Error: Unexpected token 'const'"]);
  assert.ok(/unexpected token/i.test(md));
  assert.ok(md.includes("openapi_search"));
});

test("device inventory failure surfaces Next step with resolve hint", () => {
  const md = formatCodemodeFailureAssistantMarkdown([
    "no_device_match_after_inventory_scan (inventory scan)",
  ]);
  assert.ok(/next step/i.test(md));
  assert.ok(md.includes("resolve_device_identifier"));
});

test("RPC receiver hint when method missing surfaced", () => {
  const md = formatCodemodeFailureAssistantMarkdown([
    "The RPC receiver does not implement the method tools_find",
  ]);
  assert.ok(md.includes("tools_find({ query })"));
});
