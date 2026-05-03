/**
 * Focused backend tests for Browser Session Live View refresh behavior.
 *
 * These mirror the BrowserSessionManager Live View lease semantics:
 * - refresh when URL absent
 * - reuse cached URL when fresh (< 4 min)
 * - refresh when stale
 * - soft-fail when Cloudflare API errors
 * - prefer current target when available
 * - return session result carrying liveViewUrl
 */

const LIVE_VIEW_CACHE_TTL_MS = 4 * 60 * 1000;

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy value, got ${value}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
    })
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
}

function makeBrowserSessionResult(session) {
  return {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: session.sessionId,
    status: session.status,
    recordingEnabled: session.recordingEnabled,
    liveViewUrl: session.liveViewUrl,
    currentUrl: session.currentUrl,
    title: session.title,
  };
}

function selectTargetForLiveView(targets, currentTargetId) {
  if (currentTargetId) {
    const exact = targets.find((t) => t.targetId === currentTargetId && t.devtoolsFrontendUrl);
    if (exact) return exact;
  }

  const pageTarget = targets.find(
    (t) => (t.type === "page" || t.type === undefined) && t.devtoolsFrontendUrl
  );
  if (pageTarget) return pageTarget;

  return targets.find((t) => Boolean(t.devtoolsFrontendUrl));
}

async function ensureFreshLiveViewUrlLike(session, deps) {
  const now = deps.now();
  const fetchedAt = session.liveViewUrlFetchedAt ?? 0;

  if (session.liveViewUrl && now - fetchedAt < LIVE_VIEW_CACHE_TTL_MS) {
    return { session, patched: false };
  }

  if (!session.browserRunSessionId) {
    return {
      session: {
        ...session,
        liveViewUnavailableReason: "missing_provider_session_id",
      },
      patched: true,
      reason: "missing_provider_session_id",
    };
  }

  try {
    const targets = await deps.listSessionTargets(session.browserRunSessionId);
    if (!targets || targets.length === 0) {
      return { session, patched: false, reason: undefined };
    }

    const chosen = selectTargetForLiveView(targets, session.currentTargetId);
    if (!chosen?.devtoolsFrontendUrl) {
      return {
        session: {
          ...session,
          liveViewUnavailableReason: "target_missing_devtools_url",
        },
        patched: true,
        reason: "target_missing_devtools_url",
      };
    }

    const updated = {
      ...session,
      liveViewUrl: chosen.devtoolsFrontendUrl,
      devtoolsFrontendUrl: chosen.devtoolsFrontendUrl,
      liveViewUrlFetchedAt: now,
      currentTargetId: chosen.targetId ?? session.currentTargetId,
      currentUrl: chosen.url ?? session.currentUrl,
      title: chosen.title ?? session.title,
      liveViewUnavailableReason: undefined,
    };

    return { session: updated, patched: true, reason: undefined };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isInvalidProviderSession = /\bstatus\s*404\b/i.test(errMsg);

    if (isInvalidProviderSession) {
      return {
        session: {
          ...session,
          browserRunSessionId: undefined,
          liveViewUnavailableReason: "invalid_provider_session_id",
        },
        patched: true,
        reason: "invalid_provider_session_id",
      };
    }

    // Soft fail: session execution remains usable
    return {
      session: {
        ...session,
        liveViewUnavailableReason: "refresh_failed",
      },
      patched: true,
      reason: "refresh_failed",
    };
  }
}

function extractBrowserRunSessionIdLike(result) {
  const metadata = result?.metadata && typeof result.metadata === "object" ? result.metadata : {};
  const candidates = [
    metadata.sessionId,
    metadata.providerSessionId,
    metadata.reusableSessionId,
    metadata.resumableSessionId,
    metadata.browserRunSessionId,
    result.reusableSessionId,
    result.resumableSessionId,
    result.browserRunSessionId,
    result.providerSessionId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

test("refreshes Live View URL when absent", async () => {
  const base = {
    sessionId: "s1",
    browserRunSessionId: "provider-s1",
    status: "active",
    recordingEnabled: true,
    currentTargetId: "target-a",
  };

  const { session, patched } = await ensureFreshLiveViewUrlLike(base, {
    now: () => 1_000_000,
    listSessionTargets: async () => [
      {
        targetId: "target-a",
        type: "page",
        url: "https://example.com",
        title: "Example",
        devtoolsFrontendUrl: "https://live.example/devtools?target=target-a",
      },
    ],
  });

  assertTrue(patched, "Expected patch when URL is absent");
  assertEqual(session.liveViewUrl, "https://live.example/devtools?target=target-a");
  assertEqual(session.title, "Example");
});

test("reuses cached URL when still fresh", async () => {
  const now = 2_000_000;
  const base = {
    sessionId: "s2",
    browserRunSessionId: "provider-s2",
    status: "active",
    recordingEnabled: true,
    liveViewUrl: "https://live.example/cached",
    liveViewUrlFetchedAt: now - 60_000,
  };

  let apiCalls = 0;
  const { session, patched } = await ensureFreshLiveViewUrlLike(base, {
    now: () => now,
    listSessionTargets: async () => {
      apiCalls += 1;
      return [];
    },
  });

  assertEqual(apiCalls, 0, "Fresh cache should skip API call");
  assertEqual(patched, false);
  assertEqual(session.liveViewUrl, "https://live.example/cached");
});

test("refreshes URL when stale", async () => {
  const now = 3_000_000;
  const base = {
    sessionId: "s3",
    browserRunSessionId: "provider-s3",
    status: "active",
    recordingEnabled: true,
    liveViewUrl: "https://live.example/old",
    liveViewUrlFetchedAt: now - (LIVE_VIEW_CACHE_TTL_MS + 5_000),
  };

  const { session, patched } = await ensureFreshLiveViewUrlLike(base, {
    now: () => now,
    listSessionTargets: async () => [
      {
        targetId: "target-new",
        type: "page",
        devtoolsFrontendUrl: "https://live.example/new",
      },
    ],
  });

  assertTrue(patched, "Stale URL should refresh");
  assertEqual(session.liveViewUrl, "https://live.example/new");
});

test("soft-fails when Cloudflare API errors", async () => {
  const base = {
    sessionId: "s4",
    browserRunSessionId: "provider-s4",
    status: "active",
    recordingEnabled: true,
    liveViewUrl: "https://live.example/keep",
    liveViewUrlFetchedAt: 0,
  };

  const { session, patched, reason } = await ensureFreshLiveViewUrlLike(base, {
    now: () => LIVE_VIEW_CACHE_TTL_MS + 10,
    listSessionTargets: async () => {
      throw new Error("Cloudflare API unavailable");
    },
  });

  assertEqual(patched, true, "Error path should patch with refresh_failed reason");
  assertEqual(reason, "refresh_failed");
  assertEqual(session.liveViewUrl, "https://live.example/keep");
  assertEqual(session.liveViewUnavailableReason, "refresh_failed");
});

test("prefers current target when available", async () => {
  const base = {
    sessionId: "s5",
    browserRunSessionId: "provider-s5",
    status: "active",
    recordingEnabled: true,
    currentTargetId: "target-current",
  };

  const { session } = await ensureFreshLiveViewUrlLike(base, {
    now: () => 5_000_000,
    listSessionTargets: async () => [
      {
        targetId: "target-other",
        type: "page",
        devtoolsFrontendUrl: "https://live.example/other",
      },
      {
        targetId: "target-current",
        type: "page",
        devtoolsFrontendUrl: "https://live.example/current",
      },
    ],
  });

  assertEqual(session.liveViewUrl, "https://live.example/current");
});

test("session result includes liveViewUrl for UI", async () => {
  const session = {
    sessionId: "s6",
    status: "awaiting_human",
    recordingEnabled: true,
    liveViewUrl: "https://live.example/ui",
    currentUrl: "https://example.com",
    title: "Example Domain",
  };

  const result = makeBrowserSessionResult(session);
  assertEqual(result.schema, "edgeclaw.browser-session-result");
  assertEqual(result.liveViewUrl, "https://live.example/ui");
  assertEqual(result.status, "awaiting_human");
});

test("skips refresh when provider session id is missing", async () => {
  const base = {
    sessionId: "local-only-sid",
    status: "active",
    recordingEnabled: true,
  };

  let calls = 0;
  const { session, reason } = await ensureFreshLiveViewUrlLike(base, {
    now: () => 7_000_000,
    listSessionTargets: async () => {
      calls += 1;
      return [];
    },
  });

  assertEqual(calls, 0, "Must not call targets API without browserRunSessionId");
  assertEqual(reason, "missing_provider_session_id");
  assertEqual(session.liveViewUnavailableReason, "missing_provider_session_id");
});

test("sets target_missing_devtools_url when chosen target lacks devtools URL", async () => {
  const base = {
    sessionId: "s-no-devtools",
    browserRunSessionId: "provider-no-devtools",
    status: "active",
    recordingEnabled: true,
  };

  const { session, reason } = await ensureFreshLiveViewUrlLike(base, {
    now: () => 8_000_000,
    listSessionTargets: async () => [
      {
        targetId: "t1",
        type: "page",
        url: "https://example.com/no-devtools",
      },
    ],
  });

  assertEqual(reason, "target_missing_devtools_url");
  assertEqual(session.liveViewUnavailableReason, "target_missing_devtools_url");
  assertEqual(session.liveViewUrl, undefined);
});

test("404 target refresh clears invalid provider session id", async () => {
  const base = {
    sessionId: "s-bad-provider-id",
    browserRunSessionId: "provider-bad",
    status: "active",
    recordingEnabled: true,
  };

  const { session, reason } = await ensureFreshLiveViewUrlLike(base, {
    now: () => 9_000_000,
    listSessionTargets: async () => {
      throw new Error("Cloudflare Browser Run API /targets failed with status 404");
    },
  });

  assertEqual(reason, "invalid_provider_session_id");
  assertEqual(session.browserRunSessionId, undefined);
  assertEqual(session.liveViewUnavailableReason, "invalid_provider_session_id");
});

test("extractor accepts explicit provider session metadata and ignores generic local sessionId", async () => {
  const launchResultWithProvider = {
    sessionId: "local-durable-session-id",
    metadata: {
      browserRunSessionId: "provider-session-123",
    },
  };
  const launchResultGenericOnly = {
    sessionId: "local-durable-session-id",
    currentTargetId: "target-1",
    cfSessionId: "cf-opaque",
  };

  assertEqual(extractBrowserRunSessionIdLike(launchResultWithProvider), "provider-session-123");
  assertEqual(extractBrowserRunSessionIdLike(launchResultGenericOnly), undefined);
});

console.log("\nLive View refresh behavior tests completed.\n");
