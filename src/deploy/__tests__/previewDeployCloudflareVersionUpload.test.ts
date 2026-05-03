/**
 * Workers version upload preview adapter wrapper — mocked fetch only.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { createWorkersVersionUploadPreviewDeployAdapter } from "../previewDeployCloudflareVersionUpload";
import type { PreviewDeployAdapter, PreviewDeployRequest } from "../previewDeployTypes";

function gateAllowPreview(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "TEST_ALLOW", message: "test" }],
  };
}

function baseRequest(): PreviewDeployRequest {
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-wrap",
    projectId: "proj-w",
    createdAt: "2026-04-01T12:00:00.000Z",
    patchIds: ["a"],
  };
  return {
    projectId: manifest.projectId,
    bundleRef: {
      bundleId: manifest.bundleId,
      manifestDigest: "sha256:deadbeef",
    },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };
}

function baseAudit() {
  return {
    projectId: "proj-w",
    bundleId: "b-wrap",
    gateOutcome: "allow" as const,
    gateTier: "preview" as const,
    adapterBackend: "promotion_verified",
  };
}

test("wrapper passes through when inner status is not succeeded", async () => {
  const inner: PreviewDeployAdapter = {
    async deploy() {
      return {
        status: "failed",
        failureCategory: "adapter_error",
        error: "inner",
        audit: baseAudit(),
      };
    },
  };
  const wrapped = createWorkersVersionUploadPreviewDeployAdapter(inner, {
    accountId: "a",
    apiToken: "t",
    uploadScriptName: "stub",
    compatibilityDate: "2025-01-14",
    fetchFn: async () => {
      throw new Error("fetch should not run");
    },
  });
  const res = await wrapped.deploy(baseRequest());
  assert.equal(res.status, "failed");
  assert.equal(res.error, "inner");
});

test("wrapper on inner success uploads and merges audit + previewIdentifier", async () => {
  const inner: PreviewDeployAdapter = {
    async deploy() {
      return {
        status: "succeeded",
        previewUrl: "https://verified.example/preview",
        previewIdentifier: "inner-id",
        audit: baseAudit(),
      };
    },
  };

  const wrapped = createWorkersVersionUploadPreviewDeployAdapter(inner, {
    accountId: "acct",
    apiToken: "tok",
    uploadScriptName: "edgeclaw-preview-stub",
    compatibilityDate: "2025-01-14",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            id: "version-wxyz",
            metadata: { hasPreview: false },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  const res = await wrapped.deploy(baseRequest());
  assert.equal(res.status, "succeeded");
  assert.equal(res.previewIdentifier, "version-wxyz");
  assert.ok(res.audit.adapterBackend?.includes("+cf_workers_version_upload"));
  assert.equal(res.audit.workersApiVersionId, "version-wxyz");
  assert.equal(res.audit.workersVersionHasPreview, false);
});

test("wrapper returns adapter_error when upload fails after inner success", async () => {
  const inner: PreviewDeployAdapter = {
    async deploy() {
      return {
        status: "succeeded",
        previewUrl: "https://inner/",
        previewIdentifier: "inner-id",
        audit: baseAudit(),
      };
    },
  };

  const wrapped = createWorkersVersionUploadPreviewDeployAdapter(inner, {
    accountId: "acct",
    apiToken: "tok",
    uploadScriptName: "stub",
    compatibilityDate: "2025-01-14",
    fetchFn: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "quota" }] }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const res = await wrapped.deploy(baseRequest());
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "adapter_error");
  assert.equal(res.error, "quota");
  assert.ok(res.audit.adapterBackend?.includes("+cf_workers_version_upload_failed"));
});
