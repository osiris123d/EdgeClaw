/**
 * Tests for toolAgentReductionPipeline — map/filter/reduce execution model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldApplyReduction,
  detectListApiPattern,
  detectRootCauseSemanticFailure,
  buildCodemodeExtractionScript,
  parseCodemodeExtractionOutput,
  formatReductionResult,
  extractRequestedFieldsFromRequest,
  applyReductionPipeline,
} from "../subagents/toolAgentReductionPipeline";

// ── Detection tests ────────────────────────────────────────────────────────

test("shouldApplyReduction detects large payloads", () => {
  const largePayload = "x".repeat(50_000);
  assert.ok(
    shouldApplyReduction({
      resultText: largePayload,
      hadToolActivity: true,
      hasExplicitTruncation: false,
    })
  );
});

test("shouldApplyReduction ignores small payloads", () => {
  const smallPayload = "small result";
  assert.ok(
    !shouldApplyReduction({
      resultText: smallPayload,
      hadToolActivity: true,
      hasExplicitTruncation: false,
    })
  );
});

test("shouldApplyReduction skips when hadToolActivity=false", () => {
  const largePayload = "x".repeat(50_000);
  assert.ok(
    !shouldApplyReduction({
      resultText: largePayload,
      hadToolActivity: false,
      hasExplicitTruncation: false,
    })
  );
});

test("detectListApiPattern recognizes large JSON arrays", () => {
  const largeArray = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item${i}` })));
  assert.ok(detectListApiPattern(largeArray));
});

test("detectListApiPattern recognizes wrapped list APIs", () => {
  const wrappedList = JSON.stringify({
    items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
  });
  assert.ok(detectListApiPattern(wrappedList));
});

test("detectListApiPattern ignores small lists", () => {
  const smallList = JSON.stringify([{ id: 1 }, { id: 2 }]);
  assert.ok(!detectListApiPattern(smallList));
});

// ── Root-cause semantic failure detection ────────────────────────────────

test("detectRootCauseSemanticFailure detects missing account_id", () => {
  const result = detectRootCauseSemanticFailure("", "multiple accounts available. Please specify account_id");
  assert.equal(result.detected, true);
  assert.equal(result.failureType, "missing_tool_input");
});

test("detectRootCauseSemanticFailure detects spec error", () => {
  const result = detectRootCauseSemanticFailure("", "spec is not defined");
  assert.equal(result.detected, true);
  assert.equal(result.failureType, "wrong_tool_api");
});

test("detectRootCauseSemanticFailure detects non_retryable", () => {
  const result = detectRootCauseSemanticFailure("", 'nonRetryable: true');
  assert.equal(result.detected, true);
  assert.equal(result.failureType, "non_retryable");
});

test("detectRootCauseSemanticFailure ignores large payloads without semantic errors", () => {
  const largeJson = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
  const result = detectRootCauseSemanticFailure("", largeJson);
  assert.equal(result.detected, false);
});

// ── Field extraction from request ──────────────────────────────────────────

test("extractRequestedFieldsFromRequest parses 'find' pattern", () => {
  const fields = extractRequestedFieldsFromRequest("find id, name, status");
  assert.deepEqual(fields, ["id", "name", "status"]);
});

test("extractRequestedFieldsFromRequest parses 'extract' pattern", () => {
  const fields = extractRequestedFieldsFromRequest("extract account_id, api_token");
  assert.deepEqual(fields, ["account_id", "api_token"]);
});

test("extractRequestedFieldsFromRequest returns undefined when no pattern found", () => {
  const fields = extractRequestedFieldsFromRequest("list all items");
  assert.equal(fields, undefined);
});

// ── Codemode extraction script building ─────────────────────────────────────

test("buildCodemodeExtractionScript generates valid extraction code", () => {
  const script = buildCodemodeExtractionScript({
    userRequest: "find id and name",
    resultJson: JSON.stringify([{ id: 1, name: "a", other: "x" }]),
  });
  assert.match(script, /extract/i);
  assert.match(script, /scannedCount/);
  assert.match(script, /matchedCount/);
});

// ── Codemode output parsing ────────────────────────────────────────────────

test("parseCodemodeExtractionOutput parses valid output", () => {
  const output = JSON.stringify({
    extracted: [{ id: 1, name: "test" }],
    scannedCount: 100,
    matchedCount: 1,
    fields: ["id", "name"],
  });
  const result = parseCodemodeExtractionOutput(output);
  assert.equal(result.scannedCount, 100);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.extracted.length, 1);
});

test("parseCodemodeExtractionOutput handles invalid JSON gracefully", () => {
  const result = parseCodemodeExtractionOutput("not json");
  assert.equal(result.scannedCount, 0);
  assert.equal(result.extracted.length, 0);
});

// ── Result formatting ─────────────────────────────────────────────────────

test("formatReductionResult produces markdown summary", () => {
  const formatted = formatReductionResult({
    extracted: [{ id: 1, name: "item1" }],
    scannedCount: 100,
    matchedCount: 50,
    fields: ["id", "name"],
    userRequest: "find items",
  });
  assert.match(formatted, /Summary/);
  assert.match(formatted, /Extracted Fields/);
  assert.match(formatted, /Results/);
});

// ── Reduction pipeline integration ─────────────────────────────────────────

test("applyReductionPipeline detects root-cause and stops", async () => {
  const result = await applyReductionPipeline({
    toolResult: "Error: missing account_id parameter",
    userRequest: "list items",
    hadToolActivity: true,
    availableTools: {},
  });
  assert.equal(result.transformed, false);
  assert.match(result.failureReason || "", /missing_tool_input/i);
});

test("applyReductionPipeline extracts fields from JSON array", async () => {
  const largeArray = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item${i}`, other: "data" })));
  const result = await applyReductionPipeline({
    toolResult: largeArray,
    userRequest: "find id and name",
    hadToolActivity: true,
    availableTools: {},
  });
  assert.ok(result.transformed);
  assert.equal(result.scannedCount, 100);
  assert.ok(result.matchedCount > 0);
  assert.match(result.compactText, /Summary/);
});

test("applyReductionPipeline limits output to MAX_INLINE_ITEMS", async () => {
  const hugeArray = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i })));
  const result = await applyReductionPipeline({
    toolResult: hugeArray,
    userRequest: "list all",
    hadToolActivity: true,
    availableTools: {},
  });
  assert.ok(result.transformed);
  assert.equal(result.scannedCount, 200);
  assert.ok(result.matchedCount <= 50);
});

test("applyReductionPipeline skips transformation for small payloads", async () => {
  const result = await applyReductionPipeline({
    toolResult: "small result",
    userRequest: "find data",
    hadToolActivity: true,
    availableTools: {},
  });
  assert.equal(result.transformed, false);
});
