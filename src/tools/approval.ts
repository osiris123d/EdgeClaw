/**
 * Centralized tool approval policy.
 *
 * Think delegates approval prompting to the AI SDK's `needsApproval` hook on a
 * tool definition. This module owns the policy decisions so tools remain thin.
 */

export type ToolCategory =
  | "workspace"
  | "notes"
  | "research"
  | "execution"
  | "browser"
  | "system";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolAction =
  | "read"
  | "write"
  | "delete"
  | "search"
  | "summarize"
  | "execute"
  | "navigate";

export interface ToolApprovalPolicy {
  toolName: string;
  category: ToolCategory;
  action: ToolAction;
  requiresApproval: boolean;
  description: string;
  riskLevel: ToolRiskLevel;
}

export const DEFAULT_TOOL_POLICIES: Record<string, ToolApprovalPolicy> = {
  save_project_note: {
    toolName: "save_project_note",
    category: "notes",
    action: "write",
    // SECURITY: Write operations are medium-risk. No approval required because
    // notes are scoped to /project-notes/ and content length is capped at the
    // schema level. Upgrade to requiresApproval: true if your deployment is
    // multi-tenant or if notes may contain sensitive business data.
    requiresApproval: false,
    description: "Create or update a structured project note in workspace storage.",
    riskLevel: "medium",
  },
  list_project_notes: {
    toolName: "list_project_notes",
    category: "notes",
    action: "read",
    requiresApproval: false,
    description: "List structured project notes stored by the agent.",
    riskLevel: "low",
  },
  delete_project_note: {
    toolName: "delete_project_note",
    category: "notes",
    action: "delete",
    // SECURITY: Deletion is irreversible within a session. Always requires
    // a client-side approval prompt before execution.
    requiresApproval: true,
    description: "Delete a stored project note from the workspace.",
    riskLevel: "high",
  },
  search_workspace: {
    toolName: "search_workspace",
    category: "workspace",
    action: "search",
    requiresApproval: false,
    description: "Search workspace files for text matches.",
    riskLevel: "low",
  },
  summarize_workspace_file: {
    toolName: "summarize_workspace_file",
    category: "workspace",
    action: "summarize",
    requiresApproval: false,
    description: "Read a workspace file and return a compact structural summary.",
    riskLevel: "low",
  },
};

export interface ApprovalDecision {
  approved: boolean;
  toolName: string;
  reason: string;
  requiresUserConfirmation: boolean;
  policy?: ToolApprovalPolicy;
}

export class ToolApprovalEvaluator {
  private readonly policies: Map<string, ToolApprovalPolicy>;

  constructor(policies: Record<string, ToolApprovalPolicy> = DEFAULT_TOOL_POLICIES) {
    this.policies = new Map(Object.entries(policies));
  }

  evaluateApproval(toolName: string): ApprovalDecision {
    const policy = this.policies.get(toolName);

    if (!policy) {
      // SECURITY: An unregistered tool has no declared risk level.
      // Log a warning so operators notice when new tools are wired in without
      // an explicit policy — this makes the absence of a policy actionable.
      console.warn(
        `[EdgeClaw][approval] No policy registered for tool '${toolName}'. ` +
          "The tool will be blocked by default. Register an explicit policy in DEFAULT_TOOL_POLICIES."
      );
      return {
        approved: false,
        toolName,
        reason: `No approval policy is registered for tool '${toolName}'.`,
        requiresUserConfirmation: false,
      };
    }

    return {
      approved: true,
      toolName,
      reason: policy.description,
      requiresUserConfirmation: policy.requiresApproval,
      policy,
    };
  }

  getPolicy(toolName: string): ToolApprovalPolicy | undefined {
    return this.policies.get(toolName);
  }

  setPolicy(toolName: string, policy: ToolApprovalPolicy): void {
    this.policies.set(toolName, policy);
  }

  getAllPolicies(): ToolApprovalPolicy[] {
    return Array.from(this.policies.values());
  }

  getApprovalRequiredTools(): ToolApprovalPolicy[] {
    return this.getAllPolicies().filter((policy) => policy.requiresApproval);
  }

  getPoliciesByRiskLevel(riskLevel: ToolRiskLevel): ToolApprovalPolicy[] {
    return this.getAllPolicies().filter((policy) => policy.riskLevel === riskLevel);
  }

  getPoliciesByAction(action: ToolAction): ToolApprovalPolicy[] {
    return this.getAllPolicies().filter((policy) => policy.action === action);
  }

  createNeedsApprovalChecker(toolName: string) {
    return async (_input: unknown, _options: { toolCallId: string }) =>
      this.evaluateApproval(toolName).requiresUserConfirmation;
  }
}

export const defaultApprovalEvaluator = new ToolApprovalEvaluator();
