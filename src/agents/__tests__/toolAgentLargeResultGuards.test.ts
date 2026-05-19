/**
 * Node-safe unit tests for toolAgentLargeResultGuards.
 *
 * Covers: isLikelyLargeResult, isRawJsonDump, extractCompactFromRawResult,
 *         buildLargeResultEnvelope (success + failure paths), and guard constants.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyLargeResult,
  isRawJsonDump,
  extractCompactFromRawResult,
  buildLargeResultEnvelope,
  clampToolEvidenceForEnvelope,
  clampFinalResponse,
  MAX_FINAL_RESPONSE_CHARS,
  MAX_INLINE_ITEMS,
  MAX_TOOL_EVIDENCE_CHARS,
  MAX_RAW_TOOL_CALL_CHARS,
} from "../toolAgentLargeResultGuards";

// ── isLikelyLargeResult ────────────────────────────────────────────────────────

test("isLikelyLargeResult: TRUNCATED marker detected", () => {
  assert.equal(isLikelyLargeResult("TRUNCATED: Response was ~80000 tokens"), true);
});

test("isLikelyLargeResult: text exceeding MAX_FINAL_RESPONSE_CHARS threshold", () => {
  const big = "x".repeat(MAX_FINAL_RESPONSE_CHARS + 1);
  assert.equal(isLikelyLargeResult(big), true);
});

test("isLikelyLargeResult: JSON array with more than MAX_INLINE_ITEMS entries", () => {
  const arr = Array.from({ length: MAX_INLINE_ITEMS + 1 }, (_, i) => ({ id: i }));
  assert.equal(isLikelyLargeResult(JSON.stringify(arr)), true);
});

test("isLikelyLargeResult: small text is not flagged", () => {
  assert.equal(isLikelyLargeResult("Here are 3 results: a, b, c"), false);
});

test("isLikelyLargeResult: JSON array exactly at MAX_INLINE_ITEMS is not flagged", () => {
  const arr = Array.from({ length: MAX_INLINE_ITEMS }, (_, i) => ({ id: i }));
  assert.equal(isLikelyLargeResult(JSON.stringify(arr)), false);
});

// ── isRawJsonDump ──────────────────────────────────────────────────────────────

test("isRawJsonDump: large array is flagged as raw JSON dump", () => {
  const arr = Array.from({ length: MAX_INLINE_ITEMS + 1 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const text = JSON.stringify(arr);
  // Only flag if length exceeds the minimum threshold (MAX_RAW_TOOL_CALL_CHARS / 4)
  if (text.length > MAX_RAW_TOOL_CALL_CHARS / 4) {
    assert.equal(isRawJsonDump(text), true);
  } else {
    // Pad to trigger the guard
    const padded = JSON.stringify(arr.map((x) => ({ ...x, pad: "a".repeat(300) })));
    assert.equal(isRawJsonDump(padded), true);
  }
});

test("isRawJsonDump: small plain text is not flagged", () => {
  assert.equal(isRawJsonDump("plain text result"), false);
});

test("isRawJsonDump: compact JSON array under threshold is not flagged", () => {
  const arr = [{ id: 1 }, { id: 2 }];
  assert.equal(isRawJsonDump(JSON.stringify(arr)), false);
});

// ── extractCompactFromRawResult ────────────────────────────────────────────────

test("extractCompactFromRawResult: extracts requested fields from JSON array", () => {
  const items = Array.from({ length: 80 }, (_, i) => ({
    id: `id-${i}`,
    name: `name-${i}`,
    status: "active",
    description: "a".repeat(500),
  }));
  const result = extractCompactFromRawResult(JSON.stringify(items), ["id", "name", "status"]);
  assert.ok(result !== null, "should succeed");
  assert.equal(result!.scannedCount, 80);
  // matchedCount capped at MAX_INLINE_ITEMS
  assert.ok(result!.matchedCount <= MAX_INLINE_ITEMS);
  // extracted text should not contain description field
  assert.ok(!result!.extractedText.includes("description"));
  // extracted text should contain id and name
  assert.ok(result!.extractedText.includes("id-0"));
});

test("extractCompactFromRawResult: uses default fields when none specified", () => {
  const items = [{ id: "abc", name: "Foo", irrelevant: "bar" }];
  const result = extractCompactFromRawResult(JSON.stringify(items), []);
  assert.ok(result !== null);
  assert.ok(result!.extractedText.includes("abc"));
  assert.ok(!result!.extractedText.includes("irrelevant"));
});

test("extractCompactFromRawResult: unwraps result wrapper key", () => {
  const payload = {
    result: [{ id: "r1", name: "Thing" }],
    total: 1,
  };
  const result = extractCompactFromRawResult(JSON.stringify(payload), ["id", "name"]);
  assert.ok(result !== null);
  assert.ok(result!.extractedText.includes("r1"));
});

test("extractCompactFromRawResult: returns null for non-JSON text", () => {
  assert.equal(extractCompactFromRawResult("This is plain text", []), null);
});

// ── buildLargeResultEnvelope ───────────────────────────────────────────────────

test("buildLargeResultEnvelope: success path has ok=true with metadata", () => {
  const env = buildLargeResultEnvelope({
    extractionSucceeded: true,
    partialResultText: "Found: id-1, id-2",
    scannedCount: 150,
    matchedCount: 2,
    artifactPointer: "workspace://findings/run-abc",
  });
  assert.equal(env.ok, true);
  assert.equal(env.scannedCount, 150);
  assert.equal(env.matchedCount, 2);
  assert.equal(env.artifactPointer, "workspace://findings/run-abc");
  assert.ok(env.resultText?.includes("Found: id-1"));
  assert.ok(env.failure === undefined, "success envelope must not have failure field");
});

test("buildLargeResultEnvelope: failure path has ok=false and large_result type", () => {
  const env = buildLargeResultEnvelope({
    extractionSucceeded: false,
    evidenceText: "Raw 200KB JSON array",
    where: "tools_call",
  });
  assert.equal(env.ok, false);
  assert.equal(env.failure?.type, "large_result");
  assert.ok(env.failure?.suggestedRetryPrompt?.includes("paginated extraction"));
  assert.ok(env.suggestedRetryPrompt?.includes("paginated extraction"));
});

test("buildLargeResultEnvelope: failure envelope includes evidence clamped to guard limit", () => {
  const longEvidence = "x".repeat(20_000);
  const env = buildLargeResultEnvelope({
    extractionSucceeded: false,
    evidenceText: longEvidence,
    where: "large_result_guard",
  });
  // evidence in failure should be clamped
  assert.ok((env.failure?.evidence?.length ?? 0) <= MAX_TOOL_EVIDENCE_CHARS + 1); // +1 for ellipsis
});

// ── Clamping utilities ─────────────────────────────────────────────────────────

test("clampToolEvidenceForEnvelope: clamps long text to MAX_TOOL_EVIDENCE_CHARS", () => {
  const long = "e".repeat(MAX_TOOL_EVIDENCE_CHARS + 500);
  const clamped = clampToolEvidenceForEnvelope(long);
  assert.ok(clamped.length <= MAX_TOOL_EVIDENCE_CHARS + 1); // +1 for ellipsis char
  assert.ok(clamped.endsWith("…"));
});

test("clampToolEvidenceForEnvelope: short text passes unchanged", () => {
  const short = "short error";
  assert.equal(clampToolEvidenceForEnvelope(short), short);
});

test("clampFinalResponse: appends truncation notice beyond MAX_FINAL_RESPONSE_CHARS", () => {
  // Use a string well above the threshold so the clamped version (threshold + suffix) is still shorter.
  const big = "r".repeat(MAX_FINAL_RESPONSE_CHARS * 2);
  const clamped = clampFinalResponse(big);
  assert.ok(clamped.includes("[… result truncated"));
  assert.ok(clamped.length > MAX_FINAL_RESPONSE_CHARS, "clamped text includes suffix so it exceeds raw threshold");
  assert.ok(clamped.length < big.length, "clamped text must be shorter than the oversized input");
});

test("clampFinalResponse: small text is unchanged", () => {
  const small = "result";
  assert.equal(clampFinalResponse(small), small);
});

// ── Guard constants sanity ─────────────────────────────────────────────────────

test("guard constants are in expected order", () => {
  assert.ok(MAX_TOOL_EVIDENCE_CHARS < MAX_FINAL_RESPONSE_CHARS);
  assert.ok(MAX_INLINE_ITEMS > 0 && MAX_INLINE_ITEMS < 200);
  assert.ok(MAX_RAW_TOOL_CALL_CHARS > MAX_FINAL_RESPONSE_CHARS);
});

// ── classifyToolAgentFailure large_result integration ─────────────────────────

test("classifyToolAgentFailure: large payload without truncation marker -> large_result", async () => {
  const { buildToolAgentResultEnvelope } = await import("../toolAgentResultEnvelope");
  const bigResult = "item: " + "data ".repeat(MAX_FINAL_RESPONSE_CHARS / 5);
  const env = buildToolAgentResultEnvelope({
    ok: true,
    resultText: bigResult,
    hadToolActivity: true,
  });
  // A result text larger than the threshold should be classified or clamped
  assert.ok(
    env.failure?.type === "large_result" || (env.resultText?.length ?? 0) <= MAX_FINAL_RESPONSE_CHARS + 80,
    "large result must be classified or clamped"
  );
});

test("classifyToolAgentFailure: TRUNCATED marker stays too_much_data, not large_result", async () => {
  const { buildToolAgentResultEnvelope } = await import("../toolAgentResultEnvelope");
  const env = buildToolAgentResultEnvelope({
    ok: false,
    errorText: "TRUNCATED: Response was ~90000 tokens and hit context limit",
    hadToolActivity: true,
  });
  assert.equal(env.failure?.type, "too_much_data");
});
