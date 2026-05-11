import {
  gatewayObservabilityForToolAgentMessage,
} from "../../lib/agentObservability";
import type { Env } from "../../lib/env";
import { peelToolAgentWorkloadKindLeadLine } from "../../lib/toolAgentWorkloadKind";
import { stripDebugChildNoSharedToolsPrefix } from "../../debug/debugChildDelegationPrefix";

export interface PreparedToolAgentRpcIngress {
  omitSharedWorkspaceTools: boolean;
  inferenceMessageTrimmed: string;
  delegationGatewayObs: ReturnType<typeof gatewayObservabilityForToolAgentMessage>;
}

/**
 * Parses debug prefixes, optional workload-kind lead line, and builds AI Gateway observability payload
 * for {@link ToolAgent} RPC ingress (delegation body after the workload marker is envelope-parseable).
 */
export function prepareToolAgentRpcIngress(
  env: Env,
  rawMessage: string
): PreparedToolAgentRpcIngress {
  const { message: afterDebugStrip, omitSharedWorkspaceTools } =
    stripDebugChildNoSharedToolsPrefix(env, typeof rawMessage === "string" ? rawMessage : "");
  const { strippedMessage, kind } = peelToolAgentWorkloadKindLeadLine(afterDebugStrip.trimStart());
  const inferenceMessageTrimmed = strippedMessage.trim();

  return {
    omitSharedWorkspaceTools,
    inferenceMessageTrimmed,
    delegationGatewayObs: gatewayObservabilityForToolAgentMessage(inferenceMessageTrimmed, kind),
  };
}
