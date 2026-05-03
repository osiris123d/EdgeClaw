import type { Env } from "../lib/env";
import {
  hasArtifactPromotionPersistence,
  resolveArtifactPromotionWriter,
} from "../promotion/artifactPromotionWriterFactory";
import { createWorkersVersionUploadPreviewDeployAdapter } from "./previewDeployCloudflareVersionUpload";
import { createCloudflareScriptSettingsWitnessPreviewDeployAdapter } from "./previewDeployCloudflareWitness";
import { createNoopPreviewDeployAdapter } from "./previewDeployNoop";
import { createPromotionArtifactVerifiedPreviewDeployAdapter } from "./previewDeployPromotionVerified";
import type { PreviewDeployAdapter } from "./previewDeployTypes";

function isPreviewDeployVerifiedExplicitlyDisabled(env: Env): boolean {
  // COMPATIBILITY: legacy name ENABLE_PREVIEW_DEPLOY_R2 disables all verified preview (not R2-only).
  // TODO(deprecation): document-only rename candidate ENABLE_PREVIEW_DEPLOY_VERIFIED — do not remove until planned breaking env migration.
  const v = env.Variables?.ENABLE_PREVIEW_DEPLOY_R2 ?? env.ENABLE_PREVIEW_DEPLOY_R2;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "false" || n === "0" || n === "off";
}

function isPreviewDeployCfWitnessEnabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_PREVIEW_DEPLOY_CF_WITNESS ?? env.ENABLE_PREVIEW_DEPLOY_CF_WITNESS;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

function getPreviewDeployPublicUrl(env: Env): string | undefined {
  const u = env.Variables?.PREVIEW_DEPLOY_PUBLIC_URL ?? env.PREVIEW_DEPLOY_PUBLIC_URL;
  if (typeof u === "string" && u.trim()) {
    return u.trim();
  }
  return undefined;
}

function getPreviewWorkerScriptName(env: Env): string {
  const n = env.Variables?.PREVIEW_WORKER_SCRIPT_NAME ?? env.PREVIEW_WORKER_SCRIPT_NAME;
  if (typeof n === "string" && n.trim()) {
    return n.trim();
  }
  return "edgeclaw-truth-agent";
}

function getCloudflareAccountId(env: Env): string | undefined {
  const id = env.Variables?.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function isPreviewWorkerVersionUploadEnabled(env: Env): boolean {
  const v =
    env.Variables?.ENABLE_PREVIEW_WORKER_VERSION_UPLOAD ?? env.ENABLE_PREVIEW_WORKER_VERSION_UPLOAD;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

function getPreviewWorkerUploadScriptName(env: Env): string | undefined {
  const n =
    env.Variables?.PREVIEW_WORKER_UPLOAD_SCRIPT_NAME ?? env.PREVIEW_WORKER_UPLOAD_SCRIPT_NAME;
  return typeof n === "string" && n.trim() ? n.trim() : undefined;
}

/** Defaults to wrangler `compatibility_date` when unset — align stub uploads with account capabilities. */
function getPreviewWorkerUploadCompatibilityDate(env: Env): string {
  const d =
    env.Variables?.PREVIEW_WORKER_UPLOAD_COMPATIBILITY_DATE ??
    env.PREVIEW_WORKER_UPLOAD_COMPATIBILITY_DATE;
  return typeof d === "string" && d.trim() ? d.trim() : "2025-01-14";
}

/** Reason preview deploy resolves to noop (`noop` branch). */
export type PreviewDeployNoopReason = "kill_switch" | "no_promotion_persistence";

/** Mirrors {@link resolvePreviewDeployAdapter} — safe introspection only (no network). */
export type PreviewDeployResolution =
  | { branch: "noop"; noopReason: PreviewDeployNoopReason; witnessWouldApply: false }
  | {
      branch: "verified";
      /** Multipart Workers Versions upload to `PREVIEW_WORKER_UPLOAD_SCRIPT_NAME` when enabled + credentials + script name. */
      workersVersionUploadWrapped: boolean;
      witnessWrapped: boolean;
    };

export function describePreviewDeployResolution(env: Env): PreviewDeployResolution {
  if (isPreviewDeployVerifiedExplicitlyDisabled(env)) {
    return { branch: "noop", noopReason: "kill_switch", witnessWouldApply: false };
  }
  if (!hasArtifactPromotionPersistence(env)) {
    return { branch: "noop", noopReason: "no_promotion_persistence", witnessWouldApply: false };
  }
  const witnessEnabled = isPreviewDeployCfWitnessEnabled(env);
  const accountId = getCloudflareAccountId(env);
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const tokenOk = Boolean(accountId && typeof apiToken === "string" && apiToken.trim());
  const witnessWrapped = witnessEnabled && tokenOk;
  const uploadScript = getPreviewWorkerUploadScriptName(env);
  const workersVersionUploadWrapped =
    isPreviewWorkerVersionUploadEnabled(env) && tokenOk && Boolean(uploadScript);
  return { branch: "verified", witnessWrapped, workersVersionUploadWrapped };
}

/**
 * Orchestrator-only wiring — **never** imports production deploy.
 *
 * - Verified preview when durable promotion storage exists (`hasArtifactPromotionPersistence`) and verified preview is not disabled (`ENABLE_PREVIEW_DEPLOY_R2` legacy kill switch).
 * - Uses {@link resolveArtifactPromotionWriter} so **R2** or **Artifacts** manifests re-read through the same writer as promotion.
 * - Optional **Workers Versions** multipart upload to a **separate DO-free preview Worker** (`ENABLE_PREVIEW_WORKER_VERSION_UPLOAD` + `PREVIEW_WORKER_UPLOAD_SCRIPT_NAME` + account id + API token) — runs **after** verification, **before** optional witness.
 * - Optional Cloudflare **script-settings** witness (`ENABLE_PREVIEW_DEPLOY_CF_WITNESS` + account id + API token).
 *
 * @see `docs/coding-platform-architecture.md`
 */
export function resolvePreviewDeployAdapter(env: Env): PreviewDeployAdapter {
  if (isPreviewDeployVerifiedExplicitlyDisabled(env)) {
    return createNoopPreviewDeployAdapter();
  }
  if (!hasArtifactPromotionPersistence(env)) {
    return createNoopPreviewDeployAdapter();
  }

  const writer = resolveArtifactPromotionWriter(env);

  let adapter = createPromotionArtifactVerifiedPreviewDeployAdapter(writer, {
    canonicalPreviewUrl: getPreviewDeployPublicUrl(env),
    workerScriptName: getPreviewWorkerScriptName(env),
    accountId: getCloudflareAccountId(env),
    apiToken: typeof env.CLOUDFLARE_API_TOKEN === "string" ? env.CLOUDFLARE_API_TOKEN : undefined,
  });

  if (isPreviewWorkerVersionUploadEnabled(env)) {
    const uploadName = getPreviewWorkerUploadScriptName(env);
    const accountId = getCloudflareAccountId(env);
    const token = env.CLOUDFLARE_API_TOKEN;
    if (accountId && typeof token === "string" && token.trim() && uploadName) {
      adapter = createWorkersVersionUploadPreviewDeployAdapter(adapter, {
        accountId,
        apiToken: token.trim(),
        uploadScriptName: uploadName,
        compatibilityDate: getPreviewWorkerUploadCompatibilityDate(env),
      });
    }
  }

  if (isPreviewDeployCfWitnessEnabled(env)) {
    const accountId = getCloudflareAccountId(env);
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    if (accountId && typeof apiToken === "string" && apiToken.trim()) {
      adapter = createCloudflareScriptSettingsWitnessPreviewDeployAdapter(adapter, {
        accountId,
        apiToken: apiToken.trim(),
        workerScriptName: getPreviewWorkerScriptName(env),
      });
    }
  }

  return adapter;
}
