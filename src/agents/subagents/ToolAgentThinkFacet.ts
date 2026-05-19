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
import { pickWrappedToolName, syncCodemodeWireDebugFromEnv, isCodemodeWireDebugEnabled } from "../../tools/codemodeRouterHelpers";
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
import {
  executeRpcCollectChatTurn,
  synthesizeAssistantTextFromToolParts,
} from "./rpcCollectChatTurnShared";
import { executeRpcCollectStatelessModelTurn } from "./statelessSubAgentModelTurn";
import { prepareToolAgentRpcIngress } from "./toolAgentRpcIngress";
import { buildMcpLiveMirrorToolSet } from "../../tools/mcpLiveMirrorTools";
import {
  findMissingMcpMirrorDescriptors,
  shouldReuseLiveMcpSdkServer,
  expectedMcpMirrorToolNamesForServer,
  type McpMirrorToolDescriptor,
} from "../../lib/mcpToolAgentLiveReuse";
import { buildToolAgentResultEnvelope } from "../toolAgentResultEnvelope";
import {
  buildLargeResultEnvelope,
  MAX_FINAL_RESPONSE_CHARS,
} from "../toolAgentLargeResultGuards";
import {
  applyReductionPipeline,
  detectRootCauseSemanticFailure,
} from "./toolAgentReductionPipeline";
import {
  finalizeSuccessAware,
} from "../toolAgentSuccessAwareFinalization";

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

function didToolAgentRunAnyTools(msgs: UIMessage[]): boolean {
  for (const msg of msgs) {
    if ((msg as { role?: string }).role !== "assistant") continue;
    const parts = (msg as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const typ = typeof o.type === "string" ? o.type : "";
      const looksLikeToolPart =
        typ === "tool-invocation" ||
        typ === "dynamic-tool" ||
        typ.startsWith("tool-") ||
        typeof o.toolCallId === "string";
      if (looksLikeToolPart) return true;
    }
  }
  return false;
}

/**
 * Normalizes semantic error text to a canonical deduplication key.
 * Different phrasings of the same error (different formatting, casing, extra context)
 * should map to the same key so repeated failures are correctly detected.
 *
 * Examples:
 *   "Multiple accounts available" → "missing_tool_input:account_id"
 *   'Please specify the "account_id" parameter' → "missing_tool_input:account_id"
 *   "spec is not defined" → "wrong_tool_api:spec_not_defined"
 *   '"nonRetryable": true' → "non_retryable:tool_error"
 *
 * Returns null if no recognized semantic error pattern is found.
 */
function normalizeSemanticErrorKey(text: string): string | null {
  if (/mcp-required-input-inject-conflict|\bconflicting_tool_input\b/i.test(text)) {
    return "conflicting_tool_input:top_level_identifier_mismatch";
  }
  if (/\b(?:forbidden|permission denied|not authorized|authorization error|insufficient permissions?)\b|\b403\b/i.test(text)) {
    return "permission_error:provider_access_denied";
  }
  if (/Cloudflare API error:\s*10000|Authentication error|\b401\b|Unauthorized|auth(entication)?\s+(failed|error|invalid)/i.test(text)) {
    return "auth_error:provider_auth_failed";
  }
  if (/Multiple accounts available|multiple accounts.*specify.*account_id/i.test(text)) {
    return "missing_tool_input:account_id";
  }
  if (/missing_required_tool_input|missing[_\s-]?account[_\s-]?id|please specify[^\n]{0,80}(?:account|parameter)/i.test(text)) {
    return "missing_tool_input:account_id";
  }
  if (/spec is not defined|spec_not_defined|unknown_helper_argument|tools_call.*invalid|wrong tool api/i.test(text)) {
    return "wrong_tool_api:spec_not_defined";
  }
  if (/invalid[_\s-]?tool[_\s-]?input|unrecognized_keys|schema validation|zod/i.test(text)) {
    return "invalid_tool_input:schema_validation_failed";
  }
  if (/"nonRetryable"\s*:\s*true|\bnonRetryable\s*[:=]\s*true|\bnon_retryable\b/i.test(text)) {
    return "non_retryable:tool_error";
  }
  if (/tool_agent_delegation_timeout|\btimed out\b/i.test(text)) {
    return "timeout:delegation";
  }
  return null;
}

/**
 * Counts how many distinct segments in tool synthesis text match a given semantic error key.
 * Splits on tool-output boundaries so each tool call result is counted separately.
 */
function countSemanticKeyInSynthesis(synthesisText: string, key: string): number {
  if (!synthesisText || !key) return 0;
  // Split on common tool-output boundary markers
  const segments = synthesisText.split(/\n---+\n|\n\n\n|(?<=\})\s*\n(?=\{)/);
  let count = 0;
  for (const seg of segments) {
    if (seg.trim().length > 0 && normalizeSemanticErrorKey(seg) === key) count++;
  }
  // If no boundary was found, still check the whole text
  return count > 0 ? count : (normalizeSemanticErrorKey(synthesisText) === key ? 1 : 0);
}

function requiresExplicitOpenApiChain(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("openapi chain contract")) return true;
  const hasLiteralChain =
    lower.includes("openapi_search") &&
    lower.includes("openapi_describe_operation") &&
    lower.includes("cloudflare_request");
  if (hasLiteralChain) return true;
  return (
    /openapi\s+search\s*\/\s*describe/i.test(lower) ||
    (/openapi\s+search/i.test(lower) && /openapi\s+describe/i.test(lower)) ||
    /then\s+call\s+only\s+get/i.test(lower) ||
    /verify\s+describestatus/i.test(lower) ||
    /describestatekeys/i.test(lower) ||
    /invocationstoreid/i.test(lower)
  );
}

function hasExplicitOpenApiChainEvidence(evidence: string): boolean {
  const lower = evidence.toLowerCase();
  const s = lower.indexOf("openapi_search");
  const d = lower.indexOf("openapi_describe_operation", s >= 0 ? s : 0);
  const c = lower.indexOf("cloudflare_request", d >= 0 ? d : 0);
  return s >= 0 && d > s && c > d;
}

function hasToolsCallCodeFallbackEvidence(evidence: string): boolean {
  return /\btools_call_code\b|\btool_[a-z0-9]+_execute\b/i.test(evidence);
}

function allowsExplicitOpenApiChainFallback(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /fallback\s+allowed/.test(lower) ||
    /allow\s+fallback/.test(lower) ||
    /fallback\s+is\s+allowed/.test(lower) ||
    /you\s+may\s+use\s+tools_call_code/.test(lower) ||
    /you\s+may\s+use\s+tool_[a-z0-9]+_execute/.test(lower) ||
    /allow\s+tools_call_code/.test(lower)
  );
}

// ── Strict-chain structured evidence ─────────────────────────────────────────

interface StrictChainEvidenceItem {
  called: true;
  invocationStorePresent?: boolean;
  invocationStoreId?: string | null;
  describeStatus?: string;
  describeStateKeys?: string[];
  method?: string;
  path?: string;
  operationPathTemplate?: string;
  errorCode?: string;
}

interface StrictChainEvidence {
  openapi_search?: StrictChainEvidenceItem;
  openapi_describe_operation?: StrictChainEvidenceItem;
  cloudflare_request?: StrictChainEvidenceItem;
}

const STRICT_CHAIN_TOOL_NAMES = new Set([
  "openapi_search",
  "openapi_describe_operation",
  "cloudflare_request",
]);

/**
 * Walks an arbitrary JSON value recursively (max depth 20) looking for objects
 * whose `_chainEvidence.tool` field names one of the three strict-chain helpers.
 * When found, merges into `evidence` without erasing already-discovered fields.
 */
function walkForChainEvidence(
  value: unknown,
  evidence: StrictChainEvidence,
  depth: number
): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walkForChainEvidence(item, evidence, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;

  // Check this node for a _chainEvidence marker.
  const ce = rec._chainEvidence;
  if (ce !== null && ce !== undefined && typeof ce === "object" && !Array.isArray(ce)) {
    const cev = ce as Record<string, unknown>;
    const toolName = typeof cev.tool === "string" ? cev.tool : "";
    if (STRICT_CHAIN_TOOL_NAMES.has(toolName)) {
      const key = toolName as keyof StrictChainEvidence;
      const existing = evidence[key];
      if (!existing) {
        evidence[key] = cev as unknown as StrictChainEvidenceItem;
      } else {
        // Merge: fill in missing fields but do not overwrite truthy/called fields.
        const merged = { ...cev, ...existing } as unknown as StrictChainEvidenceItem;
        evidence[key] = merged;
      }
    }
  }

  // Recurse into all child values.
  for (const childKey of Object.keys(rec)) {
    if (childKey === "_chainEvidence") continue; // already handled
    walkForChainEvidence(rec[childKey], evidence, depth + 1);
  }
}

/**
 * Scans all assistant tool-output parts in the thread for `_chainEvidence` markers
 * emitted by openapi_search, openapi_describe_operation, and cloudflare_request.
 *
 * Evidence may be nested at any depth inside the tool-output JSON (e.g.
 * `result.error._chainEvidence`, `result.intermediate.search._chainEvidence`).
 * Structured evidence is preferred over text scanning in the chain guard.
 */
function extractStrictChainEvidenceFromThread(msgs: UIMessage[]): StrictChainEvidence {
  const evidence: StrictChainEvidence = {};
  for (const msg of msgs) {
    if ((msg as { role?: string }).role !== "assistant") continue;
    const parts = (msg as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const o = part as Record<string, unknown>;
      const out = o.output ?? o.result;
      if (out === undefined || out === null) continue;
      let parsed: unknown = out;
      if (typeof out === "string") {
        try {
          parsed = JSON.parse(out);
        } catch {
          continue;
        }
      }
      walkForChainEvidence(parsed, evidence, 0);
    }
  }
  console.warn(
    JSON.stringify({
      marker: "[EdgeClaw][strict-chain-evidence]",
      search: evidence.openapi_search?.called === true,
      describe: evidence.openapi_describe_operation?.called === true,
      request: evidence.cloudflare_request?.called === true,
      source: "recursive_tool_output",
    })
  );
  return evidence;
}

export class ToolAgentThinkFacet extends BaseSubAgentThink {
  private static readonly MCP_MIRROR_SNAPSHOT_STORAGE_KEY = "edgeclaw_ta_mcp_mirror_v1";

  private toolAgentCodemodeEnvAllowed = true;
  private toolAgentCodeExecutionEnabled = false;
  /** Sticky setup failure when delegated live MCP mirror prerequisites are missing. */
  private _mcpMirrorSetupFailure: string | undefined;
  /** Original delegated task text from MainAgent sync payload; forwarded to host RPC for generic input extraction. */
  private _delegatedTaskTextForMirror = "";
  /** Correlation key for this delegated mirror session; used by MainAgent host-boundary task-text lookup. */
  private _delegationCorrelationIdForMirror = "";
  /** Wrapped MCP tools forwarded to MainAgent's live SDK session (see {@link rpcSyncMcpConfigFromMainAgent}). */
  private _liveMcpMirrorToolSet: ToolSet = {};
  /**
   * When true, suppresses Think `_broadcastMessages` during RPC-delegated turns so
   * ToolAgent's internal tool-call/tool-result parts do not leak to the parent's
   * user-visible chat UI.  Set at the start of {@link rpcCollectChatTurn} and cleared
   * at the end.
   */
  private _suppressToolStreamBroadcast = false;

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

    // Monkey-patch Think's private _broadcastMessages to suppress broadcasts
    // during RPC-delegated turns (no user WebSocket on ToolAgent DO).
    const self = this as unknown as Record<string, unknown>;
    const originalBroadcast = self._broadcastMessages;
    if (typeof originalBroadcast === "function") {
      self._broadcastMessages = (...args: unknown[]) => {
        if (this._suppressToolStreamBroadcast) return;
        return (originalBroadcast as Function).apply(this, args);
      };
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
        "`openapi_describe_operation` is schema/spec-only and must use the search/spec mirror (`tool_*_search`), never the execute mirror. " +
        "Use execute mirror only for `cloudflare_request` API calls. " +
        "\n\n**Rule 3 — Non-retryable errors:** " +
        "When a tool returns `nonRetryable: true`, stop immediately — do not retry with the same arguments. Summarize the failure once. " +
        "\n\n**Rule 4 — Answer discipline:** " +
        "Report only resources and endpoints actually found. Do not invent missing endpoints, gaps, or lifecycle coverage unless the user explicitly asks what is missing. " +
        "\n\n**Rule 5 — Tool description as executable contract:** " +
        "Before invoking a native MCP tool with `tools_call`, call `tools_describe` to read its description. " +
        "If the description says 'pass X as parameter Y' or 'please specify the Y parameter', include that parameter in `tools_call` `input` at invocation time. " +
        "Tool descriptions are executable contracts: required parameters listed in descriptions must appear in `tools_call` `input` — " +
        "they are NOT the same as OpenAPI query/body parameters for `cloudflare_request`. " +
        "When a `tools_call` response includes a `feedback` field with `kind=missing_required_tool_input`, " +
        "retry with `input[feedback.parameter]` set to a candidate value, or ask the user which value to use if multiple candidates are listed. " +
        "\n\n**Rule 6 — Large result and pagination discipline:** " +
        "Never return raw JSON arrays or large list-API payloads inline. " +
        "If a tool result exceeds 40,000 chars or contains more than 50 items, switch to paginated extraction mode: " +
        "(a) fetch one page at a time, " +
        "(b) extract only the fields explicitly requested by the user — default to id, name, status, type if none specified, " +
        "(c) accumulate compact findings (≤50 items inline), " +
        "(d) store full findings using shared_workspace_write or an artifact tool if available, " +
        "(e) return a final answer with scannedCount, matchedCount, artifactPointer (if stored), and a brief compact summary. " +
        "\n\n**Rule 7 — No raw JSON dumps:** " +
        "Do not echo raw API responses or full JSON arrays back as the final answer. " +
        "Synthesize: extract requested fields, count items, describe anomalies, and provide next-step guidance. " +
        "\n\n**Rule 8 — Compact accumulator pattern:** " +
        "For multi-page tasks: keep a running compact accumulator (e.g. `{found: [...], scannedCount: N, matchedCount: M}`). " +
        "Return the accumulator summary as the final answer — not raw per-page dumps. " +
        "\n\n**Rule 9 — Reduction-first execution (map/filter/reduce):** " +
        "Always treat data transformation as the primary compute layer. When a tool returns large or structured data: " +
        "(a) **DO NOT return it directly** — first apply a reduction/extraction step using codemode or `tools_call` code execution. " +
        "(b) **Filter to requested fields:** Extract id, name, status, type, or fields explicitly named by the user. " +
        "(c) **Limit inline results:** Cap at 50 items. Store overflow in shared workspace or artifact. " +
        "(d) **Track metadata:** Always report scannedCount (total items examined) and matchedCount (items returned). " +
        "(e) **Root-cause failures first:** If you detect missing_tool_input, wrong_tool_api, timeout, or non_retryable errors, STOP immediately — return failure details, do NOT attempt reduction. " +
        "\n\n**Rule 10 — Codemode as primary transform:** " +
        "Prefer `codemode` for data extraction, filtering, and JSON transformation rather than inline reasoning. " +
        "Design codemode calls to consume raw results, extract/filter, and return compact JSON with scannedCount and matchedCount metadata. " +
        "Never pass raw unfiltered results to the user — always post-process through codemode or manual extraction first. " +
        "\n\n**Rule 11 — Minimal endpoint execution plan:** " +
        "Endpoint discovery is not equivalent to endpoint execution. Construct the smallest sufficient execution plan from the user’s requested fields. " +
        "Treat discovered endpoints and API mappings as schema/discovery hints only, not mandatory execution steps. " +
        "Prefer collection/list endpoints when requested fields are already available there. " +
        "Call detail/resource-by-id endpoints only when required fields are missing from collection results, pagination expansion is required, or the user explicitly asks for detailed inspection/verification. " +
        "Never call mutation endpoints unless the user explicitly requests mutation behavior. " +
        "Minimize endpoint count and payload size; reduce (filter/map/reduce) inside execution and return only requested compact fields. " +
        "\n\n**Rule 12 — Never return raw API payloads:** " +
        "Never return bare `{ response }` wrappers, raw API response bodies, or full unfiltered JSON arrays. " +
        "If codemode/list-api returns structured data, you MUST extract and reduce it inside the codemode call itself. " +
        "Final result must always include scannedCount and matchedCount metadata, not raw API response wrappers. " +
        "Example: If user asks 'find gateway rules with name prefix allow', codemode must: (1) call list endpoint, (2) filter by rule name, (3) return `{ scannedCount: 50, matchedCount: 3, matched: [{ rule_id: 'allow-1' }, ...] }`, never return raw `{ success: true, result: [...] }`. " +
        "\n\n**Rule 13 — One codemode call for API list tasks:** " +
        "For requests like 'find resources matching X and return field Y', generate ONE codemode invocation that performs: " +
        "(1) openapi_search when endpoint discovery is needed, (2) openapi_describe_operation, (3) cloudflare_request, (4) pagination + filtering + mapping, (5) compact JSON return only. " +
        "Do not emit intermediate codemode invocations that return discovery/search payloads unless the user asked for discovery only. " +
        "When calling cloudflare_request for list/read tasks, include reduction options so the relay returns compact structured output and never raw list payloads. " +
        "Always guard helper results: if `result.ok === false`, return the failure envelope immediately; never coerce tool failures into `{ scannedCount: 0, matchedCount: 0 }`. " +
        "\n\n**Rule 14 — Codemode `cm` initialization is mandatory:** " +
        "Before any codemode helper usage, every generated codemode function MUST initialize `cm` exactly once: " +
        "`const cm = typeof codemode !== \"undefined\" ? codemode : arguments[0]?.codemode;`. " +
        "Do not call `cm.openapi_search`, `cm.openapi_describe_operation`, `cm.cloudflare_request`, or any other `cm.*` helper before this initialization. " +
        "Never assume `cm` already exists in scope. " +
        "Canonical snippet: " +
        "`async () => { const cm = typeof codemode !== \"undefined\" ? codemode : arguments[0]?.codemode; await cm.openapi_search({ pathIncludes: \"/accounts/{account_id}/gateway/rules\" }); await cm.openapi_describe_operation({ method: \"GET\", path: \"/accounts/{account_id}/gateway/rules\" }); return await cm.cloudflare_request({ method: \"GET\", path: \"/accounts/{account_id}/gateway/rules\", operationPathTemplate: \"/accounts/{account_id}/gateway/rules\", account_id: \"<target_account_id>\", reduction: { select: [\"rule_id\", \"name\"], filterByPrefix: { field: \"name\", value: \"ht-gw_network-allow_3P\", caseInsensitive: true, trim: true }, compactResultCap: 50 } }); }`. " +
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
    delegationCorrelationId?: string;
    mcpMirrorToolDescriptors: Record<string, McpMirrorToolDescriptor>;
  }): Promise<void> {
    const st = this.getToolAgentDurableStorage();
    if (!st) return;
    const parent = args.delegatedParentAgentName.trim();
    if (!parent) return;
    await st.put(ToolAgentThinkFacet.MCP_MIRROR_SNAPSHOT_STORAGE_KEY, {
      v: 1 as const,
      delegatedParentAgentName: parent,
      delegationCorrelationId:
        typeof args.delegationCorrelationId === "string" ? args.delegationCorrelationId.trim() : "",
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
    const correlation =
      typeof rec.delegationCorrelationId === "string" ? rec.delegationCorrelationId.trim() : "";
    const descriptors = rec.mcpMirrorToolDescriptors;
    if (!parent || !descriptors || typeof descriptors !== "object" || Array.isArray(descriptors)) return;

    this._delegationCorrelationIdForMirror = correlation;
    this._liveMcpMirrorToolSet = buildMcpLiveMirrorToolSet({
      env: this.env,
      parentAgentName: parent,
      delegatedTaskText: this._delegatedTaskTextForMirror,
      delegationCorrelationId: this._delegationCorrelationIdForMirror,
      descriptors: descriptors as Record<string, McpMirrorToolDescriptor>,
    });
    console.log(
      `[EdgeClaw][tool-agent] mcpMirrorRehydrate source=durable_snapshot requestId=${this.requestId} ` +
        `parentAgent=${parent} mirrorToolCount=${Object.keys(this._liveMcpMirrorToolSet).length}`
    );
  }

  protected override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.restorePersistedMcpMirrorToolSetIfEmpty();

    const tools = this.getTools();
    const searchRelayName = pickWrappedToolName(tools, "search");
    const execRelayName = pickWrappedToolName(tools, "execute");

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
        // healthy path — search + execute relay both present
      }
      if (!searchRelayName || !execRelayName) {
        const setupError =
          `tool_agent_setup_failure:codemode_surface_incomplete requestId=${this.requestId} ` +
          `execution=${executionPhase} hasSearchRelay=${Boolean(searchRelayName)} hasExecuteRelay=${Boolean(execRelayName)}`;
        this._mcpMirrorSetupFailure = setupError;
        throw new Error(setupError);
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
    if (!isCodemodeWireDebugEnabled()) return;
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
    if (codemodeSurface === "ready") {
      console.log(
        `[EdgeClaw][tool-agent] codemodeSurface=ready wrappedToolCount=${wrappedToolCount} ` +
          `requestId=${this.requestId} phase=post_mcp_sync`
      );
      return;
    }
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
    /** Original delegated task text, forwarded to host boundary injection resolver for explicit identifiers. */
    delegatedTaskText?: string;
    /** Serialized mirror descriptors built from MainAgent `mcp.getAITools()` for reuse-live servers. */
    mcpMirrorToolDescriptors?: Record<string, McpMirrorToolDescriptor>;
    /** Correlation id from MainAgent for delegated task text lookup on host-boundary MCP execute. */
    delegationCorrelationId?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      this._mcpMirrorSetupFailure = undefined;
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
        if (!isCodemodeWireDebugEnabled()) break;
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
      this._delegatedTaskTextForMirror =
        typeof payload.delegatedTaskText === "string" ? payload.delegatedTaskText : "";
      this._delegationCorrelationIdForMirror =
        typeof payload.delegationCorrelationId === "string" ? payload.delegationCorrelationId.trim() : "";
      const descriptors = payload.mcpMirrorToolDescriptors ?? {};
      const reuseRows = mergedRows.filter(shouldReuseLiveMcpSdkServer);
      // Create a ToolSet-like structure from descriptor keys for resolution
      // The resolver only needs to check key existence, not actual Tool structure
      const mcpAiToolsForResolution: ToolSet = Object.fromEntries(
        Object.keys(descriptors).map((key) => [key, { description: "" }])
      ) as ToolSet;
      const descriptorIssues = findMissingMcpMirrorDescriptors({
        reuseRows,
        descriptors,
        mcpAiTools: mcpAiToolsForResolution,
      });

      this._liveMcpMirrorToolSet = buildMcpLiveMirrorToolSet({
        env: this.env,
        parentAgentName: parentName,
        delegatedTaskText: this._delegatedTaskTextForMirror,
        delegationCorrelationId: this._delegationCorrelationIdForMirror,
        descriptors,
      });

      if (reuseRows.length > 0) {
        const missingMirrorToolNames = reuseRows.flatMap((row) => {
          const sid = row.mcpSdkServerId?.trim();
          if (!sid) return [] as string[];
          // Use resolver to get expected names (which may be sanitized)
          const expected = expectedMcpMirrorToolNamesForServer({
            mcpAiTools: mcpAiToolsForResolution,
            server: row,
          });
          return expected.filter((name) => !(name in this._liveMcpMirrorToolSet));
        });
        if (
          descriptorIssues.length > 0 ||
          missingMirrorToolNames.length > 0 ||
          !this.env.MAIN_AGENT ||
          !parentName
        ) {
          const issueSummary = descriptorIssues
            .map((i) => `${i.serverName}:${i.missingToolNames.join(",")}`)
            .join(";");
          const msg =
            "tool_agent_setup_failure:mcp_live_reuse_mirror_incomplete " +
            `reuseRowCount=${reuseRows.length} hasMainAgentBinding=${Boolean(this.env.MAIN_AGENT)} ` +
            `hasParentAgentName=${Boolean(parentName)} descriptorIssueCount=${descriptorIssues.length} ` +
            `missingMirrorTools=${missingMirrorToolNames.join(",") || "none"} descriptorIssues=${issueSummary || "none"}`;
          this._mcpMirrorSetupFailure = msg;
          console.error(`[EdgeClaw][tool-agent] ${msg}`);
          return { ok: false, error: formatToolAgentMcpBootstrapError(msg) };
        }
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
        delegationCorrelationId: this._delegationCorrelationIdForMirror,
        mcpMirrorToolDescriptors: descriptors,
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[EdgeClaw][tool-agent] rpcSyncMcpConfigFromMainAgent failed:", msg);
      return { ok: false, error: formatToolAgentMcpBootstrapError(msg) };
    }
  }

  @callable()
  override async rpcCollectChatTurn(message: string): Promise<SubAgentResult> {
    this._suppressToolStreamBroadcast = true;
    const raw = typeof message === "string" ? message : "";
    let semanticFailureCount = 0;
    let lastSemanticError = "";
    let lastFailureEnvelope = undefined;
    try {
      if (this._mcpMirrorSetupFailure) {
        const errorText = this._mcpMirrorSetupFailure;
        const toolAgentResult = buildToolAgentResultEnvelope({
          ok: false,
          errorText,
          hadToolActivity: false,
        });
        return clampSubAgentResultForRpc({
          text: "",
          events: [],
          ok: false,
          error: errorText,
          toolAgentResult,
        });
      }

      const prepared = prepareToolAgentRpcIngress(this.env, raw);
      this._debugOmitSharedWorkspaceTools = prepared.omitSharedWorkspaceTools;
      this._rpcDelegationGatewayObs = prepared.delegationGatewayObs;

      // Main delegated tool orchestration loop (single turn, but can be extended for retries)
      // For now, we simulate a single pass, but enforce the repeated failure rule for future extensibility.
      const inner = await executeRpcCollectChatTurn(this, prepared.inferenceMessageTrimmed);
      const thread = this.getMessages() as UIMessage[];
      const strictChainEvidence = extractStrictChainEvidenceFromThread(thread);
      const toolSynthesisText = synthesizeAssistantTextFromToolParts(thread).trim();
      const hadToolActivity = didToolAgentRunAnyTools(thread);
      const resultForGuard = inner.text ?? "";
      const synthesisForGuard = toolSynthesisText;

      // Guard - explicit user-requested OpenAPI chain contract enforcement.
      const explicitOpenApiChainRequired = requiresExplicitOpenApiChain(prepared.inferenceMessageTrimmed);
      if (explicitOpenApiChainRequired) {
        const chainEvidenceCorpus = [synthesisForGuard, resultForGuard, inner.error]
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          .join("\n");
        // Prefer structured evidence emitted by helper tools over text scanning.
        const hasStructuredChain =
          strictChainEvidence.openapi_search?.called === true &&
          strictChainEvidence.openapi_describe_operation?.called === true &&
          strictChainEvidence.cloudflare_request?.called === true;
        const hasRequiredChain = hasStructuredChain || hasExplicitOpenApiChainEvidence(chainEvidenceCorpus);
        // Detect describe/cache failure: chain was fully followed but describe blocked cloudflare_request.
        const isDescribeCacheFailure =
          hasStructuredChain &&
          (strictChainEvidence.cloudflare_request?.errorCode === "missing_openapi_describe_same_invocation" ||
            strictChainEvidence.cloudflare_request?.errorCode === "openapi_describe_failed_same_invocation");
        const usedToolsCallCodeFallback = hasToolsCallCodeFallbackEvidence(chainEvidenceCorpus);
        const fallbackExplicitlyAllowed = allowsExplicitOpenApiChainFallback(prepared.inferenceMessageTrimmed);

        // When structured evidence proves all three chain helpers were called,
        // tools_call_code is the *vehicle* for the chain — not a fallback bypass.
        if (usedToolsCallCodeFallback && !fallbackExplicitlyAllowed && !hasStructuredChain) {
          const failureSummary =
            "Explicit OpenAPI chain was required but disallowed fallback was used: expected " +
            "openapi_search -> openapi_describe_operation -> cloudflare_request.";
          const transparentSynthesis =
            "Fallback attempted: tools_call_code/tool_*_execute (disallowed by explicit chain requirement).\n\n" +
            (toolSynthesisText || "");
          const toolAgentResult = buildToolAgentResultEnvelope({
            ok: false,
            errorText: `${failureSummary} Detected tools_call_code/tool_*_execute fallback.`,
            toolSynthesisText: transparentSynthesis || undefined,
            hadToolActivity,
          });
          return clampSubAgentResultForRpc({
            ...inner,
            ok: false,
            error: failureSummary,
            toolAgentResult,
          });
        }

        if (isDescribeCacheFailure) {
          const errorCode =
            strictChainEvidence.cloudflare_request?.errorCode ??
            "missing_openapi_describe_same_invocation";
          const failureSummary =
            "OpenAPI chain followed but describe/cache failure: cloudflare_request was blocked by " +
            `${errorCode}.`;
          const toolAgentResult = buildToolAgentResultEnvelope({
            ok: false,
            errorText: failureSummary,
            toolSynthesisText: toolSynthesisText || undefined,
            hadToolActivity,
          });
          return clampSubAgentResultForRpc({
            ...inner,
            ok: false,
            error: failureSummary,
            toolAgentResult,
          });
        }

        if (!hasRequiredChain) {
          const failureSummary =
            "Explicit OpenAPI chain was required but not followed: expected " +
            "openapi_search -> openapi_describe_operation -> cloudflare_request.";
          const transparentSynthesis =
            (usedToolsCallCodeFallback
              ? "Fallback attempted: tools_call_code/tool_*_execute (disallowed by explicit chain requirement).\n\n"
              : "No valid OpenAPI chain evidence was found in terminal execution.\n\n") +
            (toolSynthesisText || "");
          const toolAgentResult = buildToolAgentResultEnvelope({
            ok: false,
            errorText:
              `${failureSummary} ` +
              (usedToolsCallCodeFallback
                ? "Detected tools_call_code/tool_*_execute fallback."
                : "Detected missing chain evidence."),
            toolSynthesisText: transparentSynthesis || undefined,
            hadToolActivity,
          });
          return clampSubAgentResultForRpc({
            ...inner,
            ok: false,
            error: failureSummary,
            toolAgentResult,
          });
        }
      }

      // ── Guard 0: SUCCESS-AWARE finalization (must run first) ───────────────
      // Check if ANY tool call succeeded with usable data, even if earlier calls failed.
      // This prevents old exploratory errors from overriding later successful API calls.
      const successAware = finalizeSuccessAware({
        synthesisText: toolSynthesisText,
        resultText: resultForGuard,
        errorText: inner.error || "",
        hadToolActivity,
      });

      console.warn(JSON.stringify({
        marker: "[EdgeClaw][finalize-success-aware]",
        shouldBeSuccess: successAware.shouldBeSuccess,
        where: successAware.where ?? null,
        hasExtractedResult: !!successAware.extractedResult,
        extractedResultLen: successAware.extractedResult?.length ?? 0,
        scannedCount: successAware.scannedCount ?? null,
        matchedCount: successAware.matchedCount ?? null,
        matchedLen: successAware.matched?.length ?? 0,
        warningCount: successAware.warnings.length,
        innerOk: inner.ok,
        innerTextLen: inner.text?.length ?? 0,
        resultForGuardLen: resultForGuard.length,
        synthesisLen: toolSynthesisText.length,
      }));

      if (successAware.shouldBeSuccess) {
        console.log(
          `[EdgeClaw][tool-agent] success_aware_override ` +
            `where=${successAware.where} warnings=${successAware.warnings.length} requestId=${this.requestId}`
        );

        // Extract and apply fallback extraction if needed
        let finalResultText = successAware.extractedResult || resultForGuard;
        let scannedCount = successAware.scannedCount;
        let matchedCount = successAware.matchedCount;
        const matched = successAware.matched;

        const hasCompactReducedTerminalData =
          typeof scannedCount === "number" &&
          typeof matchedCount === "number" &&
          Array.isArray(matched);

        if (hasCompactReducedTerminalData && !finalResultText) {
          finalResultText = JSON.stringify(
            {
              scannedCount,
              matchedCount,
              matched,
            },
            null,
            2
          );
        }

        // If result is still very large, apply clamping
        if (finalResultText && finalResultText.length > MAX_FINAL_RESPONSE_CHARS) {
          const clamped =
            finalResultText.slice(0, MAX_FINAL_RESPONSE_CHARS) +
            "\n\n[… result truncated at inline limit; request artifact for full access]";
          finalResultText = clamped;
        }

        // Build success envelope with warnings about earlier errors
        const toolAgentResult = buildToolAgentResultEnvelope({
          ok: true,
          resultText: finalResultText || undefined,
          toolSynthesisText: (successAware.warnings.length > 0
            ? `Warnings: ${successAware.warnings.join("; ")}\n\n${toolSynthesisText}`
            : toolSynthesisText) || undefined,
          hadToolActivity,
          scannedCount,
          matchedCount,
          matched,
        });

        return clampSubAgentResultForRpc({
          ...inner,
          ok: true,
          text: finalResultText || toolSynthesisText,
          toolAgentResult,
        });
      }

      // ── Guard 1: root-cause semantic failure detection (after success-aware) ─
      // Scans error text, final result text, AND tool synthesis for semantic root causes.
      // Detects repeated same-key failures in tool synthesis (e.g. account_id tried twice).
      // This guard only applies when there is no terminal successful compact result.
      const fullEvidenceCorpus = [inner.error, resultForGuard, synthesisForGuard].filter(Boolean).join("\n");
      const rootCauseKey = normalizeSemanticErrorKey(fullEvidenceCorpus);
      const repeatedSemanticFailure = rootCauseKey !== null &&
        countSemanticKeyInSynthesis(synthesisForGuard, rootCauseKey) >= 2;

      const rootCause = detectRootCauseSemanticFailure(inner.error || "", synthesisForGuard || resultForGuard);
      if (rootCause.detected || repeatedSemanticFailure) {
        const failureKey = rootCauseKey ?? rootCause.failureType ?? "tool_error";
        const reason = repeatedSemanticFailure
          ? `Repeated semantic failure (${rootCauseKey}); stopped after 2 identical errors`
          : rootCause.reason ?? "Semantic root cause detected";
        console.log(
          `[EdgeClaw][tool-agent] root_cause_semantic_failure detected ` +
            `type=${failureKey} repeated=${repeatedSemanticFailure} semanticKey=${rootCauseKey ?? "none"} ` +
            `reason=${reason} requestId=${this.requestId}`
        );
        // Use the full evidence corpus so classifier picks up semantic error from synthesis
        const toolAgentResult = buildToolAgentResultEnvelope({
          ok: false,
          errorText: fullEvidenceCorpus.slice(0, 4000),
          toolSynthesisText: synthesisForGuard.slice(0, 2000),
          hadToolActivity,
        });
        return clampSubAgentResultForRpc({
          ...inner,
          ok: false,
          error: reason,
          toolAgentResult,
        });
      }

      // ── Guard 2: nested failure detection ──────────────────────────────────
      // Treat outer ok=true with nested result.ok=false / embedded error as failure.
      function hasNestedFailure(obj: any): boolean {
        if (!obj || typeof obj !== "object") return false;
        if (obj.ok === false) return true;
        if (typeof obj.error === "string" && obj.error.length > 0) return true;
        for (const k of Object.keys(obj)) {
          if (k === "ok" || k === "error") continue;
          const v = obj[k];
          if (typeof v === "object" && v !== null && hasNestedFailure(v)) return true;
        }
        return false;
      }

      let semanticError = inner.error || "";
      if (!inner.ok || hasNestedFailure(inner)) {
        semanticFailureCount++;
        lastSemanticError = semanticError;
      }

      // ── Guard 3: MAP/FILTER/REDUCE transformation pipeline ──────────────────
      // Primary compute layer: use reduction pipeline for data transformation.
      // Only return raw results if transformation is not needed.
      let toolAgentResult: any;
      
      if (inner.ok && hadToolActivity && resultForGuard.length > 0) {
        // Apply reduction pipeline to transform large/structured data
        const reductionResult = await applyReductionPipeline({
          toolResult: resultForGuard,
          userRequest: prepared.inferenceMessageTrimmed,
          hadToolActivity,
          availableTools: this.getTools(),
          codemodeToolName: pickWrappedToolName(this.getTools(), "execute"),
        });

        if (reductionResult.transformed) {
          console.log(
            `[EdgeClaw][tool-agent] reduction_pipeline transformed ` +
              `scannedCount=${reductionResult.scannedCount} matchedCount=${reductionResult.matchedCount} requestId=${this.requestId}`
          );
          
          // Transformation succeeded — return success with metadata
          toolAgentResult = buildLargeResultEnvelope({
            extractionSucceeded: true,
            partialResultText: reductionResult.compactText,
            scannedCount: reductionResult.scannedCount,
            matchedCount: reductionResult.matchedCount,
            artifactPointer: reductionResult.artifactPointer,
            evidenceText: reductionResult.evidenceText,
            where: "reduction_pipeline",
          });
        } else if (reductionResult.failureReason) {
          console.log(
            `[EdgeClaw][tool-agent] reduction_pipeline fallback ` +
              `reason=${reductionResult.failureReason.slice(0, 100)} requestId=${this.requestId}`
          );
          
          // Transformation failed — classify as large_result with pagination retry prompt
          toolAgentResult = buildLargeResultEnvelope({
            extractionSucceeded: false,
            evidenceText: reductionResult.evidenceText,
            partialResultText: toolSynthesisText || undefined,
            where: "reduction_pipeline",
          });
        } else {
          // No transformation needed — return as-is (success path)
          const clampedText =
            (inner.text?.length ?? 0) > MAX_FINAL_RESPONSE_CHARS
              ? inner.text!.slice(0, MAX_FINAL_RESPONSE_CHARS) +
                "\n\n[… result truncated at inline limit]"
              : inner.text;

          toolAgentResult = buildToolAgentResultEnvelope({
            ok: true,
            resultText: clampedText ?? undefined,
            toolSynthesisText,
            hadToolActivity,
          });
        }
      } else {
        // ── No transformation needed: error path or small payload ───────────
        const clampedText =
          inner.ok && (inner.text?.length ?? 0) > MAX_FINAL_RESPONSE_CHARS
            ? inner.text!.slice(0, MAX_FINAL_RESPONSE_CHARS) +
              "\n\n[… result truncated at inline limit]"
            : inner.text;

        // Always build a normalized envelope
        toolAgentResult = buildToolAgentResultEnvelope({
          ok: inner.ok,
          resultText: clampedText ?? undefined,
          errorText: inner.error,
          toolSynthesisText,
          hadToolActivity,
          couldBeReductionFailure: false,
        });
      }

      lastFailureEnvelope = toolAgentResult;

      // ── No silent success: tool activity + no useful resultText = failure ───
      // ok=true with empty resultText after tool activity is a silent completion
      // that provides no value. Convert to failure so MainAgent always gets a
      // visible structured message rather than a confusing empty success.
      if (
        toolAgentResult.ok === true &&
        hadToolActivity &&
        !(
          typeof (toolAgentResult as any).matchedCount === "number" &&
          (toolAgentResult as any).matchedCount > 0
        ) &&
        !(toolAgentResult as any).resultText?.trim()
      ) {
        console.log(
          `[EdgeClaw][tool-agent] no_silent_success hadToolActivity=${hadToolActivity} empty_resultText=true requestId=${this.requestId}`
        );
        toolAgentResult = buildToolAgentResultEnvelope({
          ok: false,
          errorText: "",
          toolSynthesisText: toolSynthesisText || undefined,
          hadToolActivity,
          whereHint: "finalization",
        });
      }

      // Never return an empty final response after tool activity
      if (!toolAgentResult.ok && !toolAgentResult.failure) {
        toolAgentResult = {
          ok: false,
          failure: {
            type: "unknown",
            summary: "ToolAgent failed but did not return a recognized error pattern.",
            evidence: semanticError || "Unknown error",
            suggestedFix: "Retry with explicit required inputs and a narrower scope.",
            suggestedRetryPrompt: "Retry delegated tool task with explicit required inputs and a narrower scope.",
          },
          ...(toolSynthesisText ? { partialResultText: toolSynthesisText } : {}),
        };
      }

      // If the same semantic error occurs twice, stop — do not keep exploring adjacent tools.
      if (semanticFailureCount > 1) {
        return clampSubAgentResultForRpc({
          ...inner,
          ok: false,
          error: lastSemanticError,
          toolAgentResult: lastFailureEnvelope,
        });
      }

      const result = clampSubAgentResultForRpc({
        ...inner,
        toolAgentResult,
      });
      console.warn(JSON.stringify({
        marker: "[EdgeClaw][rpcCollectChatTurn-terminal]",
        resultOk: result.ok,
        resultTextLen: result.text?.length ?? 0,
        hasToolAgentResult: !!result.toolAgentResult,
        toolAgentResultOk: result.toolAgentResult?.ok ?? null,
        hasMatchedCount: typeof result.toolAgentResult?.matchedCount === "number",
        matchedCount: result.toolAgentResult?.matchedCount ?? null,
        hasResultText: !!result.toolAgentResult?.resultText,
        resultTextPreview: result.text?.slice(0, 200) ?? "",
      }));
      console.log(
        `[EdgeClaw][tool-agent] rpcCollectChatTurn terminal ok=${result.ok} requestId=${this.requestId}`
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[EdgeClaw][subagent-facet] ${this.constructor.name}.rpcCollectChatTurn failed`,
        msg
      );
      console.log(`[EdgeClaw][tool-agent] rpcCollectChatTurn terminal ok=false requestId=${this.requestId}`);
      return clampSubAgentResultForRpc({
        text: "",
        events: [],
        ok: false,
        error: msg,
        toolAgentResult: buildToolAgentResultEnvelope({
          ok: false,
          errorText: msg,
          hadToolActivity: false,
        }),
      });
    } finally {
      this._suppressToolStreamBroadcast = false;
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
