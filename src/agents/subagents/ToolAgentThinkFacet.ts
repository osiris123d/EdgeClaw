/**
 * Headless delegated facet for MCP / Codemode / OpenAPI / HTTP orchestration.
 *
 * Mirrors {@link BaseSubAgentThink} + {@link TesterAgent}-style narrowing but **never** registers
 * browser or shared-workspace tooling. Codemode compression is applied when env + bindings allow it.
 */

import { callable } from "agents";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "agents/chat";
import type { ToolSet, UIMessage } from "ai";
import type { Session } from "@cloudflare/think";
import { getRuntimeConfig, type Env } from "../../lib/env";
import type { TurnContext, TurnConfig } from "../../hooks";
import {
  configureSession as applySessionConfiguration,
  type SessionConfigurationOptions,
} from "../../session/configureSession";
import { createStandardRouter, type ModelContext } from "../../models";
import { createRelayCodemodeToolSet } from "../../tools/codemodeMetaSurface";
import { pickWrappedToolName, syncCodemodeWireDebugFromEnv } from "../../tools/codemodeRouterHelpers";
import {
  migratePersistedMcpServer,
  stripPersistedMcpServerOAuthRoutingFields,
  EMPTY_RAW_SDK_STATE,
  type PersistedMcpServer,
  type RawSdkMcpState,
} from "../../lib/mcpDiscovery";
import {
  formatToolAgentMcpBootstrapError,
  mcpRestoreShouldIncludeOAuthRouting,
  restorePersistedMcpServersFromConfig,
} from "../../lib/mcpRestoreFromPersisted";
import { configureEdgeClawMcpOAuthPopupClose } from "../../lib/mcpOAuthPopupHandler";
import { clampSubAgentResultForRpc, type SubAgentResult } from "../delegation";
import type { AgentTurnContext } from "../agentTurnContext";
import { deriveMainAgentCodemodeCompressionTurn } from "../mainAgentCodemodeCompressionTurn";
import { resolveCodemodeToolSurfaceCompression } from "../../tools/codemodeToolSurfaceResolve";
import { planMinimalToolSurface, pickToolsByName } from "../../tools/toolSurfacePolicy";
import { BaseSubAgentThink, type SubAgentThinkConfig } from "./BaseSubAgentThink";
import {
  filterMainAgentToolSurface,
  TOOL_AGENT_SUBAGENT_TOOL_DENY,
} from "./subagentToolSurface";
import { executeRpcCollectChatTurn } from "./rpcCollectChatTurnShared";
import { executeRpcCollectStatelessModelTurn } from "./statelessSubAgentModelTurn";
import { prepareToolAgentRpcIngress } from "./toolAgentRpcIngress";
import { buildMcpLiveMirrorToolSet } from "../../tools/mcpLiveMirrorTools";
import {
  shouldReuseLiveMcpSdkServer,
  type McpMirrorToolDescriptor,
} from "../../lib/mcpToolAgentLiveReuse";

/**
 * Scans assistant tool-invocation parts for a codemode call whose output contains
 * a Cloudflare API `"success":true` indicator — signals cloudflare_request already succeeded.
 * Used by {@link ToolAgentThinkFacet#onChatRecovery} to suppress redundant recovery turns.
 */
function detectSuccessfulCloudflareRequestInThread(msgs: UIMessage[]): boolean {
  for (const msg of msgs) {
    if ((msg as { role?: string }).role !== "assistant") continue;
    const parts = (msg as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const typ = typeof o.type === "string" ? o.type : "";
      const isToolPart =
        typ === "tool-invocation" ||
        typ.startsWith("tool-") ||
        typeof o.toolCallId === "string";
      if (!isToolPart) continue;
      const toolName = typeof o.toolName === "string" ? o.toolName.toLowerCase() : "";
      if (toolName !== "codemode") continue;
      const out = o.output ?? o.result;
      if (out === undefined || out === null) continue;
      const body = typeof out === "string" ? out : JSON.stringify(out);
      // Cloudflare API responses contain "success":true; skip obvious error outputs.
      if (/["\s]success["'\s]*:\s*true/.test(body)) return true;
    }
  }
  return false;
}

export class ToolAgentThinkFacet extends BaseSubAgentThink {
  private static readonly MCP_MIRROR_SNAPSHOT_STORAGE_KEY = "edgeclaw_ta_mcp_mirror_v1";

  private toolAgentCodemodeEnvAllowed = true;
  private toolAgentCodeExecutionEnabled = false;
  /** Wrapped MCP tools forwarded to MainAgent's live SDK session (see {@link rpcSyncMcpConfigFromMainAgent}). */
  private _liveMcpMirrorToolSet: ToolSet = {};

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
    syncCodemodeWireDebugFromEnv(env);
    this.toolAgentCodemodeEnvAllowed = runtime.featureFlags.enableCodemodeToolSurface;
    this.toolAgentCodeExecutionEnabled = runtime.featureFlags.enableCodeExecution;
    if (runtime.featureFlags.enableMcp) {
      this.waitForMcpConnections = true;
    }
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.restorePersistedMcpMirrorToolSetIfEmpty();
    const runtime = getRuntimeConfig(this.env);
    if (runtime.featureFlags.enableMcp) {
      configureEdgeClawMcpOAuthPopupClose(this);
    }
  }

  protected override getRoleModelContextOverrides(
    turn: AgentTurnContext
  ): Partial<ModelContext> {
    return {
      agentRole: "general",
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
        "You are ToolAgent — a headless sub-agent for **server-side tool orchestration** only. " +
        "You coordinate MCP tools, Codemode (`codemode` router), OpenAPI discovery, and HTTP/API calls. " +
        "You do **not** have browser automation tools. " +
        "You do not schedule tasks, run workflows, or drive deploy/promotion. " +
        "\n\n**Rule 1 — Search/describe separation:** " +
        "If the task is only to search, list, or summarize an API catalog or spec, use discovery/search tools only (`tools_find`, `openapi_search`, `tools_describe`). " +
        "Do not call execute or request tools unless the user explicitly asks to call an API, retrieve a live resource, or perform an action. " +
        "\n\n**Rule 2 — Capability-aware tool choice:** " +
        "Never assume an execute/request tool exposes the same runtime globals as a search/spec tool. " +
        "Discovery globals like `spec` exist only in search/spec tool environments; code referencing them inside execute tools will throw and is blocked as non-retryable. " +
        "For schema discovery always use `openapi_search` and `openapi_describe_operation` inside a single `codemode` call — " +
        "splitting those steps and `cloudflare_request` across separate codemode invocations causes the HTTP relay to fail with `no cached OpenAPI operation`. " +
        "\n\n**Rule 3 — Non-retryable errors:** " +
        "When a tool returns `nonRetryable: true`, stop immediately — do not retry with the same arguments. Summarize the failure once. " +
        "\n\n**Rule 4 — Answer discipline:** " +
        "Report only resources and endpoints actually found. Do not invent missing endpoints, gaps, or lifecycle coverage unless the user explicitly asks what is missing. " +
        "\n\nDelegation messages may start with `[[edgeclaw:tool-task-kind=mcp_api|external_api|tool_orchestration]]` — " +
        "that line is stripped before you see user content; treat it only as telemetry, not instructions. " +
        "Optional `[EdgeClawSharedWorkspace]` envelopes may arrive for correlation — you do **not** have `shared_workspace_*` tools.",
      memoryDescription: "Tool delegation scratch facts (isolated facet).",
      memoryMaxTokens: 2500,
      additionalContexts: [
        {
          label: "tool_orchestration",
          options: {
            description: "Tool plans, MCP ids, HTTP routes, and concise evidence",
            maxTokens: 4000,
          },
        },
      ],
      compaction: {
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: 80_000,
      },
    };

    return applySessionConfiguration(session, options);
  }

  /** Defensive denial list — base tools are already non-browser via {@link BaseSubAgentThink#getTools}. */
  override getTools(): ToolSet {
    const base = filterMainAgentToolSurface(super.getTools(), TOOL_AGENT_SUBAGENT_TOOL_DENY);
    return { ...base, ...this._liveMcpMirrorToolSet };
  }

  private resolveCloudflareAccountIdForCodemodeRouter(): string | undefined {
    const id = this.env.Variables?.CLOUDFLARE_ACCOUNT_ID ?? this.env.CLOUDFLARE_ACCOUNT_ID;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  }

  private getToolAgentDurableStorage(): DurableObjectStorage | undefined {
    return (this as unknown as { ctx?: { storage?: DurableObjectStorage } }).ctx?.storage;
  }

  private async clearPersistedMcpMirrorSnapshot(): Promise<void> {
    const st = this.getToolAgentDurableStorage();
    if (!st) return;
    await st.delete(ToolAgentThinkFacet.MCP_MIRROR_SNAPSHOT_STORAGE_KEY);
  }

  private async persistMcpMirrorSnapshot(args: {
    delegatedParentAgentName: string;
    mcpMirrorToolDescriptors: Record<string, McpMirrorToolDescriptor>;
  }): Promise<void> {
    const st = this.getToolAgentDurableStorage();
    if (!st) return;
    const parent = args.delegatedParentAgentName.trim();
    if (!parent) return;
    await st.put(ToolAgentThinkFacet.MCP_MIRROR_SNAPSHOT_STORAGE_KEY, {
      v: 1 as const,
      delegatedParentAgentName: parent,
      mcpMirrorToolDescriptors: args.mcpMirrorToolDescriptors,
      updatedAt: Date.now(),
    });
  }

  /** Rebuild {@link _liveMcpMirrorToolSet} after DO eviction — mirrors only survive RAM unless snapshotted. */
  private async restorePersistedMcpMirrorToolSetIfEmpty(): Promise<void> {
    if (Object.keys(this._liveMcpMirrorToolSet).length > 0) return;
    const st = this.getToolAgentDurableStorage();
    if (!st) return;
    const raw = await st.get<unknown>(ToolAgentThinkFacet.MCP_MIRROR_SNAPSHOT_STORAGE_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const rec = raw as Record<string, unknown>;
    if (rec.v !== 1) return;
    const parent =
      typeof rec.delegatedParentAgentName === "string" ? rec.delegatedParentAgentName.trim() : "";
    const descriptors = rec.mcpMirrorToolDescriptors;
    if (!parent || !descriptors || typeof descriptors !== "object" || Array.isArray(descriptors)) return;

    this._liveMcpMirrorToolSet = buildMcpLiveMirrorToolSet({
      env: this.env,
      parentAgentName: parent,
      descriptors: descriptors as Record<string, McpMirrorToolDescriptor>,
    });

    const searchRelayName = pickWrappedToolName(this._liveMcpMirrorToolSet, "search");
    const execRelayName = pickWrappedToolName(this._liveMcpMirrorToolSet, "execute");
    console.log(
      `[EdgeClaw][tool-agent] mcpMirrorRehydrate phase=storage_restore requestId=${this.requestId} ` +
        `mirrorToolCount=${Object.keys(this._liveMcpMirrorToolSet).length} ` +
        `hasSearchRelay=${Boolean(searchRelayName)} hasExecuteRelay=${Boolean(execRelayName)}`
    );
  }

  protected override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.restorePersistedMcpMirrorToolSetIfEmpty();

    const tools = this.getTools();
    const searchRelayName = pickWrappedToolName(tools, "search");
    const execRelayName = pickWrappedToolName(tools, "execute");
    const recoveryDataTag =
      ctx.recoveryData === null || ctx.recoveryData === undefined
        ? "null"
        : typeof ctx.recoveryData;

    console.log(
      `[EdgeClaw][tool-agent] onChatRecovery phase=fiber_resume execution=fresh_vs_recovery=recovery ` +
        `requestId=${this.requestId} rpcRequestId=${ctx.requestId} streamId=${ctx.streamId} ` +
        `recoveryData=${recoveryDataTag} ` +
        `hasSearchRelay=${Boolean(searchRelayName)} hasExecuteRelay=${Boolean(execRelayName)} ` +
        `mirrorToolCount=${Object.keys(this._liveMcpMirrorToolSet).length} ` +
        `liveSdkToolRowsApprox=${Object.keys(tools).filter((k) => /^tool_.*_(search|execute)$/.test(k)).length}`
    );

    // Suppress recovery if cloudflare_request already succeeded — prevents redundant exploratory turns.
    const hasSuccessfulCloudflareRequest = detectSuccessfulCloudflareRequestInThread(
      this.getMessages() as UIMessage[]
    );
    if (hasSuccessfulCloudflareRequest) {
      console.log(
        `[EdgeClaw][tool-agent] onChatRecovery skip_recovery hasSuccessfulCloudflareRequest=true ` +
          `terminalReason=prior_cloudflare_request_succeeded recovery_continuation_skipped=true requestId=${this.requestId}`
      );
      return { continue: false, persist: true };
    }

    if (!searchRelayName || !execRelayName) {
      console.warn(
        `[EdgeClaw][tool-agent] onChatRecovery skipContinue mirrorIncomplete requestId=${this.requestId} rpcRequestId=${ctx.requestId}`
      );
      return { continue: false, persist: true };
    }

    return {};
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    const prior = await super.beforeTurn(ctx);
    const base = { ...(prior && typeof prior === "object" ? prior : {}) } as TurnConfig;
    const mergedTools = (ctx.tools ?? {}) as ToolSet;

    const compressionPreSanity = resolveCodemodeToolSurfaceCompression({
      envGloballyAllows: this.toolAgentCodemodeEnvAllowed,
      userCodemodeToolSurfaceEnabled: true,
      hasLoaderBinding: Boolean(this.env.LOADER),
      codeExecutionEnabled: this.toolAgentCodeExecutionEnabled,
    });

    const turnView = deriveMainAgentCodemodeCompressionTurn({
      mergedTools,
      compressionPreSanity,
      sanityOutcome: undefined,
      codemodeAutoFallbackToLegacyTools: true,
      hasLoaderBinding: Boolean(this.env.LOADER),
      codeExecutionEnabled: this.toolAgentCodeExecutionEnabled,
    });

    const plan = planMinimalToolSurface({
      mergedTools,
      codemodeSurfaceEnabled: turnView.finalCompression.effective,
      hasLoaderBinding: Boolean(this.env.LOADER),
      codeExecutionEnabled: this.toolAgentCodeExecutionEnabled,
    });

    if (plan.reason === "codemode-surface-applied-default") {
      const relay = pickToolsByName(mergedTools, plan.wrappedNames);
      const wrappedToolCount = Object.keys(relay).length;
      const searchRelayName = pickWrappedToolName(relay, "search");
      const execRelayName = pickWrappedToolName(relay, "execute");
      const executionPhase = ctx.continuation ? "recovery_continuation" : "fresh_turn";
      if (!searchRelayName) {
        console.warn(
          `[EdgeClaw][tool-agent] codemodeSurface=no_wrapped_search_tool execution=${executionPhase} requestId=${this.requestId}`
        );
      } else if (!execRelayName) {
        console.warn(
          `[EdgeClaw][tool-agent] codemodeSurface=partial_no_execute execution=${executionPhase} requestId=${this.requestId}`
        );
      } else {
        console.log(
          `[EdgeClaw][tool-agent] codemodeSurface=ready wrappedToolCount=${wrappedToolCount} execution=${executionPhase} requestId=${this.requestId}`
        );
      }
      if (ctx.continuation && (!searchRelayName || !execRelayName)) {
        throw new Error(
          `tool_agent_codemode_mirror_incomplete_on_continuation requestId=${this.requestId} hasSearchRelay=${Boolean(searchRelayName)} hasExecuteRelay=${Boolean(execRelayName)}`
        );
      }
      const codemodePartial = createRelayCodemodeToolSet({
        relay,
        loader: this.env.LOADER as NonNullable<Env["LOADER"]>,
        workspace: this.getWorkspace(),
        cloudflareAccountId: this.resolveCloudflareAccountIdForCodemodeRouter(),
        codemodeDescriptionAppendix: undefined,
        emitBootstrapLog: false,
      });
      base.tools = {
        ...(base.tools ?? {}),
        ...codemodePartial,
      };
      const activeNames = ["codemode", ...plan.directNames];
      base.activeTools = [...new Set(activeNames)];
    }

    return base;
  }

  /**
   * Mirrors MainAgent's persisted MCP configuration into this ToolAgent DO before a delegated turn.
   * Ensures Codemode relay `openapi_search` sees the same wrapped `tool_*_search` MCP tools as the parent.
   */
  private logToolAgentPostMcpSyncDiagnostics(mergedRows: PersistedMcpServer[]): void {
    const rawUnknown = (this as unknown as { getMcpServers?: () => unknown }).getMcpServers?.();
    const raw = (rawUnknown ?? EMPTY_RAW_SDK_STATE) as RawSdkMcpState;

    for (const row of mergedRows) {
      if (!row.enabled) continue;
      const sdkEntry = Object.entries(raw.servers ?? {}).find(([, s]) => s?.name === row.name);
      const sdkId = sdkEntry?.[0];
      const sdk = sdkEntry?.[1];
      const authUrlPresent = Boolean(sdk?.auth_url && String(sdk.auth_url).trim());
      const toolCountForServer = sdkId
        ? (raw.tools ?? []).filter((t) => t.serverId === sdkId).length
        : 0;
      console.log(
        `[EdgeClaw][tool-agent] mcpRestoreDiag name=${JSON.stringify(row.name)} ` +
          `authRequired=${row.authRequired === undefined ? "unset" : String(row.authRequired)} ` +
          `authUrlPresent=${authUrlPresent} state=${sdk?.state ?? "absent"} sdkServerId=${sdkId ?? "none"} toolCount=${toolCountForServer}`
      );
    }

    const tools = this.getTools();
    const wrappedKeys = Object.keys(tools).filter((k) => /^tool_.*_(search|execute)$/.test(k));
    const wrappedToolCount = wrappedKeys.length;
    const searchRelayName = pickWrappedToolName(tools, "search");
    const execRelayName = pickWrappedToolName(tools, "execute");
    const codemodeSurface =
      searchRelayName && execRelayName
        ? "ready"
        : searchRelayName
          ? "partial_no_execute"
          : "no_wrapped_search_tool";
    console.log(
      `[EdgeClaw][tool-agent] codemodeSurface=${codemodeSurface} wrappedToolCount=${wrappedToolCount} ` +
        `requestId=${this.requestId} phase=post_mcp_sync`
    );
  }

  @callable()
  async rpcSyncMcpConfigFromMainAgent(payload: {
    servers: unknown[];
    /** Parent chat/public origin when persisted rows omit {@link PersistedMcpServer.callbackHost}. */
    oauthCallbackHost?: string;
    /** MainAgent DO instance name — required for live MCP mirror RPC forward. */
    delegatedParentAgentName?: string;
    /** Serialized mirror descriptors built from MainAgent `mcp.getAITools()` for reuse-live servers. */
    mcpMirrorToolDescriptors?: Record<string, McpMirrorToolDescriptor>;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.clearPersistedMcpMirrorSnapshot();
      this._liveMcpMirrorToolSet = {};
      const rows: PersistedMcpServer[] = [];
      for (const raw of payload.servers ?? []) {
        try {
          rows.push(migratePersistedMcpServer(raw));
        } catch (e) {
          console.warn("[EdgeClaw][tool-agent] Skipping malformed MCP row from MainAgent sync:", e);
        }
      }
      const oauthHost =
        typeof payload.oauthCallbackHost === "string" ? payload.oauthCallbackHost.trim() : "";
      const mergedRows = rows.map((r) => {
        const routing = mcpRestoreShouldIncludeOAuthRouting(r);
        const base = routing ? r : stripPersistedMcpServerOAuthRoutingFields(r);
        if (!mcpRestoreShouldIncludeOAuthRouting(base)) {
          return base;
        }
        if (!base.callbackHost?.trim() && oauthHost) {
          return { ...base, callbackHost: oauthHost };
        }
        return base;
      });

      for (const row of mergedRows) {
        const reuse = shouldReuseLiveMcpSdkServer(row);
        const oauthRouting = mcpRestoreShouldIncludeOAuthRouting(row);
        console.log(
          `[EdgeClaw][tool-agent] mcpSyncDecision name=${JSON.stringify(row.name)} ` +
            `url=${JSON.stringify(row.url)} sdkServerId=${row.mcpSdkServerId ?? "none"} ` +
            `authRequired=${row.authRequired === undefined ? "unset" : String(row.authRequired)} ` +
            `toolCount=${row.mcpToolCount ?? 0} ` +
            `restoreMode=${reuse ? "reuse-live-sdk-server" : "restore-persisted"} ` +
            `oauthRoutingIncluded=${oauthRouting}`
        );
      }

      const parentName =
        typeof payload.delegatedParentAgentName === "string" ? payload.delegatedParentAgentName.trim() : "";
      const descriptors = payload.mcpMirrorToolDescriptors ?? {};
      this._liveMcpMirrorToolSet = buildMcpLiveMirrorToolSet({
        env: this.env,
        parentAgentName: parentName,
        descriptors,
      });

      const reuseRows = mergedRows.filter(shouldReuseLiveMcpSdkServer);
      if (reuseRows.length > 0 && Object.keys(this._liveMcpMirrorToolSet).length === 0) {
        console.warn(
          "[EdgeClaw][tool-agent] Live MCP reuse rows present but mirror tool set is empty " +
            "(missing MAIN_AGENT binding, delegatedParentAgentName, or mirror descriptors for sdkServerId)."
        );
      }

      const cfg = (this.getConfig() ?? {}) as Record<string, unknown>;
      await this.configure({ ...cfg, mcpServers: mergedRows });
      const { failures } = await restorePersistedMcpServersFromConfig(
        this as unknown as import("../../lib/mcpRestoreFromPersisted").ThinkMcpRestoreHost,
        { skipRestore: shouldReuseLiveMcpSdkServer }
      );
      if (failures.length > 0) {
        return {
          ok: false,
          error: formatToolAgentMcpBootstrapError(failures[0]!.message),
        };
      }
      this.logToolAgentPostMcpSyncDiagnostics(mergedRows);
      await this.persistMcpMirrorSnapshot({
        delegatedParentAgentName: parentName,
        mcpMirrorToolDescriptors: descriptors,
      });
      console.log(
        `[EdgeClaw][tool-agent] mcpMirrorSnapshotPersisted requestId=${this.requestId} parent=${JSON.stringify(parentName)} descriptorKeys=${Object.keys(descriptors).length}`
      );
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[EdgeClaw][tool-agent] rpcSyncMcpConfigFromMainAgent failed:", msg);
      return { ok: false, error: formatToolAgentMcpBootstrapError(msg) };
    }
  }

  @callable()
  override async rpcCollectChatTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    try {
      const prepared = prepareToolAgentRpcIngress(this.env, raw);
      this._debugOmitSharedWorkspaceTools = prepared.omitSharedWorkspaceTools;
      this._rpcDelegationGatewayObs = prepared.delegationGatewayObs;
      const inner = await executeRpcCollectChatTurn(this, prepared.inferenceMessageTrimmed);
      const result = clampSubAgentResultForRpc(inner);
      const hasSuccessfulCloudflareRequest = detectSuccessfulCloudflareRequestInThread(
        this.getMessages() as UIMessage[]
      );
      console.log(
        `[EdgeClaw][tool-agent] rpcCollectChatTurn terminal ok=${result.ok} ` +
          `hasSuccessfulCloudflareRequest=${hasSuccessfulCloudflareRequest} requestId=${this.requestId}`
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[EdgeClaw][subagent-facet] ${this.constructor.name}.rpcCollectChatTurn failed`,
        msg
      );
      console.log(`[EdgeClaw][tool-agent] rpcCollectChatTurn terminal ok=false requestId=${this.requestId}`);
      return clampSubAgentResultForRpc({ text: "", events: [], ok: false, error: msg });
    } finally {
      this._rpcDelegationGatewayObs = null;
      this._debugOmitSharedWorkspaceTools = false;
    }
  }

  @callable()
  override async rpcCollectStatelessModelTurn(message: string): Promise<SubAgentResult> {
    const raw = typeof message === "string" ? message : "";
    try {
      const prepared = prepareToolAgentRpcIngress(this.env, raw);

      this._debugOmitSharedWorkspaceTools = prepared.omitSharedWorkspaceTools;
      this._rpcDelegationGatewayObs = prepared.delegationGatewayObs;
      return clampSubAgentResultForRpc(
        await executeRpcCollectStatelessModelTurn(this, prepared.inferenceMessageTrimmed)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[EdgeClaw][subagent-facet] ${this.constructor.name}.rpcCollectStatelessModelTurn failed`,
        msg
      );
      return clampSubAgentResultForRpc({ text: "", events: [], ok: false, error: msg });
    } finally {
      this._rpcDelegationGatewayObs = null;
      this._debugOmitSharedWorkspaceTools = false;
    }
  }
}
