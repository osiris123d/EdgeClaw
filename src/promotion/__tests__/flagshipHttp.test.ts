/**
 * Flagship HTTP adapter tests — no MainAgent import.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import { resolveFlagshipEvaluationAdapter } from "../flagshipEvaluationAdapterFactory";
import {
  createHttpFlagshipEvaluationAdapter,
  parseFlagshipHttpReleaseDecision,
} from "../flagshipHttp";
import type { FlagshipEvaluationAdapter, FlagshipEvaluationContext } from "../flagshipTypes";
import { evaluatePromotionReleaseGate } from "../orchestratorReleaseGate";
import type { PromotionArtifactManifest } from "../artifactPromotionTypes";
import { computePromotionManifestDigest } from "../promotionManifestCanonical";

test("parseFlagshipHttpReleaseDecision allow / deny / hold", () => {
  const allow = parseFlagshipHttpReleaseDecision(
    {
      outcome: "allow",
      tier: "preview",
      reasons: [{ code: "A", message: "ok" }],
    },
    "production"
  );
  assert.equal(allow?.outcome, "allow");
  assert.equal(allow?.tier, "preview");

  const deny = parseFlagshipHttpReleaseDecision(
    {
      outcome: "deny",
      allowed: false,
      reasons: [{ code: "POLICY", message: "no" }],
    },
    "preview"
  );
  assert.equal(deny?.outcome, "deny");
  assert.equal(deny?.allowed, false);

  const hold = parseFlagshipHttpReleaseDecision(
    {
      outcome: "hold",
      tier: "canary",
      reasons: [{ code: "WAIT", message: "review" }],
    },
    "preview"
  );
  assert.equal(hold?.outcome, "hold");
  assert.equal(hold?.tier, "canary");
});

test("parseFlagshipHttpReleaseDecision injects reason when allow has empty reasons", () => {
  const r = parseFlagshipHttpReleaseDecision({ outcome: "allow", reasons: [] }, "preview");
  assert.equal(r?.outcome, "allow");
  assert.equal(r?.reasons[0]?.code, "FLAGSHIP_ALLOW");
});

test("parseFlagshipHttpReleaseDecision rejects malformed payloads", () => {
  assert.equal(parseFlagshipHttpReleaseDecision(null, "preview"), null);
  assert.equal(parseFlagshipHttpReleaseDecision({ outcome: "maybe" }, "preview"), null);
  assert.equal(parseFlagshipHttpReleaseDecision({ outcome: "deny", reasons: [] }, "preview"), null);
});

test("HTTP adapter POSTs JSON context with Bearer and returns allow", async () => {
  let posted: FlagshipEvaluationContext | undefined;
  const adapter = createHttpFlagshipEvaluationAdapter({
    evaluationUrl: "https://policy.test/eval",
    bearerToken: "secret",
    fetchFn: async (url, init) => {
      assert.equal(url, "https://policy.test/eval");
      assert.equal(init?.method, "POST");
      assert.ok(String(init?.headers && (init.headers as Record<string, string>).Authorization).includes("Bearer secret"));
      posted = JSON.parse(String(init?.body)) as FlagshipEvaluationContext;
      return new Response(
        JSON.stringify({
          outcome: "allow",
          tier: "preview",
          reasons: [{ code: "OK", message: "passed" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const out = await adapter.evaluate({
    projectId: "proj",
    bundleId: "b1",
    tier: "preview",
    manifestDigest: "abc",
    correlationId: "corr-42",
  });

  assert.equal(out.outcome, "allow");
  assert.equal(posted?.correlationId, "corr-42");
  assert.equal(posted?.manifestDigest, "abc");
});

test("HTTP adapter deny path", async () => {
  const adapter = createHttpFlagshipEvaluationAdapter({
    evaluationUrl: "https://policy.test/eval",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          outcome: "deny",
          reasons: [{ code: "X", message: "blocked" }],
        }),
        { status: 200 }
      ),
  });

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "production",
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.reasons[0]?.code, "X");
});

test("HTTP adapter hold path", async () => {
  const adapter = createHttpFlagshipEvaluationAdapter({
    evaluationUrl: "https://policy.test/eval",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          outcome: "hold",
          reasons: [{ code: "H", message: "wait" }],
        }),
        { status: 200 }
      ),
  });

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.outcome, "hold");
});

test("HTTP adapter fetch failure -> deny FLAGSHIP_HTTP_ERROR", async () => {
  const adapter = createHttpFlagshipEvaluationAdapter({
    evaluationUrl: "https://policy.test/eval",
    fetchFn: async () => {
      throw new Error("network down");
    },
  });

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_HTTP_ERROR");
});

test("HTTP adapter invalid JSON body -> deny FLAGSHIP_INVALID_RESPONSE", async () => {
  const adapter = createHttpFlagshipEvaluationAdapter({
    evaluationUrl: "https://policy.test/eval",
    fetchFn: async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });

  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_INVALID_RESPONSE");
});

test("resolveFlagshipEvaluationAdapter without URL -> noop", async () => {
  const adapter = resolveFlagshipEvaluationAdapter({} as Env);
  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_NOOP");
});

test("resolveFlagshipEvaluationAdapter ENABLE_FLAGSHIP_HTTP false uses noop despite URL when FLAGS binding absent", async () => {
  const adapter = resolveFlagshipEvaluationAdapter({
    FLAGSHIP_EVALUATION_URL: "https://policy.test/eval",
    ENABLE_FLAGSHIP_HTTP: "false",
  } as Env);
  const out = await adapter.evaluate({
    projectId: "p",
    bundleId: "b",
    tier: "preview",
  });
  assert.equal(out.reasons[0]?.code, "FLAGSHIP_NOOP");
});

test("evaluatePromotionReleaseGate forwards correlationId", async () => {
  let captured: FlagshipEvaluationContext | undefined;
  const stub: FlagshipEvaluationAdapter = {
    async evaluate(ctx) {
      captured = ctx;
      return {
        outcome: "allow",
        allowed: true,
        tier: ctx.tier,
        reasons: [{ code: "T", message: "t" }],
      };
    },
  };

  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "bid",
    projectId: "proj",
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: ["x"],
  };
  const digest = await computePromotionManifestDigest(manifest);

  await evaluatePromotionReleaseGate(stub, {
    projectId: "proj",
    tier: "preview",
    bundleRef: { bundleId: "bid", manifestDigest: digest },
    manifest,
    correlationId: "upstream-req-7",
  });

  assert.equal(captured?.correlationId, "upstream-req-7");
});
