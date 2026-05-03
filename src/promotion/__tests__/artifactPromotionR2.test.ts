/**
 * R2-backed promotion writer + factory wiring tests (in-memory R2 stub — no Workers runtime).
 * Run: `npm run test:promotion-r2` or via orchestrator integration suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../artifactPromotionTypes";
import {
  buildPromotionManifestR2ObjectKey,
  buildPromotionR2StorageUri,
  createR2ArtifactPromotionWriter,
  parsePromotionR2StorageUri,
} from "../artifactPromotionR2";
import { computePromotionManifestDigest } from "../promotionManifestCanonical";
import { resolveArtifactPromotionWriter } from "../artifactPromotionWriterFactory";
import type { Env } from "../../lib/env";

/** Minimal in-memory R2 for Node tests (Workers `R2Bucket` subset). */
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

function sampleManifest(overrides?: Partial<PromotionArtifactManifest>): PromotionArtifactManifest {
  return {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "bundle-r2-test",
    projectId: "proj-r2",
    createdAt: "2026-05-01T00:00:00.000Z",
    patchIds: ["p1", "p2"],
    patchContentDigests: { p1: "aa", p2: "bb" },
    ...overrides,
  };
}

test("buildPromotionManifestR2ObjectKey is stable", () => {
  assert.equal(
    buildPromotionManifestR2ObjectKey("my/project", "bid-1"),
    "promotion/manifests/v1/projects/my%2Fproject/bundles/bid-1.json"
  );
});

test("R2 storage URI round-trips key", () => {
  const key = buildPromotionManifestR2ObjectKey("p", "b");
  const uri = buildPromotionR2StorageUri("edgeclaw-truth-promotion-artifacts", key);
  assert.equal(parsePromotionR2StorageUri(uri, "edgeclaw-truth-promotion-artifacts")?.objectKey, key);
  assert.equal(parsePromotionR2StorageUri(uri, "wrong-bucket"), null);
});

test("writeManifest -> readManifest round trip", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, {
    bucketDisplayName: "edgeclaw-truth-promotion-artifacts",
  });
  const manifest = sampleManifest();
  const ref = await writer.writeManifest(manifest);
  assert.equal(ref.storageBackend, "r2");
  assert.ok(ref.storageUri?.startsWith("r2://edgeclaw-truth-promotion-artifacts/"));
  assert.ok(ref.manifestDigest && ref.manifestDigest.length === 64);
  assert.ok(ref.objectVersion);

  const read = await writer.readManifest!(ref);
  assert.ok(read);
  assert.equal(read!.bundleId, manifest.bundleId);
  assert.equal(read!.projectId, manifest.projectId);
  const d1 = await computePromotionManifestDigest(manifest);
  const d2 = await computePromotionManifestDigest(read!);
  assert.equal(d1, d2);
});

test("digest stability across patchIds order in manifest object", async () => {
  const a = sampleManifest({ patchIds: ["z", "a"] });
  const b = sampleManifest({ patchIds: ["a", "z"] });
  assert.equal(await computePromotionManifestDigest(a), await computePromotionManifestDigest(b));
});

test("readManifest rejects digest mismatch", async () => {
  const bucket = createMemoryR2Bucket();
  const writer = createR2ArtifactPromotionWriter(bucket, {
    bucketDisplayName: "edgeclaw-truth-promotion-artifacts",
  });
  const manifest = sampleManifest();
  const ref = await writer.writeManifest(manifest);
  const badRef = { ...ref, manifestDigest: "00".repeat(32) };
  const read = await writer.readManifest!(badRef);
  assert.equal(read, null);
});

test("resolveArtifactPromotionWriter falls back to noop without bucket", async () => {
  const env = {} as Env;
  const w = resolveArtifactPromotionWriter(env);
  const m = sampleManifest({ bundleId: crypto.randomUUID() });
  const ref = await w.writeManifest(m);
  assert.equal(ref.storageBackend, "noop");
});

test("resolveArtifactPromotionWriter uses noop when ENABLE_PROMOTION_ARTIFACTS_R2 is false", () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: createMemoryR2Bucket(),
    ENABLE_PROMOTION_ARTIFACTS_R2: "false",
  } as Env;
  const w = resolveArtifactPromotionWriter(env);
  return w.writeManifest(sampleManifest()).then((ref) => {
    assert.equal(ref.storageBackend, "noop");
  });
});

test("resolveArtifactPromotionWriter uses R2 when bucket bound", async () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: createMemoryR2Bucket(),
    PROMOTION_ARTIFACTS_BUCKET_NAME: "edgeclaw-truth-promotion-artifacts",
  } as Env;
  const w = resolveArtifactPromotionWriter(env);
  const ref = await w.writeManifest(sampleManifest({ bundleId: crypto.randomUUID() }));
  assert.equal(ref.storageBackend, "r2");
});
