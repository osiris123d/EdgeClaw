/**
 * Cross-seam preview promotion pipeline — traces approved patch ids through prepare → build → gate → preview.
 * Mock host only — no MainAgent.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest, PromotionArtifactRef } from "../artifactPromotionTypes";
import type { ReleaseGateDecision } from "../flagshipTypes";
import type { PreviewDeployRequest, PreviewDeployResult } from "../../deploy/previewDeployTypes";
import type { PreviewPromotionPipelineHost } from "../orchestratorPreviewPromotionPipeline";
import { runPreviewPromotionPipeline } from "../orchestratorPreviewPromotionPipeline";

function manifestForPatches(projectId: string, patchIds: readonly string[]): PromotionArtifactManifest {
  return {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "bundle-cross",
    projectId,
    createdAt: "2026-11-01T12:00:00.000Z",
    patchIds: [...patchIds],
  };
}

test("cross-seam: approved patch ids flow through prepare → build → gate → executePreviewDeployment", async () => {
  const projectId = "proj-cross";
  const patchIds = ["approved-a", "approved-b"] as const;

  const trace = {
    stages: [] as string[],
    preparePatchIds: null as readonly string[] | null,
    gateTier: null as string | null,
    previewTier: null as string | null,
  };

  const manifest = manifestForPatches(projectId, patchIds);

  const bundleRef: PromotionArtifactRef = {
    bundleId: manifest.bundleId,
    manifestDigest: "cd".repeat(32),
    storageBackend: "noop",
    storageUri: "noop://cross/test",
  };

  const gate: ReleaseGateDecision = {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "OK", message: "cross-seam" }],
  };

  const previewResult: PreviewDeployResult = {
    status: "succeeded",
    previewUrl: "noop://preview/cross",
    previewIdentifier: "noop-id",
    audit: {
      projectId,
      bundleId: manifest.bundleId,
      manifestDigest: bundleRef.manifestDigest,
      gateOutcome: "allow",
      gateTier: "preview",
    },
  };

  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion(pid, ids, _opts) {
      trace.stages.push("prepareApprovedPromotion");
      trace.preparePatchIds = ids;
      assert.equal(pid, projectId);
      assert.deepEqual([...ids], [...patchIds]);
      return { ok: true, manifest };
    },
    async buildPromotionArtifact(m) {
      trace.stages.push("buildPromotionArtifact");
      assert.deepEqual(m.patchIds, [...patchIds]);
      return { ok: true, ref: bundleRef };
    },
    async evaluateReleaseGate(params) {
      trace.stages.push("evaluateReleaseGate");
      trace.gateTier = params.tier;
      assert.equal(params.projectId, projectId);
      assert.equal(params.tier, "preview");
      assert.equal(params.manifest.bundleId, manifest.bundleId);
      assert.equal(params.bundleRef.manifestDigest, bundleRef.manifestDigest);
      return gate;
    },
    async executePreviewDeployment(req: PreviewDeployRequest) {
      trace.stages.push("executePreviewDeployment");
      trace.previewTier = req.requestedTier;
      assert.equal(req.projectId, projectId);
      assert.equal(req.requestedTier, "preview");
      assert.equal(req.artifactWritten, true);
      assert.equal(req.releaseGateDecision.outcome, "allow");
      return previewResult;
    },
  };

  const out = await runPreviewPromotionPipeline(host, {
    projectId,
    patchIds,
    correlationId: "corr-cross-seam",
  });

  assert.equal(out.ok, true);
  if (!out.ok) {
    throw new Error("expected pipeline success");
  }

  assert.deepEqual(trace.stages, [
    "prepareApprovedPromotion",
    "buildPromotionArtifact",
    "evaluateReleaseGate",
    "executePreviewDeployment",
  ]);
  assert.deepEqual(trace.preparePatchIds, patchIds);
  assert.equal(trace.gateTier, "preview");
  assert.equal(trace.previewTier, "preview");
  assert.equal(out.previewDeploy.status, "succeeded");
  assert.deepEqual(out.manifest.patchIds, [...patchIds]);
});
