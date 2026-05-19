/**
 * End-to-end behavior tests for ToolAgent success-aware finalization.
 * Tests that successful API retrieval is not overridden by earlier exploratory errors.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeSuccessAware,
} from "../toolAgentSuccessAwareFinalization";

test("E2E: Earlier tool error followed by successful API response returns ok=true", () => {
  // Simulates scenario where first tool call (openapi_search) fails with "spec not defined",
  // but second tool call (codemode) succeeds with real API data
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: spec is not defined in codemode environment

---

[codemode]
{"users": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true, "Should be success despite earlier error");
  assert.ok(result.extractedResult, "Should have extracted result");
  assert.equal(result.where, "codemode");
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.includes("openapi_search"));
});

test("E2E: Huge stringified JSON API response with requested ids returns ok=true compact result", () => {
  // Simulates a large list API response that needs extraction
  const largeResponse = JSON.stringify(
    Array.from({ length: 5000 }, (_, i) => ({
      id: `resource-${i}`,
      name: `Resource ${i}`,
      status: "active",
      type: "item",
      metadata: { created: new Date().toISOString() },
    }))
  );

  const result = finalizeSuccessAware({
    synthesisText: `[cloudflare_request]
${largeResponse}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.ok(result.scannedCount, "Should have scanned count");
  if (result.scannedCount) {
    assert.equal(result.scannedCount, 5000);
  }
});

test("E2E: Truncated payload does not become root-cause failure if partial requested fields are extractable", () => {
  // Simulates a truncated JSON response (cut off mid-stream)
  const truncated = '[{"id": 1, "name": "Resource A", "status": "active"}, {"id": 2, "name": "Reso';

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${truncated}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  // Should still succeed because we have extractable fields from the partial objects
  assert.equal(result.shouldBeSuccess, true);
  assert.ok(result.extractedResult, "Should have extracted partial data");
});

test("E2E: Invalid control character in JSON string does not cause final task failure when data can be extracted", () => {
  // JSON with escaped newline in string value
  const jsonWithControlChar = JSON.stringify({
    results: [
      { id: 1, name: "Resource A", description: "Line1\nLine2" },
      { id: 2, name: "Resource B", description: "Single" },
    ],
  });

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${jsonWithControlChar}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.ok(result.extractedResult);
});

test("E2E: Old 'spec is not defined' error is reported only as warning after later success", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[tools_describe]
error: spec is not defined

---

[openapi_search]
error: wrong execution context

---

[codemode]
{"data": [{"id": "acc-123"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "codemode");
  // Both earlier errors should be in warnings
  assert.ok(result.warnings.length >= 2);
  assert.ok(result.warnings.some((w) => w.includes("tools_describe")));
  assert.ok(result.warnings.some((w) => w.includes("openapi_search")));
});

test("E2E: Multiple sequential failures without usable data results in failure", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: spec is not defined

---

[codemode]
error: missing account_id

---

[tools_call]
error: unknown helper`,
    resultText: "",
    errorText: "execution failed",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false);
  assert.ok(result.terminalErrorText);
  // Terminal error should be the last one
  assert.ok(result.terminalErrorText!.includes("helper") || result.terminalErrorText === "execution failed");
});

test("E2E: Final model-generated result text with data overrides tool synthesis errors", () => {
  // Case where the model's final answer contains data even though synthesis shows errors
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: cannot find spec

---

[codemode]
error: request failed`,
    resultText: '{"data": [{"id": 1, "name": "Resource"}]}',
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "final_result_text");
  assert.ok(result.extractedResult);
});

test("E2E: HTTP 2xx success in tool output is recognized as success", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[cloudflare_request]
{"status": 200, "id": 1, "data": {"account": "acc-123"}}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
});

test("E2E: Repeated same semantic error stops exploration, returns as failure", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: missing account_id

---

[codemode]
error: missing account_id required parameter`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  // This shows both calls failed with same semantic error
  // Not a success since there's no usable data
  assert.equal(result.shouldBeSuccess, false);
});

test("E2E: Empty tool activity with no data returns failure", () => {
  const result = finalizeSuccessAware({
    synthesisText: "",
    resultText: "",
    errorText: "no tools executed",
    hadToolActivity: false,
  });

  assert.equal(result.shouldBeSuccess, false);
});

test("E2E: Detect success pattern in complex nested JSON response", () => {
  const complexJson = JSON.stringify({
    success: true,
    pageInfo: { totalCount: 100, nextToken: "token123" },
    resources: Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Resource ${i}` })),
  });

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]\n${complexJson}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
});

test("E2E: Fallback extraction finds objects in malformed JSON", () => {
  // Simulates response that's truncated but has some complete JSON objects
  const malformed = `[{"id": 1, "name": "A"}, {"id": 2, "name": "B"}, {"id": 3,`;

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]\n${malformed}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  // Should have extracted at least the 2 complete objects
  assert.ok(result.extractedResult);
});

test("E2E: exact sequence - later compact MCP success wins over earlier huge/truncated payload and exploratory errors", () => {
  const hugePayload = JSON.stringify({
    items: Array.from({ length: 1500 }, (_, i) => ({
      id: `resource-${i}`,
      name: `Resource ${i}`,
      blob: "x".repeat(220),
    })),
  });

  const transcript = `[openapi_search]
{"success": true, "operations": ["list", "get"]}

---

[codemode]
${hugePayload.slice(0, 70000)}

---

[codemode]
error: reduction failed due to invalid control character while parsing large response

---

[codemode]
{"scannedCount": 26, "matchedCount": 1, "matched": ["f6d4a2b2-b84d-44e1-b6e4-a50abd9ca4d3"]}

---

[cloudflare_request]
{"id":"f6d4a2b2-b84d-44e1-b6e4-a50abd9ca4d3","name":"demo-worker","status":"active"}`;

  const result = finalizeSuccessAware({
    synthesisText: transcript,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "cloudflare_request");
  assert.ok(result.extractedResult);
  assert.ok(result.extractedResult!.includes("f6d4a2b2-b84d-44e1-b6e4-a50abd9ca4d3"));
  assert.ok(result.extractedResult!.includes("demo-worker"));
  assert.ok(!result.extractedResult!.includes("resource-1499"), "Final result must not be poisoned by earlier huge payload");
  assert.ok(result.warnings.some((w) => /reduction failed/i.test(w)), "Earlier reduction failure should be preserved only as warning");
});

test("E2E: regression - when no later success exists, semantic failure remains terminal", () => {
  const transcript = `[openapi_search]
{"success": true, "operations": ["list", "get"]}

---

[codemode]
{"items": [{"id":"r1"}, {"id":"r2"}]}

---

[codemode]
error: spec is not defined in this execution context

---

[cloudflare_request]
error: missing account_id required parameter`;

  const result = finalizeSuccessAware({
    synthesisText: transcript,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false);
  assert.ok(result.terminalErrorText);
  assert.ok(/missing account_id|required parameter/i.test(result.terminalErrorText!));
});

test("E2E: endpoint discovery alone is not terminal success", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
{"ok":true,"endpoints":[{"method":"GET","path":"/accounts/{account_id}/gateway/rules"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false);
  assert.ok(result.terminalErrorText);
});

test("E2E: openapi_describe schema metadata alone is not terminal success", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_describe_operation]
{"ok":true,"path":"/accounts/{account_id}/gateway/rules","method":"GET","openapiParameterSlots":1,"openapiRequestBodies":0}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false);
  assert.ok(result.terminalErrorText);
});

test("E2E: compact reduced cloudflare_request output is terminal success", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[cloudflare_request]
{"ok":true,"scannedCount":4,"matchedCount":2,"matched":[{"rule_id":"r1"},{"rule_id":"r2"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "cloudflare_request");
  assert.equal(result.scannedCount, 4);
  assert.equal(result.matchedCount, 2);
});
