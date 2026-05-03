/**
 * R2-verified preview deploy adapter tests — no MainAgent import.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { computePromotionManifestDigest } from "../../promotion/promotionManifestCanonical";
import { createR2ArtifactPromotionWriter } from "../../promotion/artifactPromotionR2";
import { resolvePreviewDeployAdapter } from "../previewDeployAdapterFactory";
import { createR2VerifiedPreviewDeployAdapter } from "../previewDeployR2Verified";
import type { PreviewDeployRequest } from "../previewDeployTypes";
import { runPreviewDeployment } from "../orchestratorPreviewDeploy";
import type { Env } from "../../lib/env";

function createMemoryR2Bucket(): R2Bucket {
  const store = new Map<string, string>();

  return {
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
    ): Promise<R2Object> {
      const text =
        typeof value === "string"
          ? value
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : await new Response(value as BodyInit).text();
      store.set(key, text);
      const etag = `"mem-${key.length}-${text.length}"`;
      return {
        key,
        size: text.length,
        etag,
        httpEtag: etag,
      } as R2Object;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const body = store.get(key);
      if (body === undefined) {
        return null;
      }
      const etag = `"mem-${key.length}-${body.length}"`;
      return {
        key,
        size: body.length,
        etag,
        httpEtag: etag,
        async text() {
          return body;
        },
      } as R2ObjectBody;
    },
  } as R2Bucket;
}

function gateAllowPreview(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "TEST_ALLOW", message: "test" }],
  };
}

async function baseManifest(): Promise<{ manifest: PromotionArtifactManifest; digest: string }> {
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-prev-test",
    projectId: "proj-prev",
    createdAt: "2026-04-01T12:00:00.000Z",
    patchIds: ["a"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  return { manifest, digest };
}

const bucketName = "edgeclaw-truth-promotion-artifacts";

test("allow + R2 ref + artifactWritten -> verified adapter succeeds with canonical URL", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest, digest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const adapter = createR2VerifiedPreviewDeployAdapter({
    bucket,
    bucketDisplayName: bucketName,
    canonicalPreviewUrl: "https://preview.example.test/",
  });

  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "succeeded");
  assert.equal(res.previewUrl, "https://preview.example.test/");
  assert.ok(res.previewIdentifier);
  assert.equal(res.audit.manifestDigest, digest);
});

test("resolvePreviewDeployAdapter noop when ENABLE_PREVIEW_DEPLOY_R2=false", async () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: createMemoryR2Bucket(),
    PROMOTION_ARTIFACTS_BUCKET_NAME: bucketName,
    ENABLE_PREVIEW_DEPLOY_R2: "false",
  } as Env;

  const adapter = resolvePreviewDeployAdapter(env);
  const { manifest, digest } = await baseManifest();
  const res = await adapter.deploy({
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  });
  assert.equal(res.status, "succeeded");
  assert.ok(res.previewUrl?.startsWith("noop://"));
});

test("resolvePreviewDeployAdapter uses noop without promotion bucket", () => {
  const env = {} as Env;
  const a = resolvePreviewDeployAdapter(env);
  assert.equal(typeof a.deploy, "function");
});

test("non-r2 bundleRef -> adapter fails policy_blocked (cannot read manifest)", async () => {
  const bucket = createMemoryR2Bucket();
  const { manifest, digest } = await baseManifest();

  const adapter = createR2VerifiedPreviewDeployAdapter({
    bucket,
    bucketDisplayName: bucketName,
    canonicalPreviewUrl: "https://x/",
  });

  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: {
      bundleId: manifest.bundleId,
      manifestDigest: digest,
      storageBackend: "noop",
      storageUri: "noop://x",
    },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "policy_blocked");
  assert.ok(res.error?.includes("Failed to read promotion manifest"));
});

test("workers.dev URL from mocked subdomain fetch", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const adapter = createR2VerifiedPreviewDeployAdapter({
    bucket,
    bucketDisplayName: bucketName,
    accountId: "acct",
    apiToken: "tok",
    workerScriptName: "edgeclaw-truth-agent",
    fetchFn: async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.ok(u.includes("/workers/subdomain"));
      return new Response(JSON.stringify({ success: true, result: { subdomain: "myacct" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await runPreviewDeployment(adapter, req);
  assert.equal(res.status, "succeeded");
  assert.equal(res.previewUrl, "https://edgeclaw-truth-agent.myacct.workers.dev");
});

test("manifest request differs from durable bytes -> policy_blocked (adapter direct)", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const tampered: PromotionArtifactManifest = {
    ...manifest,
    patchIds: [...manifest.patchIds, "extra"],
  };

  const adapter = createR2VerifiedPreviewDeployAdapter({
    bucket,
    bucketDisplayName: bucketName,
    canonicalPreviewUrl: "https://x/",
  });

  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest: tampered,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await adapter.deploy(req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "policy_blocked");
  assert.ok(res.error?.includes("Durable manifest"));
});
