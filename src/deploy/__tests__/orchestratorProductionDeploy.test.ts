/**
 * Production deploy orchestration tests — no MainAgent import.
 * Run: `npm run test:preview-deploy-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionArtifactManifest } from "../../promotion/artifactPromotionTypes";
import type { ReleaseGateDecision } from "../../promotion/flagshipTypes";
import { computePromotionManifestDigest } from "../../promotion/promotionManifestCanonical";
import { createNoopProductionDeployAdapter } from "../productionDeployNoop";
import type { ProductionDeployAdapter, ProductionDeployRequest } from "../productionDeployTypes";
import { runProductionDeployment } from "../orchestratorProductionDeploy";

async function baseManifest(): Promise<{ manifest: PromotionArtifactManifest; digest: string }> {
  const manifest: PromotionArtifactManifest = {
    schemaVersion: "edgeclaw-promotion-v1",
    bundleId: "b-prod",
    projectId: "proj-prod",
    createdAt: "2026-09-01T12:00:00.000Z",
    patchIds: ["p1"],
  };
  const digest = await computePromotionManifestDigest(manifest);
  return { manifest, digest };
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

test("release gate deny -> blocked", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: {
      outcome: "deny",
      allowed: false,
      tier: "production",
      reasons: [{ code: "DENY", message: "no" }],
    },
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "RELEASE_GATE_NOT_ALLOW");
});

test("manifest digest mismatch at orchestrator -> blocked", async () => {
  const { manifest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: "00".repeat(32) },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "MANIFEST_DIGEST_MISMATCH");
});

test("noop adapter succeeds with production gate + two approvers", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
    changeTicketId: "CHG-1",
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "succeeded");
  assert.ok(res.productionDeploymentUrl?.startsWith("noop://production/"));
  assert.equal(res.audit.adapterBackend, "noop_production");
});

test("blocked when tier is preview", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const decision: ReleaseGateDecision = {
    outcome: "allow",
    allowed: true,
    tier: "preview",
    reasons: [{ code: "X", message: "wrong tier" }],
  };
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: decision,
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.blockReasons?.[0]?.code, "RELEASE_GATE_TIER_NOT_PRODUCTION");
});

test("blocked when fewer than two distinct approvers", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: [{ approverId: "only-one", approvedAt: "2026-09-01T13:00:00.000Z" }],
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "blocked");
  assert.equal(res.failureCategory, "approval_policy_failed");
  assert.equal(res.blockReasons?.[0]?.code, "INSUFFICIENT_PRODUCTION_APPROVALS");
});

test("duplicate approver ids still counts as one", async () => {
  const { manifest, digest } = await baseManifest();
  const adapter = createNoopProductionDeployAdapter();
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: [
      { approverId: "alice", approvedAt: "2026-09-01T13:00:00.000Z" },
      { approverId: "alice", approvedAt: "2026-09-01T13:01:00.000Z" },
    ],
  };
  const res = await runProductionDeployment(adapter, req);
  assert.equal(res.status, "blocked");
});

test("adapter throw -> failed", async () => {
  const { manifest, digest } = await baseManifest();
  const boom: ProductionDeployAdapter = {
    async deploy() {
      throw new Error("prod backend exploded");
    },
  };
  const req: ProductionDeployRequest = {
    projectId: manifest.projectId,
    bundleRef: { bundleId: manifest.bundleId, manifestDigest: digest },
    manifest,
    releaseGateDecision: gateProductionAllow(),
    requestedTier: "production",
    artifactWritten: true,
    productionApprovals: validApprovals(),
  };
  const res = await runProductionDeployment(boom, req);
  assert.equal(res.status, "failed");
  assert.equal(res.failureCategory, "adapter_error");
});
