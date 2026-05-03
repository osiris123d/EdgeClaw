import { SharedWorkspaceGateway } from "./sharedWorkspaceTypes";
import { createSharedWorkspaceKvStorage } from "./sharedWorkspaceKvStorage";

/**
 * Minimal env slice — avoids coupling to full `Env` / Cloudflare-generated typings on DO subclasses.
 * Same Worker binding is visible from MainAgent, CoderAgent, TesterAgent, etc.
 */
export type SharedWorkspaceEnv = {
  SHARED_WORKSPACE_KV?: KVNamespace;
};

export function hasSharedWorkspaceKv(
  env: SharedWorkspaceEnv
): env is SharedWorkspaceEnv & { SHARED_WORKSPACE_KV: KVNamespace } {
  return env.SHARED_WORKSPACE_KV != null;
}

/** Gateway bound to Worker env (same binding visible from parent + sub-agent DOs). */
export function getSharedWorkspaceGateway(env: SharedWorkspaceEnv): SharedWorkspaceGateway | null {
  if (!hasSharedWorkspaceKv(env)) {
    return null;
  }
  return new SharedWorkspaceGateway(createSharedWorkspaceKvStorage(env.SHARED_WORKSPACE_KV));
}
