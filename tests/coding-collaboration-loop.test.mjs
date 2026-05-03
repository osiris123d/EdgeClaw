/**
 * Coding collaboration loop — pure helpers (mirrored from `src/agents/codingLoop/*.ts`; keep in sync).
 *
 * Tests verdict parsing, pending-patch diffing, policies, and patch scope without compiling MainAgent.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ─── Mirrors: codingLoopPatchScope.ts ─────────────────────────────────────────

function resolveActivePatchIdsForVerification(input) {
  if (input.focusPatchIds != null && input.focusPatchIds.length > 0) {
    const allow = new Set(input.pendingAfterCoder);
    return [...input.focusPatchIds].filter((id) => allow.has(id));
  }
  if (input.scopeTesterToNewPatchesOnly && input.newPendingPatchIds.length > 0) {
    return [...input.newPendingPatchIds];
  }
  return [...input.pendingAfterCoder];
}

// ─── Mirrors: codingLoopPolicies.ts ─────────────────────────────────────────────

function normalizeTesterFeedbackForComparison(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, 8000);
}

function detectRepeatedFailure(previousNormalized, currentNormalized, streak) {
  if (!previousNormalized || !currentNormalized) {
    return { nextStreak: 1, isRepeated: false };
  }
  if (previousNormalized === currentNormalized) {
    const next = streak + 1;
    return { nextStreak: next, isRepeated: next >= 2 };
  }
  return { nextStreak: 1, isRepeated: false };
}

// ─── Mirrors: promotionFromCodingLoop.ts (pure classification) ─────────────────

function isFailedVerificationResult(loopResult) {
  const s = loopResult.status;
  if (
    s === "completed_failure" ||
    s === "stopped_aborted" ||
    s === "blocked_no_shared_workspace" ||
    s === "stopped_repeated_failure" ||
    s === "stopped_no_new_patches"
  ) {
    return true;
  }
  if (s === "stopped_max_iterations") {
    const last = loopResult.iterations[loopResult.iterations.length - 1];
    return !last || last.testerVerdict !== "pass";
  }
  return false;
}

// ─── Mirrors: codingLoopVerdict.ts ────────────────────────────────────────────

function parseTesterVerdict(text) {
  const t = text.trim();
  if (!t) return "unknown";
  const explicitMatch = /\bVERDICT\s*:\s*(PASS|FAIL)\b/i.exec(t);
  if (explicitMatch) {
    return explicitMatch[1].toUpperCase() === "PASS" ? "pass" : "fail";
  }
  const upper = t.toUpperCase();
  if (/\bPASS\b/i.test(upper) && !/\bFAIL\b/i.test(upper)) return "pass";
  if (/\bFAIL\b/i.test(upper)) return "fail";
  if (/\bPASSED\b/i.test(upper) || /\bSUCCESS\b/i.test(upper) || /\bOK\b/i.test(upper)) return "pass";
  if (/\bFAILED\b/i.test(upper) || /\bERROR\b/i.test(upper)) return "fail";
  return "unknown";
}

// ─── Mirrors: codingLoopPatchSync.ts ────────────────────────────────────────────

function diffNewPending(before, after) {
  const setBefore = new Set(before);
  return after.filter((id) => !setBefore.has(id));
}

test("parseTesterVerdict respects VERDICT line", () => {
  assert.equal(parseTesterVerdict("Looks fine.\nVERDICT: PASS"), "pass");
  assert.equal(parseTesterVerdict("Broken.\nVERDICT: FAIL"), "fail");
});

test("parseTesterVerdict fallback keywords", () => {
  assert.equal(parseTesterVerdict("Everything PASSED"), "pass");
  assert.equal(parseTesterVerdict("Tests FAILED"), "fail");
  assert.equal(parseTesterVerdict(""), "unknown");
});

test("diffNewPending computes new ids", () => {
  assert.deepEqual(diffNewPending(["a"], ["a", "b"]), ["b"]);
  assert.deepEqual(diffNewPending([], ["x"]), ["x"]);
});

test("resolveActivePatchIdsForVerification prefers focus ids when listed", () => {
  assert.deepEqual(
    resolveActivePatchIdsForVerification({
      focusPatchIds: ["p2"],
      scopeTesterToNewPatchesOnly: true,
      newPendingPatchIds: ["p1"],
      pendingAfterCoder: ["p1", "p2"],
    }),
    ["p2"]
  );
});

test("resolveActivePatchIdsForVerification scopes to new pending when no focus", () => {
  assert.deepEqual(
    resolveActivePatchIdsForVerification({
      focusPatchIds: undefined,
      scopeTesterToNewPatchesOnly: true,
      newPendingPatchIds: ["n1"],
      pendingAfterCoder: ["o", "n1"],
    }),
    ["n1"]
  );
});

test("detectRepeatedFailure stops on second identical normalized feedback", () => {
  const a = normalizeTesterFeedbackForComparison("FAIL\nsame root cause");
  let streak = 0;
  let prev = "";
  let r1 = detectRepeatedFailure(prev, a, streak);
  streak = r1.nextStreak;
  prev = a;
  assert.equal(r1.isRepeated, false);
  let r2 = detectRepeatedFailure(prev, a, streak);
  assert.equal(r2.isRepeated, true);
});

test("isFailedVerificationResult for PASS stopped_max_iterations is false", () => {
  assert.equal(
    isFailedVerificationResult({
      status: "stopped_max_iterations",
      iterations: [{ testerVerdict: "pass" }],
    }),
    false
  );
});

test("isFailedVerificationResult for FAIL stopped_max_iterations is true", () => {
  assert.equal(
    isFailedVerificationResult({
      status: "stopped_max_iterations",
      iterations: [{ testerVerdict: "fail" }],
    }),
    true
  );
});
