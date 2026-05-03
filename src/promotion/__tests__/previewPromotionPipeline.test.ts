/**
 * Preview promotion pipeline tests — mock {@link PreviewPromotionPipelineHost}; no MainAgent import.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest, PromotionArtifactRef } from "../artifactPromotionTypes";
import type { ReleaseGateDecision } from "../flagshipTypes";
import type { PreviewDeployResult } from "../../deploy/previewDeployTypes";
import type { PreviewPromotionPipelineHost } from "../orchestratorPreviewPromotionPipeline";
import { runPreviewPromotionPipeline } from "../orchestratorPreviewPromotionPipeline";

function baseManifest(overrides?: Partial<PromotionArtifactManifest>): PromotionArtifactManifest {
  return {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "bundle-pipe",
    projectId: "proj-pipe",
    createdAt: "2026-06-01T12:00:00.000Z",
    patchIds: ["p1"],
    ...overrides,
  };
}

function refFor(m: PromotionArtifactManifest): PromotionArtifactRef {
  return {
    bundleId: m.bundleId,
    manifestDigest: "ab".repeat(32),
    storageBackend: "noop",
  };
}

function gateAllow(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "OK", message: "ok" }],
  };
}

function previewOk(): PreviewDeployResult {
  return {
    status: "succeeded",
    previewUrl: "https://preview.example/",
    previewIdentifier: "id-1",
    audit: {
      projectId: "proj-pipe",
      bundleId: "bundle-pipe",
      gateOutcome: "allow",
      gateTier: "preview",
    },
  };
}

test("happy path: all stages succeed", async () => {
  const m = baseManifest();
  const r = refFor(m);
  const gate = gateAllow();
  const prev = previewOk();

  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return gate;
    },
    async executePreviewDeployment() {
      return prev;
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
    correlationId: "corr-happy",
  });

  assert.equal(out.ok, true);
  if (!out.ok) {
    throw new Error("expected success");
  }
  assert.equal(out.status, "succeeded");
  assert.equal(out.manifest.bundleId, m.bundleId);
  assert.equal(out.bundleRef.bundleId, r.bundleId);
  assert.equal(out.previewDeploy.previewUrl, prev.previewUrl);
});

test("prepare_failed when prepareApprovedPromotion returns error", async () => {
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: false, error: "patchIds must be non-empty" };
    },
    async buildPromotionArtifact() {
      throw new Error("should not run");
    },
    async evaluateReleaseGate() {
      throw new Error("should not run");
    },
    async executePreviewDeployment() {
      throw new Error("should not run");
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: "x",
    patchIds: [],
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, "prepare_failed");
  assert.equal(out.failureKind, "no_approved_patches_or_prepare_error");
  assert.ok(out.error.includes("non-empty"));
});

test("artifact_write_failed", async () => {
  const m = baseManifest();
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: false, error: "R2 put failed" };
    },
    async evaluateReleaseGate() {
      throw new Error("should not run");
    },
    async executePreviewDeployment() {
      throw new Error("should not run");
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, "artifact_write_failed");
  assert.equal(out.failureKind, "artifact_write_failed");
  assert.equal(out.error, "R2 put failed");
});

test("release_gate_blocked deny", async () => {
  const m = baseManifest();
  const r = refFor(m);
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return {
        outcome: "deny",
        allowed: false,
        tier: "preview",
        reasons: [{ code: "POLICY", message: "no" }],
      };
    },
    async executePreviewDeployment() {
      throw new Error("should not run");
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, "release_gate_blocked");
  assert.equal(out.failureKind, "release_gate_deny");
});

test("release_gate_blocked hold", async () => {
  const m = baseManifest();
  const r = refFor(m);
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return {
        outcome: "hold",
        allowed: false,
        tier: "preview",
        reasons: [{ code: "HOLD", message: "wait" }],
      };
    },
    async executePreviewDeployment() {
      throw new Error("should not run");
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
  });

  assert.equal(out.ok, false);
  assert.equal(out.failureKind, "release_gate_hold");
});

test("preview_deploy_blocked_or_failed — blocked", async () => {
  const m = baseManifest();
  const r = refFor(m);
  const prev: PreviewDeployResult = {
    status: "blocked",
    audit: {
      projectId: m.projectId,
      bundleId: m.bundleId,
      gateOutcome: "allow",
      gateTier: "preview",
    },
    failureCategory: "precheck_failed",
    blockReasons: [{ code: "X", message: "y" }],
  };

  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return gateAllow();
    },
    async executePreviewDeployment() {
      return prev;
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, "preview_deploy_blocked_or_failed");
  assert.equal(out.failureKind, "preview_deploy_blocked");
});

test("preview_deploy_blocked_or_failed — failed", async () => {
  const m = baseManifest();
  const r = refFor(m);
  const prev: PreviewDeployResult = {
    status: "failed",
    audit: {
      projectId: m.projectId,
      bundleId: m.bundleId,
      gateOutcome: "allow",
      gateTier: "preview",
    },
    failureCategory: "adapter_error",
    error: "boom",
  };

  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return gateAllow();
    },
    async executePreviewDeployment() {
      return prev;
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
  });

  assert.equal(out.ok, false);
  assert.equal(out.failureKind, "preview_deploy_failed");
});

test("evaluateReleaseGate receives correlationId from input", async () => {
  const m = baseManifest();
  const r = refFor(m);
  let seenCorrelation: string | undefined;

  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate(params) {
      seenCorrelation = params.correlationId;
      return gateAllow();
    },
    async executePreviewDeployment() {
      return previewOk();
    },
  };

  await runPreviewPromotionPipeline(host, {
    projectId: m.projectId,
    patchIds: ["p1"],
    correlationId: "workflow-step-9",
  });

  assert.equal(seenCorrelation, "workflow-step-9");
});
