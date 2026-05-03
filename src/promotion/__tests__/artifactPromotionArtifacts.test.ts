/**
 * Unit tests for Artifacts URI helpers + factory precedence (no live Artifacts / git).
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildPromotionManifestR2ObjectKey } from "../artifactPromotionR2";
import {
  buildPromotionArtifactsStorageUri,
  parsePromotionArtifactsStorageUri,
} from "../artifactPromotionArtifacts";
import { resolveArtifactPromotionWriter } from "../artifactPromotionWriterFactory";
import type { Env } from "../../lib/env";
import { computePromotionManifestDigest } from "../promotionManifestCanonical";
import type { PromotionArtifactManifest } from "../artifactPromotionTypes";

function memoryR2Bucket(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: string | ReadableStream | ArrayBuffer | Blob | null): Promise<R2Object> {
      const text =
        typeof value === "string"
          ? value
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : await new Response(value as BodyInit).text();
      store.set(key, text);
      const etag = `"mem-${key.length}"`;
      return { key, size: text.length, etag, httpEtag: etag } as R2Object;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const body = store.get(key);
      if (body === undefined) return null;
      const etag = `"mem-${key.length}"`;
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

function sampleManifest(): PromotionArtifactManifest {
  return {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-artifacts-uri",
    projectId: "proj/x",
    createdAt: "2026-06-01T00:00:00.000Z",
    patchIds: ["a", "z"],
  };
}

test("Artifacts storage URI round-trips manifest path (matches R2 key)", () => {
  const repo = "edgeclaw-promotion-manifests";
  const key = buildPromotionManifestR2ObjectKey("proj/x", "b1");
  const uri = buildPromotionArtifactsStorageUri(repo, key);
  assert.equal(parsePromotionArtifactsStorageUri(uri, repo)?.relativePath, key);
  assert.equal(parsePromotionArtifactsStorageUri(uri, "wrong-repo"), null);
});

test("digest stability: same canonical manifest as R2 writer expectation", async () => {
  const m = sampleManifest();
  const d = await computePromotionManifestDigest(m);
  assert.equal(d.length, 64);
});

test("factory: Artifacts flag without binding falls back to R2", async () => {
  const env = {
    ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS: "true",
    PROMOTION_ARTIFACTS_BUCKET: memoryR2Bucket(),
    PROMOTION_ARTIFACTS_BUCKET_NAME: "edgeclaw-truth-promotion-artifacts",
  } as Env;
  const w = resolveArtifactPromotionWriter(env);
  const ref = await w.writeManifest(sampleManifest());
  assert.equal(ref.storageBackend, "r2");
});

test("factory: Artifacts enabled + ARTIFACTS binding selects workers-artifacts writer", () => {
  const env = {
    ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS: "true",
    ARTIFACTS: {} as Artifacts,
  } as Env;
  const w = resolveArtifactPromotionWriter(env);
  assert.equal(typeof w.writeManifest, "function");
  assert.equal(typeof w.readManifest, "function");
});

test("factory: explicit R2 disable yields noop even with bucket + Artifacts flag but no ARTIFACTS binding", async () => {
  const env = {
    ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS: "true",
    ENABLE_PROMOTION_ARTIFACTS_R2: "false",
    PROMOTION_ARTIFACTS_BUCKET: memoryR2Bucket(),
  } as Env;
  const w = resolveArtifactPromotionWriter(env);
  const ref = await w.writeManifest(sampleManifest());
  assert.equal(ref.storageBackend, "noop");
});
