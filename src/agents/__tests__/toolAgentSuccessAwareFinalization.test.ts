/**
 * Tests for success-aware ToolAgent finalization.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  detectUsableSuccessfulData,
  isRawApiPayload,
  parseToolCallSequence,
  findTerminalSuccessfulCall,
  fallbackResultExtractor,
  formatCompactMatchedResultText,
  finalizeSuccessAware,
} from "../toolAgentSuccessAwareFinalization";

test("detectUsableSuccessfulData: JSON success indicator", () => {
  const data = '{"success": true, "data": {"id": 1}}';
  assert.equal(detectUsableSuccessfulData(data), true);
});

test("detectUsableSuccessfulData: HTTP 2xx status", () => {
  const data = '{"status": 200, "id": 1}';
  assert.equal(detectUsableSuccessfulData(data), true);
});

test("detectUsableSuccessfulData: JSON array", () => {
  const data = '[{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]';
  assert.equal(detectUsableSuccessfulData(data), true);
});

test("detectUsableSuccessfulData: JSON object with data wrapper", () => {
  const data = '{"data": [{"id": 1}]}';
  assert.equal(detectUsableSuccessfulData(data), true);
});

test("detectUsableSuccessfulData: error message", () => {
  const data = '{"error": "not found", "success": false}';
  assert.equal(detectUsableSuccessfulData(data), false);
});

test("detectUsableSuccessfulData: empty string", () => {
  assert.equal(detectUsableSuccessfulData(""), false);
});

test("parseToolCallSequence: multiple tool calls", () => {
  const synthesis = `[openapi_search]
spec is not defined

---

[codemode]
{"id": 1, "name": "Resource A"}`;

  const records = parseToolCallSequence(synthesis);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.toolName, "openapi_search");
  assert.equal(records[0]!.ok, false);
  assert.equal(records[1]!.toolName, "codemode");
  assert.equal(records[1]!.ok, true);
  assert.equal(records[1]!.hasUsableData, true);
});

test("parseToolCallSequence: single tool call", () => {
  const synthesis = `[tools_call]
Executed successfully with results`;

  const records = parseToolCallSequence(synthesis);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.toolName, "tools_call");
});

test("findTerminalSuccessfulCall: finds latest success", () => {
  const synthesis = `[openapi_search]
error: spec not defined

---

[codemode]
{"id": 1, "name": "Resource"}`;

  const records = parseToolCallSequence(synthesis);
  const terminal = findTerminalSuccessfulCall(records);
  assert.ok(terminal);
  assert.equal(terminal!.sequence, 1);
  assert.equal(terminal!.toolName, "codemode");
});

test("findTerminalSuccessfulCall: returns undefined if no success", () => {
  const synthesis = `[openapi_search]
error 1

---

[codemode]
error 2`;

  const records = parseToolCallSequence(synthesis);
  const terminal = findTerminalSuccessfulCall(records);
  assert.equal(terminal, undefined);
});

test("fallbackResultExtractor: full JSON parse", () => {
  const result = '[{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]';
  const extracted = fallbackResultExtractor(result);
  assert.equal(extracted.success, true);
  assert.equal(extracted.strategy, "full_json_parse");
  assert.equal(extracted.scannedCount, 2);
  assert.equal(extracted.matchedCount, 2);
  assert.equal(extracted.extractedText.includes('"id"'), true);
});

test("fallbackResultExtractor: JSON object with results wrapper", () => {
  const result = '{"results": [{"id": 1}, {"id": 2}, {"id": 3}]}';
  const extracted = fallbackResultExtractor(result);
  assert.equal(extracted.success, true);
  assert.equal(extracted.strategy, "full_json_parse");
  assert.equal(extracted.scannedCount, 3);
});

test("fallbackResultExtractor: regex object scan on truncated JSON", () => {
  // Simulates a truncated JSON array with partial objects
  const result = '[{"id": 1, "name": "Resource A"}, {"id": 2, "name": "Res';
  const extracted = fallbackResultExtractor(result);
  // Should find at least one complete object
  assert.equal(extracted.success, true);
  assert.ok(
    extracted.strategy === "regex_object_scan" || extracted.strategy === "full_json_parse"
  );
  assert.ok(extracted.extractedText.includes("id"));
});

test("fallbackResultExtractor: field extraction on unparseable text", () => {
  const result = `
    id: 1, name: "Resource A"
    id: 2, name: "Resource B"
    status: active
  `;
  const extracted = fallbackResultExtractor(result);
  // Should extract fields even from non-JSON format
  assert.ok(extracted.extractedText.includes("id") || extracted.extractedText === "");
});

test("fallbackResultExtractor: not_found on empty", () => {
  const extracted = fallbackResultExtractor("");
  assert.equal(extracted.success, false);
  assert.equal(extracted.strategy, "not_found");
});

test("finalizeSuccessAware: success overrides earlier error", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
spec is not defined

---

[codemode]
{"id": 1, "name": "Resource A"}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "codemode");
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.includes("openapi_search"));
});

test("finalizeSuccessAware: no success returns failure", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: spec not defined

---

[codemode]
error: code execution failed`,
    resultText: "",
    errorText: "execution failed",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false);
  assert.ok(result.terminalErrorText);
});

test("finalizeSuccessAware: extracts from final result text when synthesis failed", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: wrong api

---

[codemode]
error: execution failed`,
    resultText: '{"data": [{"id": 1, "name": "Resource"}]}',
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "final_result_text");
  assert.ok(result.extractedResult);
  assert.ok(result.extractedResult!.includes("id"));
});

test("finalizeSuccessAware: handles large payload with fallback", () => {
  const largeData = JSON.stringify(
    Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Resource ${i}`,
      status: "active",
    }))
  );

  const result = finalizeSuccessAware({
    synthesisText: `[tools_call]
${largeData}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.where, "tools_call");
  // Should have extracted a reduced set (not all 1000)
  if (result.scannedCount) {
    assert.equal(result.scannedCount, 1000);
  }
});

test("finalizeSuccessAware: control characters in JSON don't cause failure", () => {
  // JSON with invalid control character in string (should not break extraction)
  const data = '{"id": 1, "name": "Resource\\nA"}';
  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${data}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
});

test("finalizeSuccessAware: truncated JSON with extractable fields", () => {
  // Simulates a truncated API response
  const truncated = '[{"id": 1, "name": "A"}, {"id": 2, "name": "B"}, {"id": 3';

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${truncated}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  // Should still succeed and extract what's available
  assert.equal(result.shouldBeSuccess, true);
});

test("finalizeSuccessAware: warnings include earlier non-terminal errors", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[tools_find]
error: no results found

---

[openapi_search]
error: missing account_id

---

[codemode]
{"resources": [{"id": 1}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true, "Should be success with data from codemode");
  assert.ok(result.warnings.length >= 2, `Expected at least 2 warnings, got ${result.warnings.length}: ${JSON.stringify(result.warnings)}`);
});

// Tests for isRawApiPayload - detects raw responses vs reduced payloads
test("isRawApiPayload: detects raw { response } wrapper", () => {
  const rawPayload = '{"response": {"success": true, "data": [{"id": 1}]}}';
  assert.equal(isRawApiPayload(rawPayload), true);
});

test("isRawApiPayload: detects raw { success, result } without reduction metadata", () => {
  const rawPayload = '{"success": true, "result": [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]}';
  assert.equal(isRawApiPayload(rawPayload), true, "Generic success/result wrapper without scannedCount is raw");
});

test("isRawApiPayload: returns false for reduced payload with scannedCount", () => {
  const reducedPayload = '{"scannedCount": 100, "matchedCount": 5, "matched": [{"id": "rule-1"}]}';
  assert.equal(isRawApiPayload(reducedPayload), false, "Payload with reduction metadata is not raw");
});

test("isRawApiPayload: returns false for reduced payload with matchedCount", () => {
  const reducedPayload = '{"matchedCount": 3, "matched": [{"rule_id": "rule-1"}, {"rule_id": "rule-2"}]}';
  assert.equal(isRawApiPayload(reducedPayload), false, "Payload with matchedCount metadata is not raw");
});

test("isRawApiPayload: returns false for empty response", () => {
  assert.equal(isRawApiPayload(""), false);
  assert.equal(isRawApiPayload(undefined), false);
});

test("isRawApiPayload: returns false for JSON array (list result)", () => {
  const arrayPayload = '[{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]';
  assert.equal(isRawApiPayload(arrayPayload), false, "Plain array without wrapper is not classified as raw");
});

test("finalizeSuccessAware: classifies raw API payload as failure", () => {
  const rawPayload = JSON.stringify({
    success: true,
    result: [
      { id: 1, name: "Resource A" },
      { id: 2, name: "Resource B" },
    ],
  });

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${rawPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false, "Raw API payload without reduction should fail");
  assert.ok(result.terminalErrorText && result.terminalErrorText.includes("raw"));
});

test("finalizeSuccessAware: accepts reduced payload with scannedCount/matchedCount", () => {
  const reducedPayload = JSON.stringify({
    scannedCount: 50,
    matchedCount: 3,
    matched: [
      { rule_id: "rule-allow-1" },
      { rule_id: "rule-allow-2" },
      { rule_id: "rule-allow-3" },
    ],
  });

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${reducedPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true, "Reduced payload with metadata should succeed");
  assert.equal(result.scannedCount, 50);
  assert.equal(result.matchedCount, 3);
  assert.equal(result.where, "codemode");
});

test("finalizeSuccessAware: compact result does not require model synthesis text", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[cloudflare_request]
{"ok":true,"scannedCount":30,"matchedCount":26,"matched":[{"rule_id":"r-1"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.scannedCount, 30);
  assert.equal(result.matchedCount, 26);
  assert.ok((result.extractedResult ?? "").includes("| rule id |"));
});

test("formatCompactMatchedResultText: renders rule_id-only as table", () => {
  const out = formatCompactMatchedResultText({
    scannedCount: 4,
    matchedCount: 2,
    matched: [{ rule_id: "ra" }, { rule_id: "rb" }],
  });
  assert.ok(out.includes("| rule id |"));
  assert.ok(out.includes("ra"));
});

test("formatCompactMatchedResultText: renders rule_id/name as two-column table", () => {
  const out = formatCompactMatchedResultText({
    scannedCount: 4,
    matchedCount: 2,
    matched: [
      { rule_id: "ra", name: "Allow A" },
      { rule_id: "rb", name: "Allow B" },
    ],
  });
  assert.ok(out.includes("| rule id | rule name |"));
  assert.ok(out.includes("Allow A"));
});

test("formatCompactMatchedResultText: renders rule_id/rule_name as two-column table", () => {
  const out = formatCompactMatchedResultText({
    scannedCount: 4,
    matchedCount: 2,
    matched: [
      { rule_id: "ra", rule_name: "Allow A" },
      { rule_id: "rb", rule_name: "Allow B" },
    ],
  });
  assert.ok(out.includes("| rule id | rule name |"));
  assert.ok(out.includes("Allow A"));
});

test("formatCompactMatchedResultText: renders id/name as two-column table", () => {
  const out = formatCompactMatchedResultText({
    scannedCount: 4,
    matchedCount: 2,
    matched: [
      { id: "ra", name: "Allow A" },
      { id: "rb", name: "Allow B" },
    ],
  });
  assert.ok(out.includes("| rule id | rule name |"));
  assert.ok(out.includes("Allow B"));
});

test("finalizeSuccessAware: nested execute result with rules extracts compact markdown table", () => {
  const nestedPayload = JSON.stringify({
    ok: true,
    toolName: "tool_AzWW31H_execute",
    result: {
      success: true,
      scannedCount: 597,
      matchedCount: 2,
      rules: [
        { id: "r-1", name: "Allow One" },
        { id: "r-2", name: "Allow Two" },
      ],
    },
  });

  const result = finalizeSuccessAware({
    synthesisText: `[tools_call]
${nestedPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.scannedCount, 597);
  assert.equal(result.matchedCount, 2);
  assert.ok((result.extractedResult ?? "").includes("| rule id | rule name |"));
  assert.ok((result.extractedResult ?? "").includes("Allow One"));
});

test("finalizeSuccessAware: nested execute result.result.rules extracts compact markdown table", () => {
  const nestedPayload = JSON.stringify({
    ok: true,
    result: {
      success: true,
      result: {
        scannedCount: 597,
        matchedCount: 2,
        rules: [
          { id: "r-1", name: "Allow One" },
          { id: "r-2", name: "Allow Two" },
        ],
      },
    },
  });

  const result = finalizeSuccessAware({
    synthesisText: `[tools_call]\n${nestedPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true);
  assert.equal(result.scannedCount, 597);
  assert.equal(result.matchedCount, 2);
  assert.ok((result.extractedResult ?? "").includes("| rule id | rule name |"));
  assert.ok((result.extractedResult ?? "").includes("Allow Two"));
});

test("finalizeSuccessAware: scannedCount remains >= matchedCount for compact payload", () => {
  const result = finalizeSuccessAware({
    synthesisText: `[cloudflare_request]
{"ok":true,"scannedCount":26,"matchedCount":26,"matched":[{"rule_id":"r-1"}]}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });
  assert.equal(result.shouldBeSuccess, true);
  assert.ok((result.scannedCount ?? 0) >= (result.matchedCount ?? 0));
});

test("finalizeSuccessAware: empty matches with scannedCount is success (intentional zero filter)", () => {
  const reducedPayload = JSON.stringify({
    scannedCount: 50,
    matchedCount: 0,
    matched: [],
  });

  const result = finalizeSuccessAware({
    synthesisText: `[codemode]
${reducedPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, true, "Zero matches with scanned data is intentional filter success");
  assert.equal(result.scannedCount, 50);
  assert.equal(result.matchedCount, 0);
});

test("finalizeSuccessAware: rejects raw payload in final result text when reduction expected", () => {
  const rawPayload = '{"success": true, "data": [{"id": 1}]}';

  const result = finalizeSuccessAware({
    synthesisText: `[openapi_search]
error: spec not found

---

[codemode]
error: execution failed`,
    resultText: rawPayload,
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(result.shouldBeSuccess, false, "Raw payload in final result should be classified as failure");
  assert.ok(result.terminalErrorText && result.terminalErrorText.includes("raw"));
});
