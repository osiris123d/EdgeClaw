/**
 * Tester sub-agent — read/verification-oriented delegation.
 *
 * Extends {@link BaseSubAgentThink} — not {@link MainAgent} — to avoid orchestrator-only startup
 * (browser session auth, voice, MCP OAuth callback, TTS storage) on child facets.
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
  TESTER_SUBAGENT_TOOL_DENY,
  filterMainAgentToolSurface,
} from "./subagentToolSurface";
import { getSharedWorkspaceGateway } from "../../workspace/sharedWorkspaceFactory";
import { createSharedWorkspaceToolSet } from "../../workspace/sharedWorkspaceTools";

export class TesterAgent extends BaseSubAgentThink {
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
      agentRole: "analysis",
      taskType: "tool_use",
      expectsToolUse: turn.likelyToolUsage ?? true,
      estimatedComplexity: turn.estimatedComplexity || "moderate",
      latencySensitivity: turn.latencySensitivity || "medium",
      costSensitivity: turn.costSensitivity || "medium",
    };
  }

  override configureSession(session: Session): Session {
    const options: SessionConfigurationOptions = {
      soulPrompt:
        "You are a Tester sub-agent in an isolated delegated session. " +
        "Your default role is verification: inspect, search, and summarize evidence. " +
        "When the parent delegates coding-loop verification, treat DATA_MODELS.md and API_DESIGN.md (when present in the message) as strict contracts: flag type/nullability mismatches and API shape drift explicitly; prefer failing verification over silently accepting “reasonable” divergences unless the blueprint explicitly allows them. " +
        "Do not schedule tasks, launch workflows, or mutate project notes unless the parent explicitly instructs otherwise. " +
        "When the parent delegates with a shared project, the message may begin with `[EdgeClawSharedWorkspace]…[/EdgeClawSharedWorkspace]` — parse `projectId` and pass it to shared_workspace_read, shared_workspace_list, shared_workspace_list_patches, shared_workspace_get_patch, and shared_workspace_record_verification. " +
        "You cannot write project files or change patch status (no write_staging, approve, reject, or apply). Store command output and conclusions with `shared_workspace_record_verification`. " +
        "If only `shared_workspace_unavailable` appears for shared tools, ask the parent to configure SHARED_WORKSPACE_KV. " +
        "Never describe deploys or production changes. `repo_git_*` tools are not available on this sub-agent. " +
        "When the parent is a coding-loop orchestrator: keep chat brief; cite tools and patch ids; do not paste entire patch bodies or large files in prose.",
      memoryDescription: "Tester-delegation findings for this sub-thread only.",
      memoryMaxTokens: 3500,
      additionalContexts: [
        {
          label: "test_findings",
          options: {
            description: "Checks performed, log excerpts, and conclusions",
            maxTokens: 4000,
          },
        },
      ],
      compaction: {
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: 90_000,
      },
    };

    return applySessionConfiguration(session, options);
  }

  override getTools(): ToolSet {
    const filtered = filterMainAgentToolSurface(super.getTools(), TESTER_SUBAGENT_TOOL_DENY);
    if (this._debugOmitSharedWorkspaceTools) {
      return filtered;
    }
    const shared = createSharedWorkspaceToolSet(getSharedWorkspaceGateway(this.env), "tester");
    return {
      ...filtered,
      ...shared,
    };
  }
}
