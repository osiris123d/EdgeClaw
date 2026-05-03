import type { Env } from "../lib/env";
import {
  hasArtifactPromotionPersistence,
  resolveArtifactPromotionWriter,
} from "../promotion/artifactPromotionWriterFactory";
import { createCloudflareScriptSettingsWitnessProductionDeployAdapter } from "./productionDeployCloudflareWitness";
import { createNoopProductionDeployAdapter } from "./productionDeployNoop";
import { createPromotionArtifactVerifiedProductionDeployAdapter } from "./productionDeployPromotionVerified";
import type { ProductionDeployAdapter } from "./productionDeployTypes";

function isProductionDeployExplicitlyDisabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_PRODUCTION_DEPLOY ?? env.ENABLE_PRODUCTION_DEPLOY;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "false" || n === "0" || n === "off";
}

function isProductionDeployCfWitnessEnabled(env: Env): boolean {
  const v = env.Variables?.ENABLE_PRODUCTION_DEPLOY_CF_WITNESS ?? env.ENABLE_PRODUCTION_DEPLOY_CF_WITNESS;
  if (v === undefined || typeof v !== "string") {
    return false;
  }
  const n = v.trim().toLowerCase();
  return n === "true" || n === "1" || n === "on";
}

function getProductionDeployPublicUrl(env: Env): string | undefined {
  const u = env.Variables?.PRODUCTION_DEPLOY_PUBLIC_URL ?? env.PRODUCTION_DEPLOY_PUBLIC_URL;
  if (typeof u === "string" && u.trim()) {
    return u.trim();
  }
  return undefined;
}

function getProductionWorkerScriptName(env: Env): string {
  const n = env.Variables?.PRODUCTION_WORKER_SCRIPT_NAME ?? env.PRODUCTION_WORKER_SCRIPT_NAME;
  if (typeof n === "string" && n.trim()) {
    return n.trim();
  }
  return "edgeclaw-truth-agent";
}

function getCloudflareAccountId(env: Env): string | undefined {
  const id = env.Variables?.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export type ProductionDeployNoopReason = "kill_switch" | "no_promotion_persistence";

export type ProductionDeployResolution =
  | { branch: "noop"; noopReason: ProductionDeployNoopReason; witnessWouldApply: false }
  | { branch: "verified"; witnessWrapped: boolean };

export function describeProductionDeployResolution(env: Env): ProductionDeployResolution {
  if (isProductionDeployExplicitlyDisabled(env)) {
    return { branch: "noop", noopReason: "kill_switch", witnessWouldApply: false };
  }
  if (!hasArtifactPromotionPersistence(env)) {
    return { branch: "noop", noopReason: "no_promotion_persistence", witnessWouldApply: false };
  }
  const witnessEnabled = isProductionDeployCfWitnessEnabled(env);
  const accountId = getCloudflareAccountId(env);
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const witnessWrapped =
    witnessEnabled &&
    Boolean(accountId && typeof apiToken === "string" && apiToken.trim());
  return { branch: "verified", witnessWrapped };
}

/**
 * Orchestrator-only wiring — **never** delegates to preview adapters (`resolvePreviewDeployAdapter`).
 *
 * - **`ENABLE_PRODUCTION_DEPLOY=false`** → noop (kill switch).
 * - No durable promotion storage → noop.
 * - Else **`createPromotionArtifactVerifiedProductionDeployAdapter`** via {@link resolveArtifactPromotionWriter}.
 * - Optional **`ENABLE_PRODUCTION_DEPLOY_CF_WITNESS`** + account id + API token → script-settings witness after inner success.
 *
 * @see `docs/coding-platform-architecture.md`
 */
export function resolveProductionDeployAdapter(env: Env): ProductionDeployAdapter {
  if (isProductionDeployExplicitlyDisabled(env)) {
    return createNoopProductionDeployAdapter();
  }
  if (!hasArtifactPromotionPersistence(env)) {
    return createNoopProductionDeployAdapter();
  }

  const writer = resolveArtifactPromotionWriter(env);

  let adapter = createPromotionArtifactVerifiedProductionDeployAdapter(writer, {
    canonicalProductionUrl: getProductionDeployPublicUrl(env),
    workerScriptName: getProductionWorkerScriptName(env),
    accountId: getCloudflareAccountId(env),
    apiToken: typeof env.CLOUDFLARE_API_TOKEN === "string" ? env.CLOUDFLARE_API_TOKEN : undefined,
  });

  if (isProductionDeployCfWitnessEnabled(env)) {
    const accountId = getCloudflareAccountId(env);
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    if (accountId && typeof apiToken === "string" && apiToken.trim()) {
      adapter = createCloudflareScriptSettingsWitnessProductionDeployAdapter(adapter, {
        accountId,
        apiToken: apiToken.trim(),
        workerScriptName: getProductionWorkerScriptName(env),
      });
    }
  }

  return adapter;
}
