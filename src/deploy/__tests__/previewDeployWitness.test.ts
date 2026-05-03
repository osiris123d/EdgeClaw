/**
 * Cloudflare script-settings witness + factory fallback tests — no MainAgent import.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { computePromotionManifestDigest } from "../../promotion/promotionManifestCanonical";
import { createR2ArtifactPromotionWriter } from "../../promotion/artifactPromotionR2";
import type { Env } from "../../lib/env";
import {
  createCloudflareScriptSettingsWitnessPreviewDeployAdapter,
  fetchWorkerScriptSettingsWitness,
} from "../previewDeployCloudflareWitness";
import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "../previewDeployTypes";
import { resolvePreviewDeployAdapter } from "../previewDeployAdapterFactory";
import { runPreviewDeployment } from "../orchestratorPreviewDeploy";

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
    bundleId: "b-witness",
    projectId: "proj-w",
    createdAt: "2026-04-01T12:00:00.000Z",
    patchIds: ["a"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  return { manifest, digest };
}

const bucketName = "edgeclaw-truth-promotion-artifacts";

test("fetchWorkerScriptSettingsWitness success parses tags", async () => {
  const w = await fetchWorkerScriptSettingsWitness({
    accountId: "acct",
    apiToken: "tok",
    workerScriptName: "edgeclaw-truth-agent",
    fetchFn: async () =>
      new Response(
        JSON.stringify({ success: true, result: { tags: ["preview", "qa"] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });
  assert.equal(w.ok, true);
  if (w.ok) {
    assert.equal(w.tagsJoined, "preview,qa");
  }
});

test("fetchWorkerScriptSettingsWitness HTTP error", async () => {
  const w = await fetchWorkerScriptSettingsWitness({
    accountId: "acct",
    apiToken: "tok",
    workerScriptName: "w",
    fetchFn: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "Unauthorized" }] }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
  });
  assert.equal(w.ok, false);
  if (!w.ok) {
    assert.ok(w.error.includes("Unauthorized"));
    assert.equal(w.httpStatus, 403);
  }
});

test("witness wrapper skips Cloudflare call when inner not succeeded", async () => {
  let witnessCalls = 0;
  const inner: PreviewDeployAdapter = {
    async deploy(): Promise<PreviewDeployResult> {
      return {
        status: "failed",
        failureCategory: "policy_blocked",
        error: "inner",
        audit: {
          projectId: "p",
          bundleId: "b",
          gateOutcome: "allow",
          gateTier: "preview",
          adapterBackend: "promotion_verified",
        },
      };
    },
  };

  const wrapped = createCloudflareScriptSettingsWitnessPreviewDeployAdapter(inner, {
    accountId: "a",
    apiToken: "t",
    workerScriptName: "w",
    fetchFn: async () => {
      witnessCalls++;
      return new Response("{}", { status: 500 });
    },
  });

  const { manifest, digest } = await baseManifest();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await wrapped.deploy(req);
  assert.equal(res.status, "failed");
  assert.equal(witnessCalls, 0);
});

test("witness wrapper failure maps to adapter_error with audit cloudflareWitness failed", async () => {
  const inner: PreviewDeployAdapter = {
    async deploy(): Promise<PreviewDeployResult> {
      return {
        status: "succeeded",
        previewUrl: "https://preview.example/",
        previewIdentifier: "pid",
        audit: {
          projectId: "p",
          bundleId: "b",
          manifestDigest: "d",
          gateOutcome: "allow",
          gateTier: "preview",
          adapterBackend: "promotion_verified",
        },
      };
    },
  };

  const wrapped = createCloudflareScriptSettingsWitnessPreviewDeployAdapter(inner, {
    accountId: "a",
    apiToken: "t",
    workerScriptName: "w",
    fetchFn: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const { manifest, digest } = await baseManifest();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await wrapped.deploy(req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "adapter_error");
  assert.equal(res.audit.cloudflareWitness, "failed");
  assert.equal(res.previewUrl, "https://preview.example/");
  assert.ok(res.error?.includes("bad token"));
});

test("witness wrapper success augments audit and previewIdentifier", async () => {
  const inner: PreviewDeployAdapter = {
    async deploy(): Promise<PreviewDeployResult> {
      return {
        status: "succeeded",
        previewUrl: "https://x/",
        previewIdentifier: "base-id",
        audit: {
          projectId: "p",
          bundleId: "b",
          gateOutcome: "allow",
          gateTier: "preview",
          adapterBackend: "promotion_verified",
        },
      };
    },
  };

  const wrapped = createCloudflareScriptSettingsWitnessPreviewDeployAdapter(inner, {
    accountId: "a",
    apiToken: "t",
    workerScriptName: "edgeclaw-truth-agent",
    fetchFn: async () =>
      new Response(JSON.stringify({ success: true, result: { tags: ["t1"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const { manifest, digest } = await baseManifest();
  const req: PreviewDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateAllowPreview(),
    requestedTier: "preview",
    artifactWritten: true,
  };

  const res = await wrapped.deploy(req);
  assert.equal(res.status, "succeeded");
  assert.equal(res.audit.cloudflareWitness, "ok");
  assert.equal(res.audit.cloudflareScriptTags, "t1");
  assert.ok(res.previewIdentifier?.includes("cf_script_settings"));
  assert.ok(res.previewIdentifier?.includes("tags=t1"));
});

test("resolvePreviewDeployAdapter witness flag without token does not wrap (no cloudflareWitness)", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const env = {
    PROMOTION_ARTIFACTS_BUCKET: bucket,
    PROMOTION_ARTIFACTS_BUCKET_NAME: bucketName,
    ENABLE_PREVIEW_DEPLOY_CF_WITNESS: "true",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    // intentional: no CLOUDFLARE_API_TOKEN — factory skips witness wrapper
  } as Env;

  const adapter = resolvePreviewDeployAdapter(env);
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
  assert.equal(res.audit.cloudflareWitness, undefined);
});

test("resolvePreviewDeployAdapter witness enabled uses global fetch for script-settings", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("/workers/scripts/") && u.includes("/script-settings")) {
      return new Response(JSON.stringify({ success: true, result: { tags: ["pv"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, result: { subdomain: "sub" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const env = {
      PROMOTION_ARTIFACTS_BUCKET: bucket,
      PROMOTION_ARTIFACTS_BUCKET_NAME: bucketName,
      ENABLE_PREVIEW_DEPLOY_CF_WITNESS: "true",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "secret",
      PREVIEW_WORKER_SCRIPT_NAME: "edgeclaw-truth-agent",
    } as Env;

    const adapter = resolvePreviewDeployAdapter(env);
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
    assert.equal(res.audit.cloudflareWitness, "ok");
    assert.equal(res.audit.cloudflareScriptTags, "pv");
    assert.ok(res.audit.adapterBackend?.includes("cf_script_settings"));
  } finally {
    globalThis.fetch = prevFetch;
  }
});
