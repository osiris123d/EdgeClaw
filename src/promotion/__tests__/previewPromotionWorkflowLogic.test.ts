/**
 * Durable preview promotion workflow logic tests — no MainAgent / no Workflow runtime.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest, PromotionArtifactRef } from "../artifactPromotionTypes";
import type { ReleaseGateDecision } from "../flagshipTypes";
import type { PreviewDeployResult } from "../../deploy/previewDeployTypes";
import type { PreviewPromotionPipelineHost } from "../orchestratorPreviewPromotionPipeline";
import {
  runPreviewPromotionWorkflow,
  type PreviewPromotionWorkflowStep,
} from "../previewPromotionWorkflowLogic";

function createCachingStep(): PreviewPromotionWorkflowStep {
  const cache = new Map<string, unknown>();
  return {
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(name)) {
        return cache.get(name) as T;
      }
      const v = await fn();
      cache.set(name, v);
      return v;
    },
  };
}

function manifest(): PromotionArtifactManifest {
  return {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "wf-b",
    projectId: "wf-p",
    createdAt: "2026-06-15T00:00:00.000Z",
    patchIds: ["a"],
  };
}

function ref(): PromotionArtifactRef {
  return { bundleId: "wf-b", manifestDigest: "cd".repeat(32), storageBackend: "noop" };
}

function gateAllow(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "OK", message: "y" }],
  };
}

function previewOk(): PreviewDeployResult {
  return {
    status: "succeeded",
    audit: {
      projectId: "wf-p",
      bundleId: "wf-b",
      gateOutcome: "allow",
      gateTier: "preview",
    },
  };
}

test("happy path records all completed steps", async () => {
  const m = manifest();
  const r = ref();
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
      return previewOk();
    },
  };

  const out = await runPreviewPromotionWorkflow(
    { projectId: m.projectId, patchIds: ["a"] },
    createCachingStep(),
    host,
    {
      reportProgress: async () => {},
    }
  );

  assert.equal(out.pipeline.ok, true);
  assert.deepEqual(out.completedSteps, [
    "prepare-manifest",
    "write-artifact",
    "release-gate",
    "preview-deploy",
  ]);
});

test("prepare_failed stops before artifact", async () => {
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      return { ok: false, error: "no patches" };
    },
    async buildPromotionArtifact() {
      throw new Error("no");
    },
    async evaluateReleaseGate() {
      throw new Error("no");
    },
    async executePreviewDeployment() {
      throw new Error("no");
    },
  };

  const out = await runPreviewPromotionWorkflow(
    { projectId: "p", patchIds: ["x"] },
    createCachingStep(),
    host
  );

  assert.equal(out.pipeline.ok, false);
  assert.equal(out.pipeline.status, "prepare_failed");
  assert.deepEqual(out.completedSteps, ["prepare-manifest"]);
});

test("caching step replays without re-invoking host prepare", async () => {
  let prepareCalls = 0;
  const m = manifest();
  const r = ref();
  const host: PreviewPromotionPipelineHost = {
    async prepareApprovedPromotion() {
      prepareCalls += 1;
      return { ok: true, manifest: m };
    },
    async buildPromotionArtifact() {
      return { ok: true, ref: r };
    },
    async evaluateReleaseGate() {
      return gateAllow();
    },
    async executePreviewDeployment() {
      return previewOk();
    },
  };

  const step = createCachingStep();
  await runPreviewPromotionWorkflow({ projectId: m.projectId, patchIds: ["a"] }, step, host);
  assert.equal(prepareCalls, 1);

  await runPreviewPromotionWorkflow({ projectId: m.projectId, patchIds: ["a"] }, step, host);
  assert.equal(prepareCalls, 1);
});

test("release_gate_blocked lists gate steps completed", async () => {
  const m = manifest();
  const r = ref();
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
        reasons: [{ code: "N", message: "no" }],
      };
    },
    async executePreviewDeployment() {
      throw new Error("no");
    },
  };

  const out = await runPreviewPromotionWorkflow(
    { projectId: m.projectId, patchIds: ["a"] },
    createCachingStep(),
    host
  );

  assert.equal(out.pipeline.ok, false);
  assert.deepEqual(out.completedSteps, ["prepare-manifest", "write-artifact", "release-gate"]);
});
