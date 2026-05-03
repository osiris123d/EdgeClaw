import type { Env } from "../lib/env";
import { isDebugOrchestrationEnvEnabled } from "./debugOrchestrationWorkerGate";

/**
 * When `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT` is true, MainAgent prepends this to delegated
 * messages and CoderAgent/TesterAgent strip it to omit `shared_workspace_*` tools for one turn.
 * Not a security boundary — internal A/B only.
 */
export const DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX =
  "[EdgeClawDebugChildFlags:noSharedWorkspace]\n";

export function stripDebugChildNoSharedToolsPrefix(
  env: Env,
  message: string
): { message: string; omitSharedWorkspaceTools: boolean } {
  if (!isDebugOrchestrationEnvEnabled(env)) {
    return { message, omitSharedWorkspaceTools: false };
  }
  if (!message.startsWith(DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX)) {
    return { message, omitSharedWorkspaceTools: false };
  }
  return {
    message: message.slice(DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX.length),
    omitSharedWorkspaceTools: true,
  };
}
