import type { CodingCollaborationLoopInput } from "./codingLoopTypes";

/**
 * Coordinator-hosted coding loop must honor MainAgent's explicit `statelessSubAgentModelTurn`.
 * Only `true` uses stateless `rpcCollectStatelessModelTurn`; omitted or `false` uses stateful `rpcCollectChatTurn`
 * (same contract as in-process delegation).
 */
export function coordinatorLoopEffectiveStatelessSubAgentModelTurn(
  input: CodingCollaborationLoopInput
): boolean {
  return input.statelessSubAgentModelTurn === true;
}
