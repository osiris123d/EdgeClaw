/**
 * Preview deploy orchestration tests — no MainAgent import.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { computePromotionManifestDigest } from "../../promotion/promotionManifestCanonical";
import { createNoopPreviewDeployAdapter } from "../previewDeployNoop";
import type { PreviewDeployAdapter, PreviewDeployRequest } from "../previewDeployTypes";
import { runPreviewDeployment } from "../orchestratorPreviewDeploy";

function gateAllowPreview(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "TEST_ALLOW", message: "test" }],
  };
}

function gateDeny(): ReleaseGateDecision {
  return {
    outcome: "deny",
    allowed: false,
    tier: "preview",
    reasons: [{ code: "DENY", message: "no" }],
  };
}

function gateHold(): ReleaseGateDecision {
  return {
    outcome: "hold",
    allowed: false,
    tier: "preview",
    reasons: [{ code: "HOLD", message: "wait" }],
  };
}

async function baseManifest(): Promise<{ manifest: PromotionArtifactManifest; digest: string }> {
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-unittest",
    projectId: "proj-u",
    createdAt: "2026-04-01T12:00:00.000Z",
    patchIds: ["a"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  return { manifest, digest };
}

test("allow + valid refs + artifactWritten -> noop succeeds", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "succeeded");
  assert.ok(res.previewUrl?.startsWith("noop://preview/"));
});

test("deny gate -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateDeny(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "RELEASE_GATE_NOT_ALLOW");
});

test("hold gate -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateHold(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "RELEASE_GATE_HOLD");
});

test("bundle id mismatch -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: "wrong-id", manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "BUNDLE_ID_MISMATCH");
});

test("digest mismatch -> blocked", async () => {
  const { manifest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: "00".repeat(32) },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "MANIFEST_DIGEST_MISMATCH");
});

test("non-preview requestedTier -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "production",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "PREVIEW_TIER_REQUIRED");
});

test("gate tier not preview -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const decision: ReleaseGateDecision = {
    outcome: "allow",
    allowed: true,
    tier: "production",
    reasons: [{ code: "X", message: "wrong tier in decision" }],
  };
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: decision,
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "RELEASE_GATE_TIER_NOT_PREVIEW");
});

test("artifactWritten false -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopPreviewDeployAdapter();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: false,
  };
  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "ARTIFACT_NOT_RECORDED");
});

test("adapter throw -> failed", async () => {
  const { manifest, digest } = await baseManifest();
  const boom: PreviewDeployAdapter = {
    async deploy() {
      throw new Error("simulated wrangler failure");
    },
  };
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };
  const res = await runPreviewDeployment(boom, req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "adapter_error");
  assert.ok(res.error?.includes("simulated wrangler failure"));
});
