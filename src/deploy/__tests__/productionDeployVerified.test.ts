/**
 * Production promotion-verified adapter tests — no MainAgent import.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { computePromotionManifestDigest } from "../../promotion/promotionManifestCanonical";
import { createR2ArtifactPromotionWriter } from "../../promotion/artifactPromotionR2";
import type { Env } from "../../lib/env";
import { resolveProductionDeployAdapter } from "../productionDeployAdapterFactory";
import { createPromotionArtifactVerifiedProductionDeployAdapter } from "../productionDeployPromotionVerified";
import { createCloudflareScriptSettingsWitnessProductionDeployAdapter } from "../productionDeployCloudflareWitness";
import type { ProductionDeployRequest } from "../productionDeployTypes";
import { runProductionDeployment } from "../orchestratorProductionDeploy";

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

function gateProductionAllow(): ReleaseGateDecision {
  return {
    outcome: "allow",
    allowed: true,
    tier: "production",
    reasons: [{ code: "PROD_OK", message: "ok" }],
  };
}

function validApprovals() {
  return [
    { approverId: "alice", approvedAt: "2026-09-01T13:00:00.000Z", role: "release_manager" },
    { approverId: "bob", approvedAt: "2026-09-01T13:05:00.000Z", role: "security" },
  ] as const;
}

async function baseManifest(): Promise<{ manifest: PromotionArtifactManifest; digest: string }> {
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-prod-v",
    projectId: "proj-prod-v",
    createdAt: "2026-09-01T12:00:00.000Z",
    patchIds: ["p1"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  return { manifest, digest };
}

const bucketName = "edgeclaw-truth-promotion-artifacts";

test("promotion-verified production adapter succeeds with canonical URL + approvals", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest, digest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const adapter = createPromotionArtifactVerifiedProductionDeployAdapter(writer, {
    canonicalProductionUrl: "https://prod.example.test/",
  });

  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
    changeTicketId: "CHG-42",
  };

  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "succeeded");
  assert.equal(res.productionDeploymentUrl, "https://prod.example.test/");
  assert.ok(res.productionIdentifier);
  assert.ok(res.rollbackHint?.includes("does not upload"));
  assert.equal(res.audit.manifestDigest, digest);
  assert.equal(res.audit.adapterBackend?.includes("promotion_verified_production"), true);
});

test("resolveProductionDeployAdapter noop when ENABLE_PRODUCTION_DEPLOY=false", async () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: createMemoryR2Bucket(),
    PROMOTION_ARTIFACTS_BUCKET_NAME: bucketName,
    ENABLE_PRODUCTION_DEPLOY: "false",
  } as Env;

  const adapter = resolveProductionDeployAdapter(env);
  const { manifest, digest } = await baseManifest();
  const res = await adapter.deploy({
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  });
  assert.equal(res.status, "succeeded");
  assert.ok(res.productionDeploymentUrl?.startsWith("noop://production/"));
});

test("resolveProductionDeployAdapter uses noop without promotion bucket", () => {
  const env = {} as Env;
  const a = resolveProductionDeployAdapter(env);
  assert.equal(typeof a.deploy, "function");
});

test("promotion-verified production: durable manifest mismatch -> policy_blocked", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const tampered: PromotionArtifactManifest = {
    ...manifest,
    patchIds: [...manifest.patchIds, "x"],
  };

  const adapter = createPromotionArtifactVerifiedProductionDeployAdapter(writer, {
    canonicalProductionUrl: "https://prod/",
  });

  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest: tampered,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };

  const res = await adapter.deploy(req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "policy_blocked");
  assert.ok(res.error?.includes("Durable manifest"));
});

test("witness wrapper failure maps to adapter_error (production)", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, { bucketDisplayName: bucketName });
  const { manifest } = await baseManifest();
  const ref = await writer.writeManifest(manifest);

  const inner = createPromotionArtifactVerifiedProductionDeployAdapter(writer, {
    canonicalProductionUrl: "https://prod/",
  });

  const wrapped = createCloudflareScriptSettingsWitnessProductionDeployAdapter(inner, {
    accountId: "a",
    apiToken: "t",
    workerScriptName: "edgeclaw-truth-agent",
    fetchFn: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "no" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: ref,
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };

  const res = await runProductionDeployment(wrapped, req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "adapter_error");
  assert.equal(res.audit.cloudflareWitness, "failed");
  assert.equal(res.productionDeploymentUrl, "https://prod/");
});
