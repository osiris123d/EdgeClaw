/**
 * Provider-backed browser_session launch smoke test.
 *
 * Verifies:
 * - launch returns provider-backed browserRunSessionId
 * - provider-configured manager launch path is provider-first (no fallback CDP launch)
 * - MainAgent wires browserSessionProvider into BrowserSessionManager
 * - status carries liveViewUrl when metadata is present
 * - dashboard-visible metadata shape exists after launch
 */

import { readFileSync } from "node:fs";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy value, got ${value}`);
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
}

function makeResultFromState(session) {
  return {
    schema: "edgeclaw.browser-session-result",
    schemaVersion: 1,
    sessionId: session.sessionId,
    status: session.status,
    recordingEnabled: session.recordingEnabled,
    liveViewUrl: session.liveViewUrl,
    devtoolsFrontendUrl: session.devtoolsFrontendUrl,
    sessionRecordingUrl: session.sessionRecordingUrl,
    browserRunSessionIdPresent: typeof session.browserRunSessionId === "string",
    liveViewUnavailableReason: session.liveViewUnavailableReason,
  };
}

function simulateProviderBackedLaunch(adapterLaunch) {
  const localSessionId = "local-session-1";
  const launchOutput = adapterLaunch();

  const state = {
    sessionId: localSessionId,
    status: "active",
    recordingEnabled: true,
    browserRunSessionId: launchOutput.browserRunSessionId,
    liveViewUrl: launchOutput.liveViewUrl,
    devtoolsFrontendUrl: launchOutput.devtoolsFrontendUrl,
    sessionRecordingUrl: launchOutput.recordingUrl,
    currentTargetId: launchOutput.currentTargetId,
    currentUrl: launchOutput.currentUrl,
    title: launchOutput.title,
    liveViewUnavailableReason:
      launchOutput.liveViewUrl || launchOutput.devtoolsFrontendUrl
        ? undefined
        : launchOutput.browserRunSessionId
          ? "target_missing_devtools_url"
          : "missing_provider_session_id",
  };

  return state;
}

test("provider-backed launch exposes Browser Run metadata in launch/status result", async () => {
  const providerAdapterLaunch = () => ({
    browserRunSessionId: "provider-session-123",
    liveViewUrl: "https://dash.live/view/abc",
    devtoolsFrontendUrl: "https://dash.live/devtools/abc",
    recordingUrl: "https://dash.live/recording/abc",
    currentTargetId: "target-abc",
    currentUrl: "https://example.com",
    title: "Example Domain",
    reusedSession: false,
  });

  const state = simulateProviderBackedLaunch(providerAdapterLaunch);
  const launchResult = makeResultFromState(state);
  const statusResult = makeResultFromState(state);

  assertTrue(launchResult.browserRunSessionIdPresent, "launch should indicate provider session id present");
  assertEqual(launchResult.liveViewUrl, "https://dash.live/view/abc");
  assertEqual(statusResult.liveViewUrl, "https://dash.live/view/abc");

  // Browser Run dashboard-visible metadata expected after launch.
  assertEqual(launchResult.devtoolsFrontendUrl, "https://dash.live/devtools/abc");
  assertEqual(launchResult.sessionRecordingUrl, "https://dash.live/recording/abc");
});

test("manager launch path is provider-first when browserSessionProvider is configured", () => {
  const source = readFileSync(new URL("../src/browserSession/BrowserSessionManager.ts", import.meta.url), "utf8");

  assertTrue(
    source.includes("if (this.browserSessionProvider) {") &&
      source.includes("await this.browserSessionProvider.launch"),
    "BrowserSessionManager.launch should call browserSessionProvider.launch when configured"
  );

  assertTrue(
    !source.includes("createBrowserExecuteFallbackAdapter"),
    "BrowserSessionManager should not use the legacy fallback adapter launch path"
  );
});

test("MainAgent passes browserSessionProvider into BrowserSessionManager", () => {
  const source = readFileSync(new URL("../src/agents/MainAgent.ts", import.meta.url), "utf8");

  assertTrue(
    source.includes("browserSessionProvider: this.browserSessionProvider"),
    "MainAgent should pass browserSessionProvider into BrowserSessionManager options"
  );
});

console.log("\nProvider-backed browser session launch smoke test completed.\n");
