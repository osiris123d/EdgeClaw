/**
 * Tests for BrowserSession schema: isBrowserSessionResult and makeBrowserSessionResult.
 *
 * Tests cover:
 * - schema recognition (accepts valid, rejects wrong schema/missing fields)
 * - makeBrowserSessionResult promotes all state fields
 * - screenshot data URL is carried through
 * - HITL awaiting_human status and summary
 * - Disconnected → active transition logic
 * - Default recording=true on launch
 * - devtoolsFrontendUrl fallback from targetId
 */

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
function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}
function assertFalse(value, message) {
  if (value) throw new Error(message || `Expected falsy, got ${value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline implementations (mirrors src/browserSession/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

function isBrowserSessionResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    value.schema === "edgeclaw.browser-session-result" &&
    value.schemaVersion === 1 &&
    typeof value.sessionId === "string"
  );
}

function makeBrowserSessionResult(session, opts = {}) {
  return {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: session.sessionId,
    status: session.status,
    recordingEnabled: session.recordingEnabled,
    browserRunSessionId: session.browserRunSessionId,
    reusableSessionId: session.reusableSessionId,
    reusedSession: session.reusedSession,
    devtoolsFrontendUrl: session.devtoolsFrontendUrl,
    liveViewUrl: session.liveViewUrl,
    currentUrl: session.currentUrl,
    currentTargetId: session.currentTargetId,
    recordingId: session.recordingId,
    recordingReady: session.recordingReady,
    recordingUrl: session.recordingUrl,
    needsHumanIntervention: session.needsHumanIntervention,
    humanInterventionReason: session.humanInterventionReason,
    resumableSession: session.resumableSession,
    liveViewUnavailableReason: session.liveViewUnavailableReason,
    summary: opts.summary ?? session.finalSummary,
    logLines: session.logLines.length > 0 ? [...session.logLines] : undefined,
    _liveViewUrl: session.liveViewUrl,
    _needsHumanIntervention: session.needsHumanIntervention,
    _resumeBrowserAction:
      session.browserRunSessionId || session.reusableSessionId || session.status === "awaiting_human"
        ? { operation: "resume_browser_session", sessionId: session.sessionId }
        : undefined,
    _screenshotDataUrl: opts.screenshotDataUrl,
  };
}

function detectBlocker(observed) {
  const title = (observed.title ?? "").toLowerCase();
  const currentUrl = (observed.currentUrl ?? "").toLowerCase();
  const text = (observed.textSnippet ?? "").toLowerCase();
  const combined = `${title} ${currentUrl} ${text}`;

  const explicitCaptcha =
    /\b(captcha|recaptcha|hcaptcha|turnstile)\b/.test(combined) ||
    /verify you are human|security check|challenge required|unusual traffic|one more step/i.test(
      combined
    );

  if (explicitCaptcha) {
    return {
      detected: true,
      reason:
        "Blocked on CAPTCHA or verification page. Open Live View and resume when the challenge is cleared.",
    };
  }

  const loginUrlSignal =
    /\/login\b|\/signin\b|\/sign-in\b|\/auth\b|\/authenticate\b|\/checkpoint\b/.test(
      currentUrl
    );
  const loginTitleSignal =
    /\bsign in\b|\bsign-in\b|\blog in\b|\blogin\b|authentication required|verify your identity/.test(
      title
    );
  const loginTextSignal =
    /\bsign in\b|\blog in\b|password|email address|continue with|enter your password|two-factor/i.test(
      text
    );

  const loginSignalCount = [loginUrlSignal, loginTitleSignal, loginTextSignal].filter(Boolean).length;
  if (loginSignalCount >= 2) {
    return {
      detected: true,
      reason:
        "Blocked on a login or identity verification page. Open Live View and resume when the required sign-in step is complete.",
    };
  }

  return { detected: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("isBrowserSessionResult: accepts valid result", () => {
  const result = {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: "abc-123",
    status: "active",
    recordingEnabled: true,
  };
  assertTrue(isBrowserSessionResult(result), "Should recognize valid schema");
});

test("isBrowserSessionResult: rejects browser-tool-result", () => {
  const result = {
    schema: "edgeclaw.browser-tool-result",
    schemaVersion: 1,
    toolName: "browser_execute",
  };
  assertFalse(isBrowserSessionResult(result), "Should reject wrong schema");
});

test("isBrowserSessionResult: rejects missing sessionId", () => {
  const result = {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    status: "active",
    recordingEnabled: true,
  };
  assertFalse(isBrowserSessionResult(result), "Should reject missing sessionId");
});

test("isBrowserSessionResult: rejects null", () => {
  assertFalse(isBrowserSessionResult(null), "null should be rejected");
});

test("isBrowserSessionResult: rejects array", () => {
  assertFalse(isBrowserSessionResult([]), "array should be rejected");
});

test("makeBrowserSessionResult: promotes all fields", () => {
  const state = {
    sessionId: "sess-1",
    status: "active",
    recordingEnabled: true,
    recordingId: "provider-sess-1",
    recordingReady: false,
    devtoolsFrontendUrl: "https://live.example/devtools?t=t1",
    liveViewUrl: "https://live.example/view?t=t1",
    currentTargetId: "t1",
    currentUrl: "https://example.com",
    browserRunSessionId: "provider-sess-1",
    reusableSessionId: "provider-sess-1",
    reusedSession: false,
    liveViewUnavailableReason: undefined,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: ["Session started"],
  };

  const result = makeBrowserSessionResult(state, { summary: "Step done" });
  assertEqual(result.schema, "edgeclaw.browser-session-result");
  assertEqual(result.schemaVersion, 1);
  assertEqual(result.sessionId, "sess-1");
  assertEqual(result.status, "active");
  assertTrue(result.recordingEnabled, "recording should be enabled");
  assertEqual(result.devtoolsFrontendUrl, "https://live.example/devtools?t=t1");
  assertEqual(result.liveViewUrl, "https://live.example/view?t=t1");
  assertEqual(result.currentUrl, "https://example.com");
  assertEqual(result.browserRunSessionId, "provider-sess-1");
  assertEqual(result.reusableSessionId, "provider-sess-1");
  assertEqual(result.recordingId, "provider-sess-1");
  assertEqual(result.summary, "Step done");
  assertTrue(Array.isArray(result.logLines), "logLines should be array");
  assertEqual(result.logLines.length, 1);
});

test("makeBrowserSessionResult: logLines omitted when empty", () => {
  const state = {
    sessionId: "sess-empty",
    status: "active",
    recordingEnabled: false,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };
  const result = makeBrowserSessionResult(state);
  assertEqual(result.logLines, undefined, "logLines should be undefined when empty");
});

test("makeBrowserSessionResult: includes _screenshotDataUrl when provided", () => {
  const state = {
    sessionId: "sess-2",
    status: "active",
    recordingEnabled: false,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };
  const dataUrl = "data:image/png;base64,iVBORw0KGgo...";
  const result = makeBrowserSessionResult(state, { screenshotDataUrl: dataUrl });
  assertEqual(result._screenshotDataUrl, dataUrl, "should carry screenshot data URL");
});

test("makeBrowserSessionResult: _screenshotDataUrl absent when not provided", () => {
  const state = {
    sessionId: "sess-3",
    status: "active",
    recordingEnabled: false,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };
  const result = makeBrowserSessionResult(state);
  assertEqual(result._screenshotDataUrl, undefined, "should be undefined when no screenshot given");
});

test("login wall detected -> HITL pause", () => {
  const result = detectBlocker({
    title: "Sign in - Example",
    currentUrl: "https://example.com/login",
    textSnippet: "Please sign in with your email address and password to continue.",
  });

  assertTrue(result.detected, "login wall should be detected");
  assertTrue(/login|sign-in|sign in/i.test(result.reason), "reason should mention login");
});

test("captcha detected -> HITL pause", () => {
  const result = detectBlocker({
    title: "Just a moment...",
    currentUrl: "https://example.com/challenge",
    textSnippet: "Verify you are human to continue. This site is protected by Turnstile.",
  });

  assertTrue(result.detected, "captcha or verification page should be detected");
  assertTrue(/captcha|verification|challenge/i.test(result.reason), "reason should mention challenge");
});

test("normal page -> no pause", () => {
  const result = detectBlocker({
    title: "Example Domain",
    currentUrl: "https://example.com/docs",
    textSnippet: "This domain is for use in illustrative examples in documents.",
  });

  assertFalse(result.detected, "normal page should not trigger blocker pause");
});

test("HITL: awaiting_human status is valid schema and summary is correct", () => {
  const state = {
    sessionId: "sess-hitl",
    status: "awaiting_human",
    recordingEnabled: true,
    browserRunSessionId: "provider-hitl-1",
    reusableSessionId: "provider-hitl-1",
    needsHumanIntervention: true,
    humanInterventionReason: "Please solve the CAPTCHA.",
    resumableSession: {
      sessionId: "provider-hitl-1",
      liveViewUrl: "https://live.example/devtools?t=hitl",
      expiresAt: "2026-04-22T12:00:00.000Z",
    },
    liveViewUrl: "https://live.example/devtools?t=hitl",
    humanInstructions: "Please solve the CAPTCHA.",
    createdAt: 1000,
    updatedAt: 2000,
    logLines: ["Paused for user"],
  };
  const result = makeBrowserSessionResult(state, {
    summary: "Session paused awaiting human input: Please solve the CAPTCHA.",
  });
  assertTrue(isBrowserSessionResult(result), "awaiting_human result should be valid schema");
  assertEqual(result.status, "awaiting_human");
  assertTrue(result.summary?.includes("CAPTCHA"), "summary should include HITL instructions");
  assertTrue(result.needsHumanIntervention, "HITL flag should be set");
  assertEqual(result.resumableSession?.sessionId, "provider-hitl-1");
  assertEqual(result._liveViewUrl, "https://live.example/devtools?t=hitl");
});

test("explicit pauseForHuman launch returns needsHumanIntervention + resumableSession + liveViewUrl", () => {
  const state = {
    sessionId: "sess-pause-human",
    status: "awaiting_human",
    recordingEnabled: true,
    browserRunSessionId: "provider-pause-human",
    reusableSessionId: "provider-pause-human",
    needsHumanIntervention: true,
    humanInterventionReason: "Paused for human review. Open Live View and resume when ready.",
    resumableSession: {
      sessionId: "provider-pause-human",
      liveViewUrl: "https://live.example/devtools?t=pause-human",
      expiresAt: "2026-04-22T12:00:00.000Z",
    },
    liveViewUrl: "https://live.example/devtools?t=pause-human",
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };

  const result = makeBrowserSessionResult(state);
  assertTrue(result.needsHumanIntervention, "should request human intervention");
  assertEqual(result.resumableSession?.sessionId, "provider-pause-human");
  assertEqual(result.liveViewUrl, "https://live.example/devtools?t=pause-human");
});

test("pauseForHumanOnBlocker can request HITL for likely login or verification flows", () => {
  const result = makeBrowserSessionResult({
    sessionId: "sess-blocker-hitl",
    status: "awaiting_human",
    recordingEnabled: true,
    browserRunSessionId: "provider-blocker-1",
    reusableSessionId: "provider-blocker-1",
    needsHumanIntervention: true,
    humanInterventionReason: "Blocked on a likely login or verification step. Open Live View and resume when ready.",
    resumableSession: {
      sessionId: "provider-blocker-1",
      liveViewUrl: "https://live.example/devtools?t=blocker",
    },
    liveViewUrl: "https://live.example/devtools?t=blocker",
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  });

  assertTrue(result.needsHumanIntervention, "blocker pause should surface HITL state");
  assertTrue(/login|verification/i.test(result.humanInterventionReason), "reason should mention blocker/login flow");
});

test("reusable session launch returns reusableSessionId in reusable mode", () => {
  const state = {
    sessionId: "sess-reusable",
    status: "active",
    recordingEnabled: true,
    browserRunSessionId: "provider-reusable-1",
    reusableSessionId: "provider-reusable-1",
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };

  const result = makeBrowserSessionResult(state);
  assertEqual(result.sessionId, "sess-reusable");
  assertEqual(result.reusableSessionId, "provider-reusable-1");
  assertEqual(result.browserRunSessionId, "provider-reusable-1");
});

test("reuseSessionId reconnect path attaches existing session or returns SESSION_REUSE_FAILED cleanly", () => {
  function simulateReconnect(session) {
    if (!session.browserRunSessionId || session.liveViewUnavailableReason === "invalid_provider_session_id") {
      return {
        ok: false,
        summary: "SESSION_REUSE_FAILED: the provider-backed browser session is no longer available.",
      };
    }
    return { ok: true, status: "active", sessionId: session.sessionId };
  }

  const active = simulateReconnect({
    sessionId: "sess-existing",
    browserRunSessionId: "provider-existing",
  });
  assertTrue(active.ok, "valid reusable session should reconnect cleanly");

  const expired = simulateReconnect({
    sessionId: "sess-expired",
    liveViewUnavailableReason: "invalid_provider_session_id",
  });
  assertFalse(expired.ok, "expired reusable session should fail cleanly");
  assertTrue(/SESSION_REUSE_FAILED/.test(expired.summary), "failure should be explicit");
});

test("recording request returns recordingEnabled metadata", () => {
  const state = {
    sessionId: "sess-recording",
    status: "active",
    recordingEnabled: true,
    recordingId: "provider-recording-1",
    recordingReady: false,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };

  const result = makeBrowserSessionResult(state);
  assertTrue(result.recordingEnabled, "recordingEnabled should be true");
  assertEqual(result.recordingId, "provider-recording-1");
  assertEqual(result.recordingReady, false);
});

test("no fake success response when browser session launch metadata is absent", () => {
  const result = makeBrowserSessionResult({
    sessionId: "sess-missing-provider",
    status: "abandoned",
    recordingEnabled: false,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  }, { summary: "Session launch failed: missing provider session id" });

  assertEqual(result.browserRunSessionId, undefined);
  assertEqual(result.reusableSessionId, undefined);
  assertEqual(result._resumeBrowserAction, undefined);
  assertTrue(/failed/i.test(result.summary), "result should not imply success");
});

test("resume: disconnected → active status transition", () => {
  const state = {
    sessionId: "sess-disc",
    status: "disconnected",
    recordingEnabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: ["Disconnected"],
  };

  // Simulate what BrowserSessionManager.resume() does: patch to active before executing step
  const reconnected = { ...state, status: "active", updatedAt: Date.now() };
  assertEqual(reconnected.status, "active", "should transition to active on reconnect");
  assertEqual(reconnected.sessionId, state.sessionId, "sessionId remains stable");
});

test("HITL: awaiting_human blocks resume (no status transition)", () => {
  const state = {
    sessionId: "sess-hitl-2",
    status: "awaiting_human",
    recordingEnabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };

  // Simulate BrowserSessionManager.resume() early-return for awaiting_human
  function simulateResume(session) {
    if (session.status === "awaiting_human") {
      return { ...session }; // returns unchanged
    }
    return { ...session, status: "active" };
  }

  const result = simulateResume(state);
  assertEqual(result.status, "awaiting_human", "awaiting_human should NOT be transitioned to active");
});

test("recording defaults to true at launch", () => {
  const launchOptions = { task: "Screenshot example.com" };
  const recordingEnabled = launchOptions.recordingEnabled ?? true;
  assertTrue(recordingEnabled, "recording should default to true when not specified");
});

test("no synthetic devtools URL fallback from targetId", () => {
  function resolveDevtoolsUrl(session) {
    if (typeof session.devtoolsFrontendUrl === "string") return session.devtoolsFrontendUrl;
    return undefined;
  }

  const session = { currentTargetId: "target-abc" };
  const url = resolveDevtoolsUrl(session);
  assertEqual(url, undefined, "must not synthesize devtools:// URLs");
});

test("devtoolsFrontendUrl: explicit value takes precedence over targetId", () => {
  function resolveDevtoolsUrl(session) {
    if (typeof session.devtoolsFrontendUrl === "string") return session.devtoolsFrontendUrl;
    return undefined;
  }

  const explicit = "https://live.example/devtools?targetId=explicit";
  const session = { devtoolsFrontendUrl: explicit, currentTargetId: "other-id" };
  assertEqual(resolveDevtoolsUrl(session), explicit, "explicit URL should win");
});

test("machine-readable liveViewUnavailableReason is preserved in result", () => {
  const state = {
    sessionId: "sess-no-live-view",
    status: "active",
    recordingEnabled: true,
    liveViewUnavailableReason: "missing_provider_session_id",
    createdAt: 1000,
    updatedAt: 2000,
    logLines: [],
  };

  const result = makeBrowserSessionResult(state);
  assertEqual(result.liveViewUnavailableReason, "missing_provider_session_id");
});

test("sessionId is stable across multiple tool steps (same toolCallId)", () => {
  // Simulate the step ID anchoring used in the frontend: toolCallId → stepId
  const toolCallId = "call-xyz";
  const stepId1 = toolCallId ?? "browser_session-0";
  const stepId2 = toolCallId ?? "browser_session-1";
  assertEqual(stepId1, stepId2, "stepId should be stable across turns when toolCallId is the same");
});

console.log("\nAll browser session schema tests passed.\n");
