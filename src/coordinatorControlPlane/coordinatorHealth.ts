import type { Env } from "../lib/env";
import { buildPromotionPlatformDiagnostics } from "../promotion/promotionPlatformDiagnostics";
import { isDebugOrchestrationEnvEnabled } from "../debug/debugOrchestrationWorkerGate";
import type { LastCoordinatorChainRecord } from "./types";
import { CONTROL_PLANE_LAST_CHAIN_KEY } from "./types";

/** Called from debug coordinator-chain forwarder after a successful DO response. */
export async function recordLastCoordinatorChainSuccess(
  env: Env,
  session: string,
  httpStatus: number
): Promise<void> {
  const kv = env.COORDINATOR_CONTROL_PLANE_KV;
  if (!kv || httpStatus < 200 || httpStatus >= 300) return;
  try {
    await kv.put(
      CONTROL_PLANE_LAST_CHAIN_KEY,
      JSON.stringify({
        completedAtIso: new Date().toISOString(),
        session,
        httpStatus,
      } satisfies LastCoordinatorChainRecord)
    );
  } catch {
    /* non-fatal */
  }
}

export interface CoordinatorHealthSnapshot {
  environmentName: string;
  subagentCoordinatorBindingPresent: boolean;
  debugOrchestrationEndpointEnabled: boolean;
  /** True when Worker secret / var would require Bearer for debug HTTP (value not echoed). */
  debugOrchestrationTokenConfigured: boolean;
  sharedWorkspaceKvPresent: boolean;
  controlPlaneKvPresent: boolean;
  promotionArtifactWriterBranch: string;
  hasArtifactPromotionPersistence: boolean;
  flagshipEvaluationBranch: string;
  lastCoordinatorChain: LastCoordinatorChainRecord | null;
}

function envName(env: Env): string {
  const v = env.Variables?.ENVIRONMENT ?? env.ENVIRONMENT;
  if (v === "production" || v === "staging" || v === "development") return v;
  return "unspecified";
}

function tokenConfigured(env: Env): boolean {
  const nested = env.Variables?.DEBUG_ORCHESTRATION_TOKEN;
  const top = env.DEBUG_ORCHESTRATION_TOKEN;
  const t = (typeof nested === "string" ? nested : typeof top === "string" ? top : "")?.trim();
  return Boolean(t);
}

/**
 * Read-only snapshot for `/api/coordinator/health` — no secrets in the JSON body.
 */
export async function buildCoordinatorHealthSnapshot(env: Env): Promise<CoordinatorHealthSnapshot> {
  const prom = buildPromotionPlatformDiagnostics(env);
  let lastCoordinatorChain: LastCoordinatorChainRecord | null = null;
  if (env.COORDINATOR_CONTROL_PLANE_KV) {
    try {
      const raw = await env.COORDINATOR_CONTROL_PLANE_KV.get(CONTROL_PLANE_LAST_CHAIN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LastCoordinatorChainRecord;
        if (
          typeof parsed.completedAtIso === "string" &&
          typeof parsed.session === "string" &&
          typeof parsed.httpStatus === "number"
        ) {
          lastCoordinatorChain = parsed;
        }
      }
    } catch {
      /* ignore malformed KV */
    }
  }
  return {
    environmentName: envName(env),
    subagentCoordinatorBindingPresent: Boolean(env.SUBAGENT_COORDINATOR),
    debugOrchestrationEndpointEnabled: isDebugOrchestrationEnvEnabled(env),
    debugOrchestrationTokenConfigured: tokenConfigured(env),
    sharedWorkspaceKvPresent: Boolean(env.SHARED_WORKSPACE_KV),
    controlPlaneKvPresent: Boolean(env.COORDINATOR_CONTROL_PLANE_KV),
    promotionArtifactWriterBranch: String(prom.artifactPromotionWriter),
    hasArtifactPromotionPersistence: prom.hasPromotionPersistence,
    flagshipEvaluationBranch: String(prom.flagshipEvaluation),
    lastCoordinatorChain,
  };
}
