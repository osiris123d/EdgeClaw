/**
 * Read-only platform diagnostics — no MainAgent.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import {
  buildPromotionPlatformDiagnostics,
  formatPromotionPlatformDiagnosticsReport,
} from "../promotionPlatformDiagnostics";

test("empty env: all noop / no persistence", () => {
  const d = buildPromotionPlatformDiagnostics({} as Env);
  assert.equal(d.artifactPromotionWriter, "noop");
  assert.equal(d.hasPromotionPersistence, false);
  assert.equal(d.flagshipEvaluation, "noop");
  assert.equal(d.previewDeploy.branch, "noop");
  assert.equal(d.productionDeploy.branch, "noop");
  assert.equal(d.workflows.EDGECLAW_PREVIEW_PROMOTION_WORKFLOW, false);
});

test("R2 bucket only: r2 writer + verified preview when flags allow", () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: {} as R2Bucket,
  } as Env;
  const d = buildPromotionPlatformDiagnostics(env);
  assert.equal(d.artifactPromotionWriter, "r2");
  assert.equal(d.hasPromotionPersistence, true);
  assert.equal(d.previewDeploy.branch, "verified");
  assert.equal(d.previewDeploy.workersVersionUploadWrapped, false);
  assert.equal(d.previewDeploy.witnessWrapped, false);
  assert.equal(d.productionDeploy.branch, "verified");
});

test("verified preview + version upload hints: diagnostics reflect workers_version_upload branch", () => {
  const env = {
    PROMOTION_ARTIFACTS_BUCKET: {} as R2Bucket,
    Variables: {
      ENABLE_PREVIEW_WORKER_VERSION_UPLOAD: "true",
      PREVIEW_WORKER_UPLOAD_SCRIPT_NAME: "edgeclaw-preview-stub",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    },
    CLOUDFLARE_API_TOKEN: "secret-token",
  } as Env;
  const d = buildPromotionPlatformDiagnostics(env);
  assert.equal(d.previewDeploy.branch, "verified");
  assert.equal(d.previewDeploy.workersVersionUploadWrapped, true);
  assert.ok(
    formatPromotionPlatformDiagnosticsReport(env).includes("workers_version_upload")
  );
});

test("format report contains branch labels", () => {
  const s = formatPromotionPlatformDiagnosticsReport({} as Env);
  assert.ok(s.includes("artifactPromotionWriter: noop"));
  assert.ok(s.includes("flagshipEvaluation: noop"));
  assert.ok(s.includes("checklist.md"));
});
