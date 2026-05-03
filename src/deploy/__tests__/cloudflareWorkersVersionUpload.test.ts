/**
 * Workers Versions multipart upload helper — mocked fetch only.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { uploadWorkersPromotionPreviewVersion } from "../cloudflareWorkersVersionUpload";

test("uploadWorkersPromotionPreviewVersion success parses version id and hasPreview", async () => {
  const captured: { url?: string; method?: string } = {};
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.method = init?.method ?? "GET";
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          id: "ver-abc",
          metadata: { hasPreview: true },
          urls: [{ url: "https://stub.preview.workers.dev/x" }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const out = await uploadWorkersPromotionPreviewVersion({
    accountId: "acct1",
    apiToken: "tok",
    uploadScriptName: "edgeclaw-preview-stub",
    manifestDigest: "sha256:aa",
    bundleId: "b1",
    compatibilityDate: "2025-01-14",
    fetchFn,
  });

  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.data.versionId, "ver-abc");
    assert.equal(out.data.hasPreview, true);
    assert.equal(out.data.previewUrl, "https://stub.preview.workers.dev/x");
  }
  assert.ok(captured.url?.includes("/accounts/acct1/workers/scripts/edgeclaw-preview-stub/versions"));
  assert.equal(captured.method, "POST");
});

test("uploadWorkersPromotionPreviewVersion API error returns ok false", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

  const out = await uploadWorkersPromotionPreviewVersion({
    accountId: "a",
    apiToken: "t",
    uploadScriptName: "s",
    manifestDigest: "d",
    bundleId: "b",
    compatibilityDate: "2025-01-14",
    fetchFn,
  });

  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error, "nope");
    assert.equal(out.httpStatus, 400);
  }
});

test("uploadWorkersPromotionPreviewVersion missing result.id is failure", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const out = await uploadWorkersPromotionPreviewVersion({
    accountId: "a",
    apiToken: "t",
    uploadScriptName: "s",
    manifestDigest: "d",
    bundleId: "b",
    compatibilityDate: "2025-01-14",
    fetchFn,
  });

  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.ok(out.error.includes("result.id"));
  }
});
