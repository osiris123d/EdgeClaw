import type { Env } from "../lib/env";
import type { ArtifactPromotionWriter } from "./artifactPromotionTypes";
import { createArtifactsArtifactPromotionWriter } from "./artifactPromotionArtifacts";
import { createNoopArtifactPromotionWriter } from "./artifactPromotionNoop";
import { createR2ArtifactPromotionWriter } from "./artifactPromotionR2";

function isPromotionR2ExplicitlyDisabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_PROMOTION_ARTIFACTS_R2 ?? env.ENABLE_PROMOTION_ARTIFACTS_R2;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "false" || n === "0" || n === "off";
}

function isPromotionArtifactsExplicitlyEnabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS ?? env.ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

function getBucketDisplayName(env: Env): string {
  const name = env.Variables?.PROMOTION_ARTIFACTS_BUCKET_NAME ?? env.PROMOTION_ARTIFACTS_BUCKET_NAME;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return "edgeclaw-truth-promotion-artifacts";
}

function getPromotionArtifactsRepoName(env: Env): string {
  const name = env.Variables?.PROMOTION_ARTIFACTS_REPO_NAME ?? env.PROMOTION_ARTIFACTS_REPO_NAME;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return "edgeclaw-promotion-manifests";
}

/**
 * True when manifests can be stored outside the noop writer (R2 bucket and/or Artifacts binding).
 */
export function hasArtifactPromotionPersistence(env: Env): boolean {
  if (isPromotionArtifactsExplicitlyEnabled(env) && env.ARTIFACTS) {
    return true;
  }
  if (isPromotionR2ExplicitlyDisabled(env)) {
    return false;
  }
  return Boolean(env.PROMOTION_ARTIFACTS_BUCKET);
}

/** Branch chosen by {@link resolveArtifactPromotionWriter} — safe introspection only (no I/O). */
export type ArtifactPromotionWriterBranch = "artifacts" | "r2" | "noop";

/**
 * Describes which {@link resolveArtifactPromotionWriter} branch would run — mirrors factory logic.
 */
export function describeArtifactPromotionWriterBranch(env: Env): ArtifactPromotionWriterBranch {
  if (isPromotionArtifactsExplicitlyEnabled(env) && env.ARTIFACTS) {
    return "artifacts";
  }
  if (isPromotionR2ExplicitlyDisabled(env)) {
    return "noop";
  }
  if (!env.PROMOTION_ARTIFACTS_BUCKET) {
    return "noop";
  }
  return "r2";
}

/**
 * Orchestrator-only wiring — **Artifacts are explicit opt-in**, not auto-preferred when R2 also exists:
 * 1. Cloudflare Artifacts (git remote + isomorphic-git) when opt-in flag is true **and** `ARTIFACTS` is bound.
 * 2. Else R2 when `PROMOTION_ARTIFACTS_BUCKET` is bound and R2 is not explicitly disabled.
 * 3. Else noop.
 *
 * Path labels: **Canonical** — Artifacts branch when enabled + bound. **Compatibility** — R2 writer for bucket-backed manifests.
 * **Fallback** — noop when neither applies or R2 disabled without Artifacts.
 *
 * @see `docs/coding-platform-architecture.md` (R2 → Artifacts migration).
 */
export function resolveArtifactPromotionWriter(env: Env): ArtifactPromotionWriter {
  const branch = describeArtifactPromotionWriterBranch(env);
  if (branch === "artifacts") {
    return createArtifactsArtifactPromotionWriter(env.ARTIFACTS!, {
      repoName: getPromotionArtifactsRepoName(env),
    });
  }
  if (branch === "noop") {
    return createNoopArtifactPromotionWriter();
  }
  return createR2ArtifactPromotionWriter(env.PROMOTION_ARTIFACTS_BUCKET!, {
    bucketDisplayName: getBucketDisplayName(env),
  });
}
