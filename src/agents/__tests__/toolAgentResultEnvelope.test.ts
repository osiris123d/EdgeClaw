import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolAgentResultEnvelope,
  classifyToolAgentFailure,
  formatToolAgentFailureAssistantMessage,
} from "../toolAgentResultEnvelope";

test("too-large Gateway rules style response -> failure_type=too_much_data with retry prompt", () => {
  const env = buildToolAgentResultEnvelope({
    ok: false,
    errorText:
      "TRUNCATED: Response was ~184000 tokens and exceeded context limit while listing gateway rules",
    hadToolActivity: true,
  });
  assert.equal(env.ok, false);
  assert.equal(env.failure?.type, "too_much_data");
  assert.ok((env.failure?.suggestedRetryPrompt ?? "").length > 0);
});

test("missing account_id -> failure_type=missing_tool_input", () => {
  const env = buildToolAgentResultEnvelope({
    ok: false,
    errorText: "multiple accounts found; please specify account_id parameter",
    hadToolActivity: true,
  });
  assert.equal(env.failure?.type, "missing_tool_input");
});

test("spec is not defined -> failure_type=wrong_tool_api", () => {
  const env = buildToolAgentResultEnvelope({
    ok: false,
    errorText: "ReferenceError: spec is not defined in execute tool",
    hadToolActivity: true,
  });
  assert.equal(env.failure?.type, "wrong_tool_api");
});

test("invalid tools_call input shape -> failure_type=wrong_tool_api", () => {
  const env = buildToolAgentResultEnvelope({
    ok: false,
    errorText: "unknown_helper_argument: invalid tools_call input shape",
    hadToolActivity: true,
  });
  assert.equal(env.failure?.type, "wrong_tool_api");
});

test("empty result after tool activity -> failure_type=empty_result", () => {
  const env = buildToolAgentResultEnvelope({
    ok: true,
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(env.ok, false);
  assert.equal(env.failure?.type, "empty_result");
});

test("success envelope preserves compact matched metadata", () => {
  const env = buildToolAgentResultEnvelope({
    ok: true,
    resultText: "Matched 2 items",
    hadToolActivity: true,
    scannedCount: 10,
    matchedCount: 2,
    matched: [{ rule_id: "r1" }, { rule_id: "r2" }],
  });
  assert.equal(env.ok, true);
  assert.equal(env.scannedCount, 10);
  assert.equal(env.matchedCount, 2);
  assert.ok(Array.isArray(env.matched));
  assert.equal(env.matched?.length, 2);
});

test("nonRetryable tool payload -> failure_type=non_retryable", () => {
  const out = classifyToolAgentFailure({
    resultText: '{"ok":false,"nonRetryable":true,"nonRetryableKind":"api_authentication_error"}',
    errorText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "non_retryable");
});

test("failure formatter includes what/where/evidence/next/retry/partial findings", () => {
  const body = formatToolAgentFailureAssistantMessage({
    ok: false,
    failure: {
      type: "missing_tool_input",
      where: "tools_call",
      summary: "Required input missing",
      evidence: "please specify account_id",
      suggestedFix: "Provide account_id",
      suggestedRetryPrompt: "Retry with explicit account_id.",
    },
    partialResultText: "Found candidate projects: p1, p2",
  });
  assert.ok(body.includes("What failed:"));
  assert.ok(body.includes("Where:"));
  assert.ok(body.includes("Evidence:"));
  assert.ok(body.includes("What to do next:"));
  assert.ok(body.includes("Retry prompt:"));
  assert.ok(body.includes("Partial findings:"));
});

// ── Root-cause-first regression tests ─────────────────────────────────────────

test("large transcript of repeated account_id errors → missing_tool_input, not too_much_data", () => {
  // Build a large evidence corpus made entirely of account_id error repetitions.
  // Even though the transcript is large, the root cause is a missing input — not a data size issue.
  const singleError =
    "Error from native execute: Multiple accounts available. Please specify account_id parameter. " +
    "Found accounts: [acct-111, acct-222, acct-333]. Retry with a specific account_id.";
  const largeTranscript = Array.from({ length: 50 }, () => singleError).join("\n---\n");

  const out = classifyToolAgentFailure({
    errorText: largeTranscript,
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "missing_tool_input",
    "Repeated account_id errors must classify as missing_tool_input, not too_much_data or large_result");
});

test("account_id error + TRUNCATED marker in same corpus → missing_tool_input wins over too_much_data", () => {
  const corpus =
    "TRUNCATED: Response was ~120000 tokens. " +
    "Last error: Multiple accounts available. Please specify account_id parameter.";
  const out = classifyToolAgentFailure({
    errorText: corpus,
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "missing_tool_input",
    "Semantic root-cause must beat size classification when both patterns present");
});

test("tool activity + no useful final text with no error → empty_result", () => {
  const env = buildToolAgentResultEnvelope({
    ok: false,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });
  assert.equal(env.ok, false);
  assert.equal(env.failure?.type, "empty_result");
});

test("failure formatter: output is Markdown with structured sections, no raw transcript dump", () => {
  const rawTranscript =
    "```json\n[{\"id\":1},{\"id\":2},...300 more items...]\n```\n" +
    "Tool output: LOTS of raw codemode stuff here that should not appear";
  const body = formatToolAgentFailureAssistantMessage({
    ok: false,
    failure: {
      type: "wrong_tool_api",
      where: "tools_call",
      summary: "ToolAgent used wrong API shape",
      evidence: "spec is not defined",  // compacted snippet, not full transcript
      suggestedFix: "Use tools_describe before invoking",
      suggestedRetryPrompt: "Retry with correct API shape",
    },
  });
  // Output must NOT contain the raw codemode/json transcript
  assert.ok(!body.includes(rawTranscript), "formatter must not dump raw transcripts");
  // Output must be structured Markdown
  assert.ok(body.includes("Failure type:"), "has failure type header");
  assert.ok(body.includes("What failed:"), "has what-failed section");
  assert.ok(body.includes("What to do next:"), "has suggested-fix section");
});

// ── Phase 7 Auth-error classification regression tests ─────────────────────────

test("Phase 7: Cloudflare API error 10000 classifies as auth_error, not missing_tool_input", () => {
  const out = classifyToolAgentFailure({
    errorText:
      "Error from native execute: Cloudflare API error: 10000: Authentication error. " +
      "The token does not have permission for the requested account.",
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "auth_error",
    "Cloudflare error 10000 must be classified as auth_error, not missing_tool_input");
  assert.ok((out?.semanticKey ?? "").includes("cloudflare_api_10000"),
    "semantic key must reference cloudflare_api_10000");
  assert.ok((out?.suggestedFix ?? "").includes("token"),
    "fix must mention token/account binding");
});

test("Phase 7: Mixed evidence (earlier missing_tool_input + later Authentication error) resolves to auth_error", () => {
  // Simulate a scenario where the first attempt failed with missing account_id,
  // then account_id was injected, but now we get auth_error.
  const mixedEvidence =
    "First attempt: Error - Multiple accounts available. Please specify account_id parameter.\n" +
    "Retry with account_id=acct-123:\n" +
    "Error from native execute: Cloudflare API error: 10000: Authentication error";

  const out = classifyToolAgentFailure({
    errorText: mixedEvidence,
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "auth_error",
    "Mixed evidence with both account_id error and auth_error must resolve to auth_error (root cause wins)");
});

test("conflicting_tool_input has highest precedence over auth/missing patterns", () => {
  const out = classifyToolAgentFailure({
    errorText:
      "[EdgeClaw][mcp-required-input-inject-conflict] type=conflicting_tool_input tool=tool_X parameter=account_id existing=acct-a context=acct-b " +
      "Cloudflare API error: 10000: Authentication error",
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "conflicting_tool_input");
  assert.equal(out?.semanticKey, "conflicting_tool_input:top_level_identifier_mismatch");
});

test("permission errors classify as permission_error before missing_tool_input", () => {
  const out = classifyToolAgentFailure({
    errorText: "403 Forbidden: permission denied for requested resource; please specify account_id parameter",
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "permission_error");
});

test("missing helper/tool surface maps to wrong_tool_api", () => {
  const out = classifyToolAgentFailure({
    errorText: "Unknown wrapped tool \"tool_missing_execute\"; no_wrapped_execute_tool",
    resultText: "",
    hadToolActivity: true,
  });
  assert.equal(out?.type, "wrong_tool_api");
});

