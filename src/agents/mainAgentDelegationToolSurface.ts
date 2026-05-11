/**
 * `turn.summary.toolSurface` fragment for ToolAgent delegation — extracted for Node-safe regression tests.
 */

export interface DelegationToolSurfaceTurnState {
  delegatedToToolAgent: boolean;
  delegationMeta?: { agent: string; task?: string };
  delegateOk: boolean;
  delegationFailed: boolean;
  resultEmpty: boolean;
  delegationTerminal: boolean;
  orchestrationAfterDelegate: boolean;
  bootstrapFailed: boolean;
  bootstrapError: string;
}

export function buildDelegationToolAgentToolSurfaceFields(
  input: DelegationToolSurfaceTurnState
): Record<string, unknown> {
  if (!input.delegatedToToolAgent) return {};
  return {
    delegatedToToolAgent: true,
    ...(input.delegationMeta ? { toolAgentGateway: input.delegationMeta } : {}),
    ...(input.delegateOk ? { toolAgentResultEmpty: input.resultEmpty } : {}),
    toolAgentTerminal:
      input.delegationTerminal &&
      (input.bootstrapFailed ||
        input.delegationFailed ||
        (input.delegateOk && !input.orchestrationAfterDelegate)),
    ...(input.bootstrapFailed
      ? {
          toolAgentBootstrapFailed: true,
          toolAgentBootstrapError: input.bootstrapError,
        }
      : {}),
  };
}
