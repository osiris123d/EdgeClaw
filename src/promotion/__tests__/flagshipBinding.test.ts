/**
 * Flagship Workers binding adapter + factory precedence tests.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import {
  createBindingFlagshipEvaluationAdapter,
  normalizeBindingOutcomeString,
  toFlagshipTargetingAttributes,
} from "../flagshipBinding";
import { resolveFlagshipEvaluationAdapter } from "../flagshipEvaluationAdapterFactory";

function mockFlagship(impl: {
  getStringDetails?: (
    flagKey: string,
    defaultValue: string,
    context?: Record<string, string | number | boolean>
  ) => Promise<FlagshipEvaluationDetails<string>>;
}): Flagship {
  return {
    getStringDetails:
      impl.getStringDetails ??
      (async (flagKey, defaultValue) => ({
        flagKey,
        value: defaultValue,
      })),
  } as Flagship;
}

test("normalizeBindingOutcomeString accepts allow/deny/hold case-insensitively", () => {
  assert.equal(normalizeBindingOutcomeString("ALLOW"), "allow");
  assert.equal(normalizeBindingOutcomeString(" Hold "), "hold");
  assert.equal(normalizeBindingOutcomeString("maybe"), null);
});

test("toFlagshipTargetingAttributes forwards tier, digest, correlationId, verificationRefs", () => {
  const attrs = toFlagshipTargetingAttributes({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
    manifestDigest: "deadbeef",
    correlationId: "corr-1",
    verificationRefs: ["a", "b"],
  });
  assert.equal(attrs.projectId, "p");
  assert.equal(attrs.tier, "preview");
  assert.equal(attrs.manifestDigest, "deadbeef");
  assert.equal(attrs.correlationId, "corr-1");
  assert.equal(attrs.verificationRefs, "a,b");
});

test("binding adapter maps allow + audit metadata", async () => {
  const adapter = createBindingFlagshipEvaluationAdapter(
    mockFlagship({
      async getStringDetails(flagKey, _defaultValue, context) {
        assert.equal(flagKey, "edgeclaw-release-gate");
        assert.equal(context?.bundleId, "b1");
        return {
          flagKey,
          value: "allow",
          variant: "vA",
          reason: "TARGETING_MATCH",
        };
      },
    }),
    { outcomeFlagKey: "edgeclaw-release-gate" }
  );

  const out = await adapter.evaluate({
    projectId: "proj",
    bundleId: "b1",
    tier: "preview",
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.allowed, true);
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_BINDING");
  assert.equal(out.reasons[0]?.detail?.variant, "vA");
});

test("binding adapter deny on Flagship errorCode", async () => {
  const adapter = createBindingFlagshipEvaluationAdapter(
    mockFlagship({
      async getStringDetails() {
        return {
          flagKey: "edgeclaw-release-gate",
          value: "hold",
          errorCode: "GENERAL",
          errorMessage: "upstream failure",
        };
      },
    }),
    { outcomeFlagKey: "edgeclaw-release-gate" }
  );

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "production",
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_BINDING_ERROR");
});

test("binding adapter normalizes unknown string to hold with FLAGSHIP_BINDING_UNKNOWN_VALUE", async () => {
  const adapter = createBindingFlagshipEvaluationAdapter(
    mockFlagship({
      async getStringDetails() {
        return {
          flagKey: "edgeclaw-release-gate",
          value: "maybe-later",
          reason: "DEFAULT",
        };
      },
    }),
    { outcomeFlagKey: "edgeclaw-release-gate" }
  );

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "canary",
  });
  assert.equal(out.outcome, "hold");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_BINDING_UNKNOWN_VALUE");
});

test("factory: binding wins over HTTP when both configured", async () => {
  const env = {
    ENABLE_FLAGSHIP_BINDING: "true",
    FLAGS: mockFlagship({
      async getStringDetails() {
        return {
          flagKey: "edgeclaw-release-gate",
          value: "deny",
          reason: "POLICY",
        };
      },
    }),
    FLAGSHIP_EVALUATION_URL: "https://policy.test/eval",
    ENABLE_FLAGSHIP_HTTP: "true",
  } as Env;

  const adapter = resolveFlagshipEvaluationAdapter(env);

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_BINDING");
});

test("factory: ENABLE_FLAGSHIP_HTTP false still uses binding when enabled", async () => {
  const env = {
    ENABLE_FLAGSHIP_BINDING: "true",
    ENABLE_FLAGSHIP_HTTP: "false",
    FLAGS: mockFlagship({
      async getStringDetails() {
        return { flagKey: "edgeclaw-release-gate", value: "allow", reason: "ok" };
      },
    }),
    FLAGSHIP_EVALUATION_URL: "https://policy.test/eval",
  } as Env;

  const adapter = resolveFlagshipEvaluationAdapter(env);
  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_BINDING");
});

test("factory: binding disabled + HTTP disabled + URL -> noop", async () => {
  const adapter = resolveFlagshipEvaluationAdapter({
    ENABLE_FLAGSHIP_BINDING: "false",
    ENABLE_FLAGSHIP_HTTP: "false",
    FLAGSHIP_EVALUATION_URL: "https://policy.test/eval",
  } as Env);
  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_NOOP");
});

test("factory: binding enabled but FLAGS missing falls through to HTTP adapter", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        outcome: "allow",
        tier: "preview",
        reasons: [{ code: "HTTP_OK", message: "via fetch" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  try {
    const adapter = resolveFlagshipEvaluationAdapter({
      ENABLE_FLAGSHIP_BINDING: "true",
      FLAGSHIP_EVALUATION_URL: "https://policy.test/eval",
    } as Env);
    const out = await adapter.evaluate({
      projectId: "p",
      bundleId: "b",
      tier: "preview",
    });
    assert.equal(out.outcome, "allow");
    assert.equal(out.reasons[0]?.code, "HTTP_OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
