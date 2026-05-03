/**
 * Integration tests for promotion manifest digest, noop artifact writer, and release gate orchestration.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySharedWorkspaceStorage } from "../../agents/codingLoop/testFixtures/inMemorySharedWorkspaceStorage";
import { SharedWorkspaceGateway } from "../../workspace/sharedWorkspaceTypes";
import { createNoopArtifactPromotionWriter } from "../artifactPromotionNoop";
import { createNoopFlagshipEvaluationAdapter } from "../flagshipNoop";
import type { PromotionArtifactManifest } from "../artifactPromotionTypes";
import { evaluatePromotionReleaseGate } from "../orchestratorReleaseGate";
import {
  canonicalPromotionManifestPayload,
  computePromotionManifestDigest,
} from "../promotionManifestCanonical";
import { buildPromotionManifestFromApprovedPatches } from "../promotionOrchestration";
import { promotionBundleIdsMatch, promotionManifestMatchesDigest } from "../promotionArtifactVerification";

const PROJECT = "promo-int";

async function seedApprovedPatch(
  storage: InMemorySharedWorkspaceStorage,
  gateway: SharedWorkspaceGateway,
  patchId: string,
  body = "patch body\n"
): Promise<void> {
  storage.seedPendingPatch(PROJECT, patchId, body);
  const ap = await gateway.approvePatch("orchestrator", PROJECT, patchId);
  assert.ok(!("error" in ap), String(("error" in ap && ap.error) || ""));
}

function gwFixture(): { storage: InMemorySharedWorkspaceStorage; gateway: SharedWorkspaceGateway } {
  const storage = new InMemorySharedWorkspaceStorage();
  const gateway = new SharedWorkspaceGateway(storage);
  return { storage, gateway };
}

test("canonical digest is stable across patchIds declaration order", async () => {
  const base = {
    schemaVersion: "edgeclaw-promotion-v1" as const,
    bundleId: "b1",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchContentDigests: { a: "aa", b: "bb" },
  };
  const m1: PromotionArtifactManifest = { ...base, patchIds: ["b", "a"] };
  const m2: PromotionArtifactManifest = { ...base, patchIds: ["a", "b"] };
  const d1 = await computePromotionManifestDigest(m1);
  const d2 = await computePromotionManifestDigest(m2);
  assert.equal(d1, d2);
  assert.deepEqual(canonicalPromotionManifestPayload(m1), canonicalPromotionManifestPayload(m2));
});

test("noop writer digest matches computePromotionManifestDigest", async () => {
  const writer = createNoopArtifactPromotionWriter();
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "noop-bundle",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: ["p1"],
    patchContentDigests: { p1: "deadbeef" },
  };
  const expected = await computePromotionManifestDigest(manifest);
  const ref = await writer.writeManifest(manifest);
  assert.equal(ref.manifestDigest, expected);
  assert.equal(ref.storageBackend, "noop");
  assert.ok(ref.writtenAt && ref.writtenAt.length > 0);
});

test("prepareApprovedPromotion -> noop write round-trip digest", async () => {
  const { storage, gateway } = gwFixture();
  await seedApprovedPatch(storage, gateway, "patch-a", "body-a");

  const prep = await buildPromotionManifestFromApprovedPatches(gateway, PROJECT, ["patch-a"]);
  assert.ok(prep.ok);
  const writer = createNoopArtifactPromotionWriter();
  const ref = await writer.writeManifest(prep.manifest);
  assert.ok(ref.manifestDigest);
  assert.equal(await promotionManifestMatchesDigest(prep.manifest, ref.manifestDigest!), true);
});

test("evaluatePromotionReleaseGate denies on bundle id mismatch", async () => {
  const noop = createNoopFlagshipEvaluationAdapter();
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "real",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: ["x"],
  };
  const gate = await evaluatePromotionReleaseGate(noop, {
    projectId: PROJECT,
    tier: "preview",
    bundleRef: { bundleId: "wrong" },
    manifest,
  });
  assert.equal(gate.outcome, "deny");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reasons[0]?.code, "BUNDLE_ID_MISMATCH");
});

test("evaluatePromotionReleaseGate denies on digest mismatch", async () => {
  const noop = createNoopFlagshipEvaluationAdapter();
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "bid",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: ["x"],
  };
  const gate = await evaluatePromotionReleaseGate(noop, {
    projectId: PROJECT,
    tier: "preview",
    bundleRef: { bundleId: "bid", manifestDigest: "00".repeat(32) },
    manifest,
  });
  assert.equal(gate.outcome, "deny");
  assert.equal(gate.reasons[0]?.code, "MANIFEST_DIGEST_MISMATCH");
});

test("evaluatePromotionReleaseGate allows through noop flagship when refs align", async () => {
  const noopFlagship = createNoopFlagshipEvaluationAdapter();
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "aligned",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: ["x"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  const gate = await evaluatePromotionReleaseGate(noopFlagship, {
    projectId: PROJECT,
    tier: "production",
    bundleRef: { bundleId: "aligned", manifestDigest: digest },
    manifest,
  });
  assert.equal(gate.outcome, "allow");
  assert.equal(gate.allowed, true);
  assert.equal(gate.reasons[0]?.code, "FLAGSHIP_NOOP");
});

test("promotionBundleIdsMatch helper", () => {
  const m: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b",
    projectId: PROJECT,
    createdAt: "2026-01-01T00:00:00.000Z",
    patchIds: [],
  };
  assert.equal(promotionBundleIdsMatch({ bundleId: "b" }, m), true);
  assert.equal(promotionBundleIdsMatch({ bundleId: "c" }, m), false);
});
