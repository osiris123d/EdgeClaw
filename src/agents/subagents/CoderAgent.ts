/**
 * Coder sub-agent — delegated coding assistance.
 *
 * Isolated DO + Session via `subAgent(CoderAgent, name)` / `rpcCollectChatTurn`.
 * Extends {@link BaseSubAgentThink} (plain `Think`) — not {@link MainAgent} — so facet startup
 * does not run orchestrator browser/voice/MCP OAuth hooks.
 */

import { Env } from "../../lib/env";
import type { ToolSet } from "ai";
import { createStandardRouter, ModelContext } from "../../models";
import { getRuntimeConfig } from "../../lib/env";
import type { Session } from "@cloudflare/think";
import {
  configureSession as applySessionConfiguration,
  type SessionConfigurationOptions,
} from "../../session/configureSession";
import type { AgentTurnContext } from "../agentTurnContext";
import { BaseSubAgentThink, type SubAgentThinkConfig } from "./BaseSubAgentThink";
import {
  CODER_SUBAGENT_TOOL_DENY,
  filterMainAgentToolSurface,
} from "./subagentToolSurface";
import { getSharedWorkspaceGateway } from "../../workspace/sharedWorkspaceFactory";
import { createSharedWorkspaceToolSet } from "../../workspace/sharedWorkspaceTools";

export class CoderAgent extends BaseSubAgentThink {
  constructor(ctx: DurableObjectState, env: Env, config: SubAgentThinkConfig = {}) {
    const runtime = getRuntimeConfig(env);
    const modelRouter =
      config.modelRouter ??
      createStandardRouter({
        aiGateway: runtime.aiGatewayBaseUrl
          ? {
              baseUrl: runtime.aiGatewayBaseUrl,
              authToken: env.AI_GATEWAY_TOKEN,
              enableCaching: true,
              cacheTtlSeconds: 3600,
            }
          : undefined,
        enableDetailedLogging: runtime.environment !== "production",
      });

    super(ctx, env, { ...config, modelRouter });
  }

  protected override getRoleModelContextOverrides(
    turn: AgentTurnContext
  ): Partial<ModelContext> {
    return {
      agentRole: "code",
      taskType: "code",
      expectsToolUse: turn.likelyToolUsage ?? true,
      estimatedComplexity: turn.estimatedComplexity || "moderate",
      latencySensitivity: turn.latencySensitivity || "medium",
      costSensitivity: turn.costSensitivity || "medium",
    };
  }

  override configureSession(session: Session): Session {
    const options: SessionConfigurationOptions = {
      soulPrompt:
        "You are a Coder sub-agent running inside an isolated delegated session. " +
        "You assist with reading, reasoning about, and proposing code changes. " +
        "You do not orchestrate the user's project alone — the parent agent coordinates work and approvals. " +
        "Prefer small, reviewable steps. Do not claim deployments or external mutations occurred unless a tool returned proof. " +
        "When the parent delegates shared work, the message may begin with `[EdgeClawSharedWorkspace]…[/EdgeClawSharedWorkspace]` — parse `projectId` from it and use that same value on every shared_workspace_* call. " +
        "Use `shared_workspace_write_staging` only under the `staging/` path prefix; use `shared_workspace_put_patch` for proposals that stay pending until the orchestrator approves, rejects, or apply_patch. Use list/get patch tools to inspect proposal state. " +
        "You cannot write canonical project paths directly — only staging files and patch proposals. " +
        "If `shared_workspace_unavailable` is the only shared tool, the Worker is missing SHARED_WORKSPACE_KV — tell the parent; do not pretend files exist. " +
        "The Think shell workspace is private scratch; shared collaboration uses `shared_workspace_*` (not project-notes or skills). " +
        "Optional `repo_git_*` tools are not registered on this sub-agent — the orchestrator may use them separately. " +
        "When the parent is a coding-loop orchestrator: keep chat replies short; put evidence in the shared workspace via tools; do not paste large diffs or whole files in prose.",
      memoryDescription: "Coder-delegation scratch facts for this sub-thread only.",
      memoryMaxTokens: 4000,
      additionalContexts: [
        {
          label: "coder_plan",
          options: {
            description: "Implementation notes and proposed patches for this delegation",
            maxTokens: 4000,
          },
        },
      ],
      compaction: {
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: 100_000,
      },
    };

    return applySessionConfiguration(session, options);
  }

  /**
   * Restrict composed tools; shared workspace tree is separate from Think workspace.
   */
  override getTools(): ToolSet {
    const filtered = filterMainAgentToolSurface(super.getTools(), CODER_SUBAGENT_TOOL_DENY);
    if (this._debugOmitSharedWorkspaceTools) {
      return filtered;
    }
    const shared = createSharedWorkspaceToolSet(getSharedWorkspaceGateway(this.env), "coder");
    return {
      ...filtered,
      ...shared,
    };
  }
}
