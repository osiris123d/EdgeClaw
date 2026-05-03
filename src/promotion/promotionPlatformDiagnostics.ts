/**
 * Read-only promotion platform diagnostics — **no network I/O**, orchestrator-safe.
 * Mirrors factory branch logic via exported `describe*` helpers.
 *
 * Call from tests, internal diagnostics routes, or temporarily from MainAgent during debugging.
 */

import type { Env, Variables } from "../lib/env";
import {
  describeArtifactPromotionWriterBranch,
  hasArtifactPromotionPersistence,
  type ArtifactPromotionWriterBranch,
} from "./artifactPromotionWriterFactory";
import { describeFlagshipEvaluationBranch, type FlagshipEvaluationBranch } from "./flagshipEvaluationAdapterFactory";
import {
  describePreviewDeployResolution,
  type PreviewDeployResolution,
} from "../deploy/previewDeployAdapterFactory";
import {
  describeProductionDeployResolution,
  type ProductionDeployResolution,
} from "../deploy/productionDeployAdapterFactory";

export interface WorkflowBindingPresence {
  EDGECLAW_RESEARCH_WORKFLOW: boolean;
  EDGECLAW_PAGE_INTEL_WORKFLOW: boolean;
  EDGECLAW_PREVIEW_PROMOTION_WORKFLOW: boolean;
  EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW: boolean;
}

export interface PromotionArtifactBindingPresence {
  ARTIFACTS: boolean;
  PROMOTION_ARTIFACTS_BUCKET: boolean;
  FLAGS_flagship: boolean;
}

/** Flags relevant to witness URLs — presence only; secrets not echoed. */
export interface PromotionPlatformEnvHints {
  ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS: boolean;
  ENABLE_PROMOTION_ARTIFACTS_R2_disabled: boolean;
  ENABLE_PREVIEW_DEPLOY_R2_kill_switch: boolean;
  ENABLE_PREVIEW_DEPLOY_CF_WITNESS: boolean;
  ENABLE_PREVIEW_WORKER_VERSION_UPLOAD: boolean;
  has_PREVIEW_WORKER_UPLOAD_SCRIPT_NAME: boolean;
  ENABLE_PRODUCTION_DEPLOY_kill_switch: boolean;
  ENABLE_PRODUCTION_DEPLOY_CF_WITNESS: boolean;
  ENABLE_FLAGSHIP_BINDING: boolean;
  ENABLE_FLAGSHIP_HTTP_disabled: boolean;
  has_CLOUDFLARE_ACCOUNT_ID: boolean;
  has_CLOUDFLARE_API_TOKEN: boolean;
  has_FLAGSHIP_EVALUATION_URL: boolean;
}

export interface PromotionPlatformDiagnostics {
  artifactPromotionWriter: ArtifactPromotionWriterBranch;
  flagshipEvaluation: FlagshipEvaluationBranch;
  previewDeploy: PreviewDeployResolution;
  productionDeploy: ProductionDeployResolution;
  hasPromotionPersistence: boolean;
  bindings: PromotionArtifactBindingPresence;
  workflows: WorkflowBindingPresence;
  envHints: PromotionPlatformEnvHints;
}

function parseTriStateFlag(v: string | undefined, truthy: boolean): boolean {
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  if (truthy) {
    return n === "true" || n === "1" || n === "on";
  }
  return n === "false" || n === "0" || n === "off";
}

function getVar(env: Env, key: keyof Variables): string | undefined {
  const nested = env.Variables?.[key];
  if (typeof nested === "string") {
    return nested;
  }
  const top = env[key as keyof Env];
  return typeof top === "string" ? top : undefined;
}

function buildEnvHints(env: Env): PromotionPlatformEnvHints {
  const enableArtifacts = parseTriStateFlag(
    getVar(env, "ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS"),
    true
  );
  const r2Disabled = parseTriStateFlag(getVar(env, "ENABLE_PROMOTION_ARTIFACTS_R2"), false);
  const previewKill = parseTriStateFlag(getVar(env, "ENABLE_PREVIEW_DEPLOY_R2"), false);
  const previewWitness = parseTriStateFlag(getVar(env, "ENABLE_PREVIEW_DEPLOY_CF_WITNESS"), true);
  const previewVersionUpload = parseTriStateFlag(getVar(env, "ENABLE_PREVIEW_WORKER_VERSION_UPLOAD"), true);
  const uploadScriptName =
    typeof getVar(env, "PREVIEW_WORKER_UPLOAD_SCRIPT_NAME") === "string" &&
    Boolean(getVar(env, "PREVIEW_WORKER_UPLOAD_SCRIPT_NAME")?.trim());
  const prodKill = parseTriStateFlag(getVar(env, "ENABLE_PRODUCTION_DEPLOY"), false);
  const prodWitness = parseTriStateFlag(getVar(env, "ENABLE_PRODUCTION_DEPLOY_CF_WITNESS"), true);
  const flagshipBind = parseTriStateFlag(getVar(env, "ENABLE_FLAGSHIP_BINDING"), true);
  const flagshipHttpOff = parseTriStateFlag(getVar(env, "ENABLE_FLAGSHIP_HTTP"), false);

  const account =
    typeof getVar(env, "CLOUDFLARE_ACCOUNT_ID") === "string" &&
    Boolean(getVar(env, "CLOUDFLARE_ACCOUNT_ID")?.trim());
  const token =
    typeof env.CLOUDFLARE_API_TOKEN === "string" && Boolean(env.CLOUDFLARE_API_TOKEN.trim());
  const flagshipUrl =
    typeof getVar(env, "FLAGSHIP_EVALUATION_URL") === "string" &&
    Boolean(getVar(env, "FLAGSHIP_EVALUATION_URL")?.trim());

  return {
    ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS: enableArtifacts,
    ENABLE_PROMOTION_ARTIFACTS_R2_disabled: r2Disabled,
    ENABLE_PREVIEW_DEPLOY_R2_kill_switch: previewKill,
    ENABLE_PREVIEW_DEPLOY_CF_WITNESS: previewWitness,
    ENABLE_PREVIEW_WORKER_VERSION_UPLOAD: previewVersionUpload,
    has_PREVIEW_WORKER_UPLOAD_SCRIPT_NAME: uploadScriptName,
    ENABLE_PRODUCTION_DEPLOY_kill_switch: prodKill,
    ENABLE_PRODUCTION_DEPLOY_CF_WITNESS: prodWitness,
    ENABLE_FLAGSHIP_BINDING: flagshipBind,
    ENABLE_FLAGSHIP_HTTP_disabled: flagshipHttpOff,
    has_CLOUDFLARE_ACCOUNT_ID: account,
    has_CLOUDFLARE_API_TOKEN: token,
    has_FLAGSHIP_EVALUATION_URL: flagshipUrl,
  };
}

function workflowPresence(env: Env): WorkflowBindingPresence {
  return {
    EDGECLAW_RESEARCH_WORKFLOW: Boolean(env.EDGECLAW_RESEARCH_WORKFLOW),
    EDGECLAW_PAGE_INTEL_WORKFLOW: Boolean(env.EDGECLAW_PAGE_INTEL_WORKFLOW),
    EDGECLAW_PREVIEW_PROMOTION_WORKFLOW: Boolean(env.EDGECLAW_PREVIEW_PROMOTION_WORKFLOW),
    EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW: Boolean(env.EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW),
  };
}

function artifactBindings(env: Env): PromotionArtifactBindingPresence {
  return {
    ARTIFACTS: Boolean(env.ARTIFACTS),
    PROMOTION_ARTIFACTS_BUCKET: Boolean(env.PROMOTION_ARTIFACTS_BUCKET),
    FLAGS_flagship: Boolean(env.FLAGS),
  };
}

/**
 * Snapshot of adapter branches and bindings — safe to log (no secrets).
 */
export function buildPromotionPlatformDiagnostics(env: Env): PromotionPlatformDiagnostics {
  return {
    artifactPromotionWriter: describeArtifactPromotionWriterBranch(env),
    flagshipEvaluation: describeFlagshipEvaluationBranch(env),
    previewDeploy: describePreviewDeployResolution(env),
    productionDeploy: describeProductionDeployResolution(env),
    hasPromotionPersistence: hasArtifactPromotionPersistence(env),
    bindings: artifactBindings(env),
    workflows: workflowPresence(env),
    envHints: buildEnvHints(env),
  };
}

function fmtPreviewDeploy(r: PreviewDeployResolution): string {
  if (r.branch === "noop") {
    return `noop (${r.noopReason})`;
  }
  const parts: string[] = ["verified"];
  if (r.workersVersionUploadWrapped) {
    parts.push("workers_version_upload");
  }
  if (r.witnessWrapped) {
    parts.push("cf_script_settings witness");
  }
  return parts.join(" + ");
}

function fmtProductionDeploy(r: ProductionDeployResolution): string {
  if (r.branch === "noop") {
    return `noop (${r.noopReason})`;
  }
  return `verified${r.witnessWrapped ? " + cf_script_settings witness" : ""}`;
}

/**
 * Human-readable report for operators / support — **no secret values**.
 */
export function formatPromotionPlatformDiagnosticsReport(env: Env): string {
  const d = buildPromotionPlatformDiagnostics(env);
  const lines: string[] = [
    "=== EdgeClaw promotion platform diagnostics (read-only) ===",
    `artifactPromotionWriter: ${d.artifactPromotionWriter}`,
    `hasArtifactPromotionPersistence: ${d.hasPromotionPersistence}`,
    `flagshipEvaluation: ${d.flagshipEvaluation}`,
    `previewDeploy: ${fmtPreviewDeploy(d.previewDeploy)}`,
    `productionDeploy: ${fmtProductionDeploy(d.productionDeploy)}`,
    "",
    "bindings:",
    `  ARTIFACTS: ${d.bindings.ARTIFACTS}`,
    `  PROMOTION_ARTIFACTS_BUCKET: ${d.bindings.PROMOTION_ARTIFACTS_BUCKET}`,
    `  FLAGS (Flagship): ${d.bindings.FLAGS_flagship}`,
    "",
    "workflows:",
    `  EDGECLAW_PREVIEW_PROMOTION_WORKFLOW: ${d.workflows.EDGECLAW_PREVIEW_PROMOTION_WORKFLOW}`,
    `  EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW: ${d.workflows.EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW}`,
    `  EDGECLAW_RESEARCH_WORKFLOW: ${d.workflows.EDGECLAW_RESEARCH_WORKFLOW}`,
    `  EDGECLAW_PAGE_INTEL_WORKFLOW: ${d.workflows.EDGECLAW_PAGE_INTEL_WORKFLOW}`,
    "",
    "env hints (flags parsed as enabled/disabled — booleans only):",
    `  ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS (truthy): ${d.envHints.ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS}`,
    `  ENABLE_PROMOTION_ARTIFACTS_R2 disabled: ${d.envHints.ENABLE_PROMOTION_ARTIFACTS_R2_disabled}`,
    `  ENABLE_PREVIEW_DEPLOY_R2 explicit false (verified preview disabled): ${d.envHints.ENABLE_PREVIEW_DEPLOY_R2_kill_switch}`,
    `  ENABLE_PREVIEW_DEPLOY_CF_WITNESS (truthy): ${d.envHints.ENABLE_PREVIEW_DEPLOY_CF_WITNESS}`,
    `  ENABLE_PREVIEW_WORKER_VERSION_UPLOAD (truthy): ${d.envHints.ENABLE_PREVIEW_WORKER_VERSION_UPLOAD}`,
    `  PREVIEW_WORKER_UPLOAD_SCRIPT_NAME present: ${d.envHints.has_PREVIEW_WORKER_UPLOAD_SCRIPT_NAME}`,
    `  ENABLE_PRODUCTION_DEPLOY explicit false (verified production disabled): ${d.envHints.ENABLE_PRODUCTION_DEPLOY_kill_switch}`,
    `  ENABLE_PRODUCTION_DEPLOY_CF_WITNESS (truthy): ${d.envHints.ENABLE_PRODUCTION_DEPLOY_CF_WITNESS}`,
    `  ENABLE_FLAGSHIP_BINDING (truthy): ${d.envHints.ENABLE_FLAGSHIP_BINDING}`,
    `  ENABLE_FLAGSHIP_HTTP disabled: ${d.envHints.ENABLE_FLAGSHIP_HTTP_disabled}`,
    `  CLOUDFLARE_ACCOUNT_ID present: ${d.envHints.has_CLOUDFLARE_ACCOUNT_ID}`,
    `  CLOUDFLARE_API_TOKEN present: ${d.envHints.has_CLOUDFLARE_API_TOKEN}`,
    `  FLAGSHIP_EVALUATION_URL present: ${d.envHints.has_FLAGSHIP_EVALUATION_URL}`,
    "",
    "See docs/operator-live-readiness-checklist.md for cutover prerequisites.",
  ];
  return lines.join("\n");
}
