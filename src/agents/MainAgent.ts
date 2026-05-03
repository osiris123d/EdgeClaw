/**
 * Main Agent
 * Root agent that extends Think and orchestrates all functionality
 *
 * Features:
 * - Flexible model orchestration via ModelRouter
 * - Dynamic per-task model selection
 * - Support for multiple providers (Workers AI, AI Gateway)
 * - Tool management and approval
 * - Session and memory management
 * - Lifecycle hooks for extensibility
 *
 * Usage:
 *   const agent = new MainAgent(env);
 *   agent.setModelRouter(customRouter);
 *   const selection = await agent.selectModel(context);
 */

import { DEFAULT_AURA_TTS_SPEAKER, parseAuraTtsSpeaker, type AuraTtsSpeaker } from "../lib/auraTts";
import { Env } from "../lib/env";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type TextSource,
  type Transcriber,
  type VoiceTurnContext,
  type WorkersAIFluxSTTOptions,
} from "@cloudflare/voice";
import type { Connection } from "agents";
import { generateText, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import {
  ModelConfig,
  ModelContext,
  ModelSelectionResult,
  IModelRouter,
  LanguageModel,
  RouteClass,
  TaskType,
  EstimatedComplexity,
  LatencySensitivity,
  CostSensitivity,
  createStandardRouter,
  resolveLanguageModel,
} from "../models";
import {
  createAgentTools,
  defaultApprovalEvaluator,
  type WorkspaceLike,
  type TaskToolAdapter,
} from "../tools";
import { createCodeExecutionTool } from "../tools/execute";
import { createAgentBrowserTools } from "../tools/browser";
import { createBrowserSessionTool } from "../tools/browserSession";
import { BrowserSessionManager } from "../browserSession/BrowserSessionManager";
import {
  createBrowserSessionProvider,
  createCloudflareBrowserSessionProvider,
  type BrowserSessionProvider,
} from "../browserSession/providerAdapter";
import { resolveBrowserRunAuth } from "../browserSession/cloudflareBrowserRunApi";
import type { Workspace } from "@cloudflare/shell";
import {
  Think,
  type Session,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type StreamCallback,
} from "@cloudflare/think";
/** Mixin: WebSocket voice + STT/TTS on top of Think. */
// eslint-disable-next-line @typescript-eslint/naming-convention
const BaseThinkWithVoice = withVoice(Think);
import type { ContextBlock } from "agents/experimental/memory/session";
import { callable, __DO_NOT_USE_WILL_BREAK__agentContext } from "agents";
import { executeRpcCollectChatTurn } from "./subagents/rpcCollectChatTurnShared";
import { SkillStore } from "../skills/SkillStore";
import type {
  SkillDocument,
  SkillSummary,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
} from "../skills/types";
import { hasSkillsBucket } from "../lib/env";
import { handleMemoryRoute, type MemoryRouteAdapter } from "../api/memoryRoutes";
import {
  handleMcpRoute,
  type McpRouteAdapter,
} from "../api/mcpRoutes";
import {
  handleTaskRoute,
  type TaskRouteAdapter,
} from "../api/tasksRoutes";
import {
  handleSkillRoute,
  type SkillRouteAdapter,
} from "../api/skillsRoutes";
import {
  handleWorkflowRoute,
  type WorkflowRouteAdapter,
} from "../api/workflowsRoutes";
import { ORCHESTRATION_DEBUG_SHARED_PROJECT_ID } from "../debug/orchestrationDebugProjectId";
import {
  loadReadyControlPlaneProjectBlueprint,
  assertTaskRunnableForProject,
  OrchestrationBlueprintError,
  type ProjectBlueprintContextPackage,
} from "../coordinatorControlPlane/projectBlueprintOrchestrationContext";
import {
  getTaskById,
  beginTaskBackedDebugOrchestrationRun,
  finalizeTaskBackedDebugOrchestrationRun,
  abortTaskBackedDebugOrchestrationRun,
  appendFollowUpCoordinatorTasksAfterRun,
  patchCoordinatorRun,
  updateTask,
} from "../coordinatorControlPlane/coordinatorControlPlaneStore";
import {
  pickNextRunnableTaskForProject,
  type PickRunnableTaskFailureReason,
} from "../coordinatorControlPlane/coordinatorRunnableTaskSelection";
import { handleProjectAutonomyDoRequest } from "../debug/debugProjectAutonomyHttp";
import type { ProjectAutonomyScenarioInput } from "../debug/projectAutonomyHttp.shared";
import type {
  ProjectAutonomyScenarioResult,
  ProjectAutonomyStepRecord,
  ProjectAutonomyStopReason,
} from "../debug/projectAutonomyTypes";
import {
  handleDebugOrchestrateDoRequest,
  type DebugOrchestrationMode,
  type DebugOrchestrationRunOptions,
  type DebugOrchestrationScenarioOutcome,
  formatDebugOrchestrationResponseBody,
  parseDebugOrchestrationMode,
  parseDebugChildTurnMode,
  parseDebugDisableSharedTools,
  parseDebugOrchestrationSessionId,
  buildDebugOrchestrationManagerTask,
} from "../debug/debugOrchestrationHttp";
import { handleDebugDelegatedPingDoRequest } from "../debug/debugDelegatedPingHttp";
import { handleDebugCoordinatorChainDoRequest } from "../debug/debugCoordinatorChainHttp";
import {
  isDebugOrchestrationEnvEnabled,
  debugOrchestrationSecretMatches,
} from "../debug/debugOrchestrationWorkerGate";
import { DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX } from "../debug/debugChildDelegationPrefix";
import {
  invokeCoordinatorCodingLoop,
  invokeCoordinatorDelegateCoder,
  invokeCoordinatorDelegateTester,
  sanitizeCoordinatorInstanceName,
} from "./coordinator/invokeSubagentCoordinatorHttp";
import { orchestrationResultIndicatesDeployReset } from "./codingLoop/codingLoopTransientErrors";
import {
  handleVoiceRoute,
  type VoiceRouteAdapter,
  type VoiceFluxSttRequestBody,
} from "../api/voiceRoutes";
import {
  rowToDefinition,
  rowToRun,
  isActiveRunStatus,
  isTerminalRunStatus,
  type WorkflowRunStatus,
  type PersistedWorkflowDefinition,
  type PersistedWorkflowRun,
  type CreateWorkflowDefinitionInput,
  type UpdateWorkflowDefinitionInput,
  type WfDefRow,
  type WfRunRow,
} from "../lib/workflowPersistence";
import {
  readTasksFromConfig,
  normalizeStoredTask,
  type PersistedTask,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "../lib/taskPersistence";
import {
  buildScheduleInstruction,
  estimateNextRunAt,
  nextRunAtAfterFire,
  type SchedulingAgent,
} from "../lib/taskScheduler";
import {
  buildDiscoverySnapshot,
  migratePersistedMcpServer,
  type McpDiscoverySnapshot,
  type McpTransport,
  type PersistedMcpServer,
  type PersistedMcpServerSafe,
  type RawSdkMcpState,
  type ServerRuntimeCache,
  EMPTY_RAW_SDK_STATE,
} from "../lib/mcpDiscovery";
import { createObservability, type Observability } from "../lib/observability";
import { buildModelBindingsForAiGateway } from "../lib/agentObservability";
import { getRuntimeConfig } from "../lib/env";
import {
  configureSession as applySessionConfiguration,
  buildSoulPrompt,
  type SessionConfigurationOptions,
} from "../session/configureSession";
import {
  HookRegistry,
  HookType,
  HookContext,
  AgentHooks,
  createAgentHooks,
  type TurnContext,
  type TurnConfig,
  type ToolCallContext,
  type ToolCallDecision,
  type ToolCallResultContext,
  type StepContext,
  type ChunkContext,
  type ChatResponseResult,
} from "../hooks";
import { truncateMessageForSubagentRpcInbound, type DelegationOptions, type SubAgentResult } from "./delegation";
import { createVoiceService, type VoiceService } from "../voice/VoiceService";
import { formatSharedDelegationEnvelope } from "../workspace/delegationEnvelope";
import { getSharedWorkspaceGateway } from "../workspace/sharedWorkspaceFactory";
import { createSharedWorkspaceToolSet } from "../workspace/sharedWorkspaceTools";
import { createNoopGitExecutionAdapter } from "../repo/gitExecutionAdapter";
import { createGitIntegrationToolSet, isGitIntegrationToolsEnabled } from "../repo/gitIntegrationTools";
import type { AgentTurnContext } from "./agentTurnContext";
export type { AgentTurnContext } from "./agentTurnContext";
import { runCodingCollaborationLoop } from "./codingLoop/runCodingCollaborationLoop";
import type {
  CodingCollaborationLoopInput,
  CodingCollaborationLoopResult,
} from "./codingLoop/codingLoopTypes";
import {
  derivePromotionCandidateFromCodingLoop as derivePromotionCandidateFromCodingLoopCore,
  type PromotionCandidateFromLoopResult,
} from "./codingLoop/promotionFromCodingLoop";
import { resolveArtifactPromotionWriter } from "../promotion/artifactPromotionWriterFactory";
import { resolveFlagshipEvaluationAdapter } from "../promotion/flagshipEvaluationAdapterFactory";
import type {
  ArtifactPromotionWriter,
  PromotionArtifactManifest,
  PromotionArtifactRef,
} from "../promotion/artifactPromotionTypes";
import type {
  FlagshipEvaluationAdapter,
  ReleaseGateDecision,
  ReleaseTier,
} from "../promotion/flagshipTypes";
import {
  buildPromotionManifestFromApprovedPatches,
  type PrepareApprovedPromotionResult,
} from "../promotion/promotionOrchestration";
import { evaluatePromotionReleaseGate } from "../promotion/orchestratorReleaseGate";
import {
  runPreviewPromotionPipeline,
  type PreviewPromotionPipelineInput,
  type PreviewPromotionPipelineResult,
} from "../promotion/orchestratorPreviewPromotionPipeline";
import { resolvePreviewDeployAdapter } from "../deploy/previewDeployAdapterFactory";
import type { PreviewDeployAdapter, PreviewDeployRequest, PreviewDeployResult } from "../deploy/previewDeployTypes";
import { runPreviewDeployment } from "../deploy/orchestratorPreviewDeploy";
import { resolveProductionDeployAdapter } from "../deploy/productionDeployAdapterFactory";
import type {
  ProductionDeployAdapter,
  ProductionDeployRequest,
  ProductionDeployResult,
} from "../deploy/productionDeployTypes";
import { runProductionDeployment } from "../deploy/orchestratorProductionDeploy";
import {
  BROWSER_TOOLS_FALLBACK_RESPONSE,
  buildBrowserCapabilityAuditSnapshot,
  buildBrowserDisabledWarningLine,
  createDeterministicTextModel,
  decideBrowserRequestGuard,
  isBrowserIntentRequest,
  parseBooleanFlag,
  shouldIncludeBrowserTools,
} from "./browserToolAvailability";
import { isExplicitBrowserSessionStructuredUserMessage } from "./browserSessionUserMessageMerge";
import { assertOrchestratorPromotionBoundary } from "./orchestratorPromotionBoundary";

/**
 * Options forwarded to Think's `addMcpServer` for URL-based MCP connections.
 *
 * CF_Truth only supports HTTP-based transports — all MCP servers are reached
 * via an https:// URL.  Cloudflare's binding/RPC transport (used for direct
 * worker-to-worker MCP without a URL) is intentionally absent because no
 * McpBinding is declared in wrangler.jsonc.
 */
export interface McpServerOptions {
  /** Custom transport headers forwarded on every SDK request (e.g. Authorization: Bearer). */
  headers?: Record<string, string>;
  /**
   * MCP transport protocol.
   *
   *   "streamable-http" — Recommended.  Stateful HTTP/SSE, OAuth-capable.
   *                        Default for all remotely-added servers.
   *   "sse"             — Legacy.  Plain HTTP GET SSE.  Use only when the
   *                        target server does not support streamable-http.
   *   "auto"            — SDK auto-detect (tries streamable-http, falls back
   *                        to sse).  Kept for backward compatibility with
   *                        persisted configs; not recommended for new servers.
   *
   * When omitted, defaults to "streamable-http".
   */
  transport?: "sse" | "streamable-http" | "auto";
  /**
   * Explicit origin for the OAuth callback URL.
   * The SDK auto-derives this from the incoming request when omitted.
   * Provide this when calling addServer from a context without an active request
   * (e.g. custom callback routing, multi-domain setups).
   * @example "https://my-worker.workers.dev"
   */
  callbackHost?: string;
}

/** Shape returned by the SDK's addMcpServer() and our addServer() wrapper. */
export interface McpAddServerResult {
  /** SDK-internal server ID. */
  id: string;
  /**
   * "ready"          — connected, tools discovered, immediately usable.
   * "authenticating" — server requires OAuth; user must visit authUrl.
   */
  state: "ready" | "authenticating";
  /**
   * OAuth authorization URL. Only present when state === "authenticating".
   * Return this to the frontend so it can open a popup.
   * Never expose tokens; auth state is managed entirely server-side by the SDK.
   */
  authUrl?: string;
}

/**
 * Main Agent configuration
 * Can be passed to constructor for customization
 */
export interface MainAgentConfig {
  /**
   * Controls how long Think waits for MCP servers to connect before starting inference.
   *
   * - `true`  — wait up to the SDK default (10 s).
   * - `false` — do not wait (tools absent if servers haven't connected yet).
   * - `{ timeout: number }` — wait up to the specified milliseconds.
   *   Use a lower value (e.g. 5000) if startup latency is a concern.
   *
   * Defaults to `true` so the first turn always sees MCP tools.
   * Set to `false` or a short timeout only if startup latency outweighs tooling completeness.
   */
  waitForMcpConnections?: boolean | { timeout: number };

  /** Enable chat recovery from persistent state */
  chatRecovery?: boolean;

  /**
   * Enable browser tools (browser_search, browser_execute).
   * Requires BROWSER and LOADER bindings to be configured in wrangler.jsonc.
   * Defaults to true — tools are silently omitted when bindings are absent.
   */
  enableBrowserTools?: boolean;

  /**
   * Enable the sandboxed `execute` code tool.
   * Requires the LOADER binding to be configured in wrangler.jsonc.
   * Defaults to true — tool is silently omitted when the binding is absent.
   */
  enableCodeExecution?: boolean;

  /** Custom model router; if not provided, uses standard router */
  modelRouter?: IModelRouter;

  /** Request ID for tracing (optional) */
  requestId?: string;

  /** Enable MCP integration for this agent instance. */
  enableMcp?: boolean;

  /** Enable voice placeholder integration for this agent instance. */
  enableVoice?: boolean;

  /** Optional provider-backed browser session adapter. */
  browserSessionProvider?: BrowserSessionProvider;
}

/**
 * Build a saveMessages() prompt for a workflow completion event.
 *
 * Returns a role:"user" prompt that includes all result data so the model
 * can present the findings in a clean, conversational way.  Detects the
 * result shape (PageIntelResult, ResearchResult, generic) and tailors the
 * prompt accordingly.
 */
function buildWorkflowCompletePrompt(
  label:   string,
  shortId: string,
  result:  unknown,
): string {
  const base = `[Workflow notification] "${label}" (run \`${shortId}…\`) has completed. Present the results below to the user in a clean, polished way — use headings and bullet points as appropriate.\n\n`;
  const header = `✅ **${label} — Complete** (run \`${shortId}…\`)`;

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;

    // ── PageIntelResult shape ─────────────────────────────────────────────────
    if (typeof r.url === "string" && typeof r.reportText === "string") {
      const title    = typeof r.title   === "string" ? r.title   : r.url;
      const summary  = typeof r.summary === "string" ? r.summary : "";
      const insights = Array.isArray(r.insights)
        ? (r.insights as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const savedKey   = typeof r.savedKey === "string" ? r.savedKey : null;
      // Truncate so the card stays readable; full report is in R2.
      const reportSnip = (r.reportText as string).slice(0, 1_500);

      const insightLines = insights.length
        ? insights.map((s, i) => `${i + 1}. ${s}`).join("\n")
        : "_No key insights extracted._";

      return base + [
        header,
        ``,
        `**Page:** ${r.url}`,
        `**Title:** ${title}`,
        ``,
        `**Summary:**`,
        summary || "_No summary available._",
        ``,
        `**Key Insights:**`,
        insightLines,
        ``,
        `**Report:**`,
        reportSnip,
        reportSnip.length >= 1_500 ? "_…(truncated — full report saved to R2)_" : "",
        savedKey ? `\n**Saved to R2:** \`${savedKey}\`` : "",
      ].filter((l) => l !== "").join("\n");
    }

    // ── ResearchResult shape ──────────────────────────────────────────────────
    if (typeof r.topic === "string" && typeof r.summary === "string") {
      const insights  = Array.isArray(r.insights)
        ? (r.insights as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const savedKey  = typeof r.savedKey === "string" ? r.savedKey : null;
      const reportSnip = typeof r.reportText === "string"
        ? (r.reportText as string).slice(0, 1_500)
        : "";

      const insightLines = insights.length
        ? insights.map((s, i) => `${i + 1}. ${s}`).join("\n")
        : "_No key insights extracted._";

      return base + [
        header,
        ``,
        `**Topic:** ${r.topic}`,
        ``,
        `**Summary:**`,
        r.summary || "_No summary available._",
        ``,
        `**Key Insights:**`,
        insightLines,
        reportSnip ? `\n**Report:**\n${reportSnip}` : "",
        reportSnip.length >= 1_500 ? "_…(truncated — full report saved to R2)_" : "",
        savedKey ? `\n**Saved to R2:** \`${savedKey}\`` : "",
      ].filter((l) => l !== "").join("\n");
    }

    // ── Generic object result ─────────────────────────────────────────────────
    try {
      const json = JSON.stringify(r, null, 2).slice(0, 1_200);
      return `${base}${header}\n\n\`\`\`json\n${json}\n\`\`\``;
    } catch { /* ignore */ }
  }

  return `${base}${header}\n\nThe workflow completed successfully.`;
}

/** Last assistant text after a Think `saveMessages` turn — for voice TTS. */
function voiceLastAssistantPlainText(msgs: UIMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== "assistant") continue;
    return voiceExtractTextFromUiMessage(msgs[i]!);
  }
  return "";
}

function voiceExtractTextFromUiMessage(msg: UIMessage): string {
  const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (Array.isArray(parts) && parts.length > 0) {
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  const content = (msg as unknown as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  return "";
}

/**
 * Shapes assistant markdown into short, speakable text for TTS only.
 * Think message parts / streaming / UI are unchanged; only strings passed to
 * `speak()` or returned from `onTurn` for synthesis should go through this.
 *
 * @example
 * A markdown table:
 *   | Item   | Qty |
 *   |--------|-----|
 *   | Apples | 3   |
 * Might become: "A table in chat lists Item and Qty, with the full row data
 * in the chat. For example, Apples, quantity 3."
 */
function deriveSpokenText(markdown: string): string {
  if (!markdown || !markdown.trim()) {
    return "";
  }

  let s = markdown;

  // Fenced code: do not read source verbatim; point user to the chat.
  s = s.replace(
    /```[\w-]*\n?[\s\S]*?```/g,
    " A code or configuration block is shown in the chat. "
  );

  // Pipe tables: summarize once; do not read pipes, dashes, or cell borders.
  s = replaceGfmLikeTables(s);

  // Atx headings → plain
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*([*_-]{3,})\s*$/gm, " ");

  // Link text only
  s = s.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*]/g, "$1");

  // Bold / italic (simple pairs)
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");

  // Single-line `inline code` → speak words without backticks
  s = s.replace(/`([^`]+)`/g, "$1");

  // List compression: if more than 5 bulleted/numbered items, keep gist
  s = compressListSections(s);

  s = s.replace(/^\s*[-*+]\s+/gm, "· ");
  s = s.replace(/^\s*(\d+)\.\s+/gm, "$1: ");

  // Whitespace
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, ". ");
  s = s.replace(/\n/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  s = capSentences(s, 3, 500);

  if (s) {
    return s;
  }
  // Fallback: rough strip, no pipes-heavy reading
  const fallback = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|/g, " ")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return capSentences(fallback.slice(0, 600), 2, 400);
}

/** Replace the first GFM-style pipe table in `s` with a spoken line; repeat. */
function replaceGfmLikeTables(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && isMarkdownTableSeparator(next)) {
      const header = line
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && !/^[-:]+$/.test(c));
      let j = i + 2;
      const sampleCells: string[] = [];
      while (j < lines.length && (lines[j] ?? "").includes("|")) {
        const row = (lines[j] ?? "")
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && !/^[-:]+$/.test(c));
        if (row.length) {
          sampleCells.push(row.slice(0, 3).join(", "));
        }
        if (sampleCells.length >= 2) {
          break;
        }
        j += 1;
      }
      while (j < lines.length && (lines[j] ?? "").includes("|") && (lines[j] ?? "").trim().length > 0) {
        j += 1;
      }
      const colHint = header.slice(0, 4).join(", ");
      const rowHint = sampleCells.length
        ? ` For example: ${sampleCells[0]!}.`
        : "";
      out.push(
        `A table in the chat has columns like ${colHint || "the headers shown"}.${rowHint} Full data is in the chat.`
      );
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*(:?-+:?\s*\|)+\s*:?\s*\-*\s*\|?\s*$/.test(line) && line.includes("-");
}

/** If more than 5 consecutive list lines, keep a short spoken gist. */
function compressListSections(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isBullet = /^\s*[-*+]\s+/.test(lines[i] ?? "") || /^\s*\d+\.\s+/.test(lines[i] ?? "");
    if (!isBullet) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    const start = i;
    while (
      i < lines.length &&
      (/^\s*[-*+]\s+/.test(lines[i] ?? "") || /^\s*\d+\.\s+/.test(lines[i] ?? ""))
    ) {
      i += 1;
    }
    const block = lines.slice(start, i);
    if (block.length <= 5) {
      out.push(...block);
    } else {
      const first3 = block
        .slice(0, 3)
        .map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, "").trim());
      out.push(
        ` ${first3.join(" · ")}. Plus ${
          block.length - 3
        } more list items are in the chat. `
      );
    }
  }
  return out.join("\n");
}

function capSentences(text: string, maxSents: number, maxChars: number): string {
  if (!text) {
    return text;
  }
  const m = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!m) {
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
  }
  const joined = m
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, maxSents)
    .join(" ")
    .trim();
  if (joined.length > maxChars) {
    return `${joined.slice(0, maxChars).trimEnd()}…`;
  }
  return joined;
}

/** @cf/deepgram/flux `eot_threshold` — see WorkersAIFluxSTTOptions. */
function clampVoiceFluxEot(n: number): number {
  return Math.min(0.9, Math.max(0.5, n));
}

/** @cf/deepgram/flux `eot_timeout_ms` — public docs: 500–10_000 ms. */
function clampVoiceFluxEotTimeoutMs(n: number): number {
  return Math.min(10_000, Math.max(500, Math.round(n)));
}

/** Eager EOT; SDK range 0.3–0.9; capped ≤ main EOT in getFluxSttOptions. */
function clampVoiceFluxEager(n: number): number {
  return Math.min(0.9, Math.max(0.3, n));
}

/** Durable Object `ctx.storage` key for the chosen aura-1 speaker (survives hibernation). */
const EDGECLAW_AURA_TTS_SPEAKER_STORAGE_KEY = "edgeclaw.auraTtsSpeaker.v1";

/**
 * Main agent: Think + @cloudflare/voice full pipeline (STT, onTurn, TTS).
 * Voice is gated by `enableVoice` and `beforeCallStart`; text chat is unchanged.
 */
export class MainAgent extends BaseThinkWithVoice {
  /** Narrow Think/Workers `env` to our bindings — `Cloudflare.Env` omits `Variables`, DO bindings, etc. */
  protected declare env: Env;

  // ── Think MCP integration ──────────────────────────────────────────────────
  //
  // HOW MCP TOOLS ENTER THE TOOL PIPELINE
  // ──────────────────────────────────────
  // Think manages two independent tool sources per chat turn:
  //
  //   1. getTools()              → agent-defined tools (base, browser, code exec)
  //   2. getMcpServers().tools   → tools auto-discovered from connected MCP servers
  //
  // Think merges both sets internally and passes the combined ToolSet to the AI
  // inference call. MainAgent.getTools() does NOT need to include or iterate MCP
  // tools — they are contributed entirely through the SDK's addMcpServer() path.
  //
  // WHY waitForMcpConnections = true
  // ──────────────────────────────────
  // Without this flag, inference could start before MCP servers finish their
  // capability-discovery handshake, meaning the AI would see zero MCP tools even
  // though servers are configured. With it set to true, Think waits for every
  // connected server to reach "ready" (or times out) before assembling the tool
  // set for the turn. The effective timeout is Think's default (10 s). If a
  // server does not connect in time, Think continues with whatever tools are
  // available — it does not throw or cancel the turn.
  //
  // HOW SERVER DISCOVERY METADATA IS EXPOSED TO THE UI
  // ─────────────────────────────────────────────────────
  // mcpGetState() → buildDiscoverySnapshot() reads getMcpServers() (live SDK state)
  // and merges it with the persisted server list from configure()/getConfig().
  // The snapshot is served by handleMcpRoute() at GET /mcp and returned from every
  // mcpAddServer / mcpRemoveServer / mcpReconnectServer mutating call.
  // Tokens are never included. The _debug.rawSdkState and _debug.rawCapabilities
  // fields carry the raw SDK strings for observability without model inference risk.
  //
  // HOW FAILURES ARE SURFACED WITHOUT BREAKING CHAT
  // ─────────────────────────────────────────────────
  // Think's behaviour when an MCP server fails or times out:
  //   • The server is marked "failed" or stays "connecting" in getMcpServers().
  //   • Its tools are simply absent from the merged ToolSet for that turn.
  //   • No exception propagates to the chat flow — inference runs with fewer tools.
  //   • The discovery snapshot reflects the failure in server.state and server.error.
  //   • The UI reads the snapshot and shows the server's state badge (failed/offline).
  //   • mcpReconnectServer() can be called at any time to retry without restarting.
  //
  // DEGRADATION MODEL (per server, independent):
  //   ready       → tools available, included in every turn
  //   degraded    → connected but server returned no items; chat unaffected
  //   connecting  → still handshaking; tools absent this turn, may appear next turn
  //   authenticating → needs OAuth; tools absent until user completes the flow
  //   failed/offline → tools absent; surfaced in UI; retryable via /api/mcp/reconnect

  /**
   * When true, Think waits for all connected MCP servers to finish their
   * capability-discovery handshake before assembling the tool set for an
   * inference turn.  Servers that do not connect within the SDK default
   * timeout (~10 s) are skipped gracefully — the turn still proceeds with
   * the tools that are available.
   *
   * Set to false only if startup MCP latency is unacceptable and partial
   * tool availability on the first turn is acceptable.
   */
  waitForMcpConnections: boolean | { timeout: number } = true;
  chatRecovery = true;

  /**
   * In-memory runtime cache for per-server transition timestamps.
   * Keyed by PersistedMcpServer.id (UUID).
   * Resets on DO hibernation — these are observability timestamps, not durable data.
   * Mutated by buildDiscoverySnapshot() on each state observation.
   */
  private _mcpRuntimeCache = new Map<string, ServerRuntimeCache>();
  /**
   * SECURITY: Browser tools expose full Chrome DevTools Protocol execution against
   * live browser sessions. Set to `true` only when your deployment explicitly
   * requires automated browsing and the BROWSER / LOADER bindings are configured.
   * Defaults to `false` so forks and new deployments are safe out-of-the-box.
   */
  protected enableBrowserTools = false;
  /**
   * Emits browser tool arguments/results for smoke-test validation.
   * Keep disabled by default in production.
   */
  protected enableBrowserToolDebug = false;
  /**
   * SECURITY: Code execution allows the LLM to write and run arbitrary JavaScript
   * inside a sandboxed Worker isolate. Outbound network is blocked by default, but
   * the tool still provides significant capability. Set to `true` only when you
   * have reviewed the sandbox constraints and the LOADER binding is configured.
   * Defaults to `false` so forks and new deployments are safe out-of-the-box.
   */
  protected enableCodeExecution = false;
  /**
   * SECURITY: MCP can introduce external tool surfaces over the network.
   * Keep disabled unless explicitly required and configured.
   */
  protected enableMcp = false;
  /**
   * Voice: WebSocket + Workers AI STT/TTS. Requires `ENABLE_VOICE` / settings
   * and `env.AI`. When false, `beforeCallStart` refuses voice sessions.
   */
  protected enableVoice = false;

  // Runtime state
  protected modelRouter: IModelRouter;
  protected hookRegistry: HookRegistry = new HookRegistry();
  protected requestId: string;

  /**
   * Structured observability emitter. Emits `model.selected`, `model.fallback`,
   * and `turn.summary` events — safe to expose publicly for sub-agent wiring.
   */
  public readonly obs: Observability;
  protected readonly voiceService: VoiceService;

  /** Filled in constructor when `env.AI` is set — required by @cloudflare/voice. */
  transcriber: WorkersAIFluxSTT | undefined;
  tts: WorkersAITTS | undefined;
  /** Active @cf/deepgram/aura-1 `speaker` (see `DEFAULT_AURA_TTS_SPEAKER`). */
  private _auraTtsSpeaker: AuraTtsSpeaker = DEFAULT_AURA_TTS_SPEAKER;

  /** Deepgram Flux STT — see Settings → Voice and `applyVoiceFluxStt`. */
  private _voiceFluxEotThreshold = 0.7;
  private _voiceFluxEotTimeoutMs = 5000;
  private _voiceFluxEagerEotThreshold: number | undefined = undefined;

  // Per-turn accumulators reset in `beforeTurn` and flushed in `onChatResponse`.
  private _turnStartMs = 0;
  private _turnToolCount = 0;
  private _turnStepCount = 0;
  private _turnInputTokens = 0;
  private _turnOutputTokens = 0;
  private _turnRawInferenceMessageCount = 0;
  private _turnInferenceMessageCount = 0;
  private _turnSystemOverridden = false;
  private _turnRawPromptCharsEstimate = 0;
  private _turnRawPromptTokensEstimate = 0;
  private _turnPromptCharsEstimate = 0;
  private _turnPromptTokensEstimate = 0;
  private _turnDroppedEmptyAssistant = 0;
  private _turnDroppedDuplicateGreeting = 0;
  private _turnDroppedAssistantStatus = 0;
  private _turnRetainedToolMessages = 0;
  private _turnRetainedSubstantiveUserMessages = 0;
  private _turnCompactionRuns = 0;
  private _turnCompactionSummaryInserted = false;
  private _turnCompactionPromptReductionTokens = 0;
  private _turnCompactionPromptReductionPercent = 0;
  private _turnSummaryCarriesBrowserSessionState = false;
  private _turnSummaryCarriesDurableFacts = false;
  private _turnCompactionSegmentCharsBefore = 0;
  private _turnCompactionSegmentTokensBefore = 0;
  private _turnCompactionSegmentCharsAfter = 0;
  private _turnCompactionSegmentTokensAfter = 0;
  private _turnModelId: string | undefined;
  private _turnRouteClass: RouteClass | undefined;
  private _turnDynamicRouteModel: string | undefined;
  private _turnGatewayModel: string | undefined;
  private _turnGatewayProvider: string | undefined;
  private _sessionCachedPromptEnabled = true;
  private _sessionCompactionEnabled = true;
  private _sessionCompactionThresholdTokens = 45_000;
  private _turnBrowserIntentDetected = false;
  /** Latest user message text for the current turn (set in beforeTurn). */
  private _turnLatestUserMessage = "";
  /**
   * Set in `beforeTurn` from the client chat body: only when
   * `settings.agentShouldSpeak === true` may we play TTS for **typed** turns
   * after `onChatResponse` (see `_maybeSpeakTypedResponseAfterChat`). If the
   * key is absent or not `true`, typed TTS is skipped.
   */
  private _turnAgentShouldSpeakTts = false;
  /**
   * True while the Cloudflare `onTurn` hook is running `saveMessages` (voice
   * STT and voice `text_message`). Used to avoid double TTS: the voice
   * pipeline already synthesizes after `onTurn` returns. `beforeTurn` must not
   * let a stale Think `body.settings.ttsSpeaker` of the app default (`asteria`)
   * override a non-default speaker already set via `POST /api/voice/tts-speaker`
   * or DO storage — see the stale-default guard in `beforeTurn`.
   */
  private _inVoiceOnTurn = false;
  /** WebSocket `connection.id`s in an active `start_call` (see `onCallStart`). */
  private readonly _voiceInCallConnectionIds = new Set<string>();

  // -- TEMP: [voice-dbg] remove after TTS investigation (grep: [voice-dbg]) --
  private _voiceDbgSeq = 0;
  private _voiceDbgTurn = "";

  private _voiceDbgNewTurn(label: "stt" | "text_msg" | "postchat", connection: Connection): void {
    this._voiceDbgSeq += 1;
    this._voiceDbgTurn = `vt${this._voiceDbgSeq}-${label}-${String(connection.id).slice(0, 8)}`;
  }
  // -- end TEMP [voice-dbg] --

  /**
   * Active browser executor backend. Default is "cdp" (raw CDP over WebSocket).
   * Updated each turn from ctx.body.settings.browserStepExecutor sent by the frontend.
   * Switching to "puppeteer" routes all browser actions through @cloudflare/puppeteer.
   */
  private _browserStepExecutor: "cdp" | "puppeteer" = "cdp";
  private _turnBrowserSessionLaunchSucceeded = false;
  private _turnFirstBrowserSessionLaunchResult: unknown = undefined;
  private _turnFirstBrowserSessionLaunchAllowsFollowup = false;
  private readonly browserSessionProvider: MainAgentConfig["browserSessionProvider"];
  private readonly aiGatewayBaseUrl: string;
  private readonly rawEnableBrowserTools: string | undefined;
  private readonly parsedEnableBrowserTools: boolean;

  /**
   * Typed hook pipelines and tool policy registry.
   * Wire your own observers and policy rules here.
   *
   * @example
   *   agent.hooks.beforeTurn.add((ctx) => console.log("turn:", ctx.requestId));
   *   agent.hooks.toolPolicy.add({ toolName: "delete_project_note", handler: myGuard });
   */
  public readonly hooks: AgentHooks;

  protected getWorkspace(): Workspace | undefined {
    // Think types this as a shell-compatible workspace; cast for tools that still expect `Workspace`.
    return this.workspace as Workspace | undefined;
  }

  constructor(ctx: DurableObjectState, env: Env, config: MainAgentConfig = {}) {
    super(ctx, env);

    const runtime = getRuntimeConfig(env);
    this.rawEnableBrowserTools = this.getRawEnvString("ENABLE_BROWSER_TOOLS");
    this.parsedEnableBrowserTools = parseBooleanFlag(this.rawEnableBrowserTools, false);

    // Apply configuration
    if (config.waitForMcpConnections !== undefined) {
      this.waitForMcpConnections = config.waitForMcpConnections;
    }
    if (config.chatRecovery !== undefined) {
      this.chatRecovery = config.chatRecovery;
    }
    this.enableBrowserTools =
      config.enableBrowserTools ?? runtime.featureFlags.enableBrowserTools;
    this.enableBrowserToolDebug = runtime.featureFlags.enableBrowserToolDebug;
    this.enableCodeExecution =
      config.enableCodeExecution ?? runtime.featureFlags.enableCodeExecution;
    this.enableMcp = config.enableMcp ?? runtime.featureFlags.enableMcp;
    this.enableVoice = config.enableVoice ?? runtime.featureFlags.enableVoice;
    const browserRunAuth = resolveBrowserRunAuth(env);
    const cloudflareAccountId = browserRunAuth.accountId;
    const cloudflareApiToken = browserRunAuth.token;
    const authSource = browserRunAuth.selectedTokenSource;
    const cloudflareBrowserApiToken = (env.CLOUDFLARE_BROWSER_API_TOKEN?.trim()) || undefined;
    const cloudflareApiTokenFallback = (env.CLOUDFLARE_API_TOKEN?.trim()) || undefined;

    // Startup invariant: log which token wins and account id status
    if (cloudflareBrowserApiToken && cloudflareApiTokenFallback) {
      console.info(
        `[EdgeClaw][browser-session-auth-startup] Both CLOUDFLARE_BROWSER_API_TOKEN and CLOUDFLARE_API_TOKEN present; ` +
        `selectedTokenSource=CLOUDFLARE_BROWSER_API_TOKEN`
      );
    }
    if (!cloudflareAccountId || cloudflareAccountId.length === 0) {
      console.error(
        `[EdgeClaw][browser-session-auth-startup] CONFIGURATION ERROR: CLOUDFLARE_ACCOUNT_ID missing or empty. ` +
        `authSource=${authSource}`
      );
    }

    const accountFingerprint = cloudflareAccountId
      ? [...cloudflareAccountId].reduce(
          (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619),
          2166136261
        ) >>> 0
      : 0;
    const selectedTokenFingerprint = cloudflareApiToken
      ? [...cloudflareApiToken].reduce(
          (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619),
          2166136261
        ) >>> 0
      : 0;
    console.info(
      `[EdgeClaw][browser-session-auth] hasAccountId=${cloudflareAccountId ? "yes" : "no"} ` +
        `hasCLOUDFLARE_BROWSER_API_TOKEN=${cloudflareBrowserApiToken ? "yes" : "no"} ` +
        `hasCLOUDFLARE_API_TOKEN=${cloudflareApiTokenFallback ? "yes" : "no"} ` +
        `selectedTokenSource=${authSource} tokenLength=${cloudflareApiToken?.length ?? 0} ` +
        `accountFingerprint=${accountFingerprint.toString(16).padStart(8, "0")} ` +
        `selectedTokenFingerprint=${selectedTokenFingerprint.toString(16).padStart(8, "0")}`
    );
    this.browserSessionProvider = createBrowserSessionProvider(
      config.browserSessionProvider ??
        (cloudflareAccountId && cloudflareApiToken
          ? createCloudflareBrowserSessionProvider({
              accountId: cloudflareAccountId,
              apiToken: cloudflareApiToken,
              authSource,
            })
          : undefined)
    );
    this.aiGatewayBaseUrl = runtime.aiGatewayBaseUrl;

    if (!this.enableBrowserTools) {
      console.warn(
        buildBrowserDisabledWarningLine(
          buildBrowserCapabilityAuditSnapshot({
            rawEnableBrowserTools: this.rawEnableBrowserTools,
            parsedEnableBrowserTools: this.parsedEnableBrowserTools,
            finalToolNames: [],
          })
        )
      );
    }

    // Create the observability emitter. Level is read from OBSERVABILITY_LEVEL
    // env variable (default: "info"). Must be set before the router is created
    // so it can be passed through RouterConfig.
    this.obs = createObservability(
      this.constructor.name,
      runtime.observabilityLevel
    );

    // Use provided router or create standard one with observability wired in.
    if (config.modelRouter) {
      this.modelRouter = config.modelRouter;
    } else {
      // Create standard router with AI Gateway config from environment
      this.modelRouter = createStandardRouter({
        aiGateway: runtime.aiGatewayBaseUrl
          ? {
              baseUrl: runtime.aiGatewayBaseUrl,
              authToken: env.AI_GATEWAY_TOKEN,
              enableCaching: true,
              cacheTtlSeconds: 3600,
            }
          : undefined,
        enableDetailedLogging: runtime.environment !== "production",
        obs: this.obs,
      });
    }

    this.requestId = config.requestId || `req-${Date.now()}`;
    this.voiceService = createVoiceService(this.enableVoice);
    if (env.AI) {
      this.transcriber = new WorkersAIFluxSTT(env.AI, this.getFluxSttOptions());
      this.tts = new WorkersAITTS(env.AI, {
        model: "@cf/deepgram/aura-1",
        speaker: this._auraTtsSpeaker,
      });
    } else {
      this.transcriber = undefined;
      this.tts = undefined;
    }

    // Initialize hook pipelines with the built-in structured logger.
    this.hooks = createAgentHooks(this.constructor.name);

    // ── Observability: per-turn accumulators ──────────────────────────────────
    // These handlers run after the structured logger (registration order).
    // They track state that is flushed as a `turn.summary` event.

    this.hooks.beforeTurn.add(() => {
      this._turnStartMs = Date.now();
      this._turnToolCount = 0;
      this._turnStepCount = 0;
      this._turnInputTokens = 0;
      this._turnOutputTokens = 0;
      this._turnRawInferenceMessageCount = 0;
      this._turnInferenceMessageCount = 0;
      this._turnSystemOverridden = false;
      this._turnRawPromptCharsEstimate = 0;
      this._turnRawPromptTokensEstimate = 0;
      this._turnPromptCharsEstimate = 0;
      this._turnPromptTokensEstimate = 0;
      this._turnDroppedEmptyAssistant = 0;
      this._turnDroppedDuplicateGreeting = 0;
      this._turnDroppedAssistantStatus = 0;
      this._turnRetainedToolMessages = 0;
      this._turnRetainedSubstantiveUserMessages = 0;
      this._turnCompactionRuns = 0;
      this._turnCompactionSummaryInserted = false;
      this._turnCompactionPromptReductionTokens = 0;
      this._turnCompactionPromptReductionPercent = 0;
      this._turnSummaryCarriesBrowserSessionState = false;
      this._turnSummaryCarriesDurableFacts = false;
      this._turnCompactionSegmentCharsBefore = 0;
      this._turnCompactionSegmentTokensBefore = 0;
      this._turnCompactionSegmentCharsAfter = 0;
      this._turnCompactionSegmentTokensAfter = 0;
      this._turnModelId = undefined;
      this._turnRouteClass = undefined;
      this._turnDynamicRouteModel = undefined;
      this._turnGatewayModel = undefined;
      this._turnGatewayProvider = undefined;
      this._turnBrowserIntentDetected = false;
      this._turnBrowserSessionLaunchSucceeded = false;
      this._turnFirstBrowserSessionLaunchResult = undefined;
      this._turnFirstBrowserSessionLaunchAllowsFollowup = false;
    });

    this.hooks.afterToolCall.add(() => {
      this._turnToolCount += 1;
    });

    this.hooks.onStepFinish.add((ctx) => {
      this._turnStepCount += 1;
      this._turnInputTokens += ctx.usage.inputTokens ?? 0;
      this._turnOutputTokens += ctx.usage.outputTokens ?? 0;

      const metadataHeaders = this.extractGatewayMetadataHeaders(ctx);
      if (metadataHeaders.model) this._turnGatewayModel = metadataHeaders.model;
      if (metadataHeaders.provider) this._turnGatewayProvider = metadataHeaders.provider;
    });

    this.hooks.onChatResponse.add((ctx) => {
      if (!this.obs.isEnabled("info")) return;
      this.obs.emit({
        event: "turn.summary",
        ts: new Date().toISOString(),
        requestId: ctx.requestId ?? this.requestId,
        agentName: this.constructor.name,
        durationMs: Date.now() - this._turnStartMs,
        status: ctx.status ?? "unknown",
        toolCallCount: this._turnToolCount,
        stepCount: this._turnStepCount,
        totalInputTokens: this._turnInputTokens,
        totalOutputTokens: this._turnOutputTokens,
        modelId: this._turnModelId,
        gatewayUsed: true,
        routeClass: this._turnRouteClass,
        dynamicRouteModel: this._turnDynamicRouteModel,
        gatewayModel: this._turnGatewayModel,
        gatewayProvider: this._turnGatewayProvider,
      });
    });
  }

  private extractGatewayMetadataHeaders(ctx: StepContext): {
    model?: string;
    provider?: string;
  } {
    const unknownCtx = ctx as unknown as {
      response?: { headers?: Headers | Record<string, string> };
      headers?: Headers | Record<string, string>;
    };

    const headerSources = [unknownCtx.response?.headers, unknownCtx.headers];

    const getHeader = (
      headers: Headers | Record<string, string>,
      key: string
    ): string | undefined => {
      if (headers instanceof Headers) {
        const value = headers.get(key);
        return value ?? undefined;
      }

      const lowerKey = key.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lowerKey) return v;
      }
      return undefined;
    };

    for (const headers of headerSources) {
      if (!headers) continue;
      const model = getHeader(headers, "cf-aig-model");
      const provider = getHeader(headers, "cf-aig-provider");
      if (model || provider) {
        return { model, provider };
      }
    }

    return {};
  }

  /**
   * Build role-specific context overrides.
   *
   * Sub-agents override this method to influence selection for their role
   * (research vs execution) without duplicating router logic.
   */
  protected getRoleModelContextOverrides(
    _turn: AgentTurnContext
  ): Partial<ModelContext> {
    return { agentRole: "general" };
  }

  /**
   * Infer task type from turn content when caller does not provide one.
   */
  protected inferTaskType(turn: AgentTurnContext): TaskType {
    if (turn.taskType) {
      return turn.taskType;
    }

    const text = (turn.message || "").toLowerCase();

    if (/\b(search|browse|find|lookup|web|source|citation|summarize)\b/.test(text)) {
      return "search";
    }
    if (/\b(code|bug|fix|refactor|typescript|javascript|function|test)\b/.test(text)) {
      return "code";
    }
    if (/\b(analyze|analysis|compare|evaluate|reason|why)\b/.test(text)) {
      return "analysis";
    }
    if (/\b(tool|execute|run|command|terminal|file)\b/.test(text)) {
      return "tool_use";
    }
    if (/\b(write|draft|compose|edit|improve)\b/.test(text)) {
      return "content";
    }

    return "general";
  }

  /**
   * Infer likely tool use from message content when caller does not provide one.
   */
  protected inferLikelyToolUsage(turn: AgentTurnContext): boolean {
    if (typeof turn.likelyToolUsage === "boolean") {
      return turn.likelyToolUsage;
    }

    const text = (turn.message || "").toLowerCase();
    return /\b(search|browse|open|navigate|fetch|execute|run|read file|list|query)\b/.test(text);
  }

  /**
   * Infer complexity from message length if caller does not provide one.
   */
  protected inferComplexity(turn: AgentTurnContext): EstimatedComplexity {
    if (turn.estimatedComplexity) {
      return turn.estimatedComplexity;
    }

    const length = (turn.message || "").length;
    if (length > 2400) return "expert";
    if (length > 1200) return "complex";
    if (length > 400) return "moderate";
    return "simple";
  }

  /**
   * Classify the turn into a thin app-level route class.
   */
  protected classifyRouteClass(turn: AgentTurnContext): RouteClass {
    const text = (turn.message || "").toLowerCase();
    const likelyToolUse = this.inferLikelyToolUsage(turn);
    const complexity = this.inferComplexity(turn);

    // Browser-action requests (navigate, screenshot, open URL, etc.) must route
    // to "tools" so the model router selects a tool-capable model — not "vision"
    // or "utility", which are too weak for reliable tool use.
    if (isBrowserIntentRequest(text)) {
      return "tools";
    }

    if (/\b(image|vision|photo|diagram|ocr)\b/.test(text)) {
      return "vision";
    }

    if (likelyToolUse) {
      return "tools";
    }

    if (
      complexity === "complex" ||
      complexity === "expert" ||
      /\b(reason|analyz|compare|derive|prove|tradeoff|debug|refactor)\b/.test(text)
    ) {
      return "reasoning";
    }

    return "utility";
  }

  /**
   * Convert runtime turn signals into a router-ready ModelContext.
   *
   * This keeps all routing decisions centralized in ModelRouter while letting
   * agents provide runtime hints per turn.
   */
  protected buildTurnModelContext(turn: AgentTurnContext): ModelContext {
    const routeClass = this.classifyRouteClass(turn);
    const inferredTaskType = this.inferTaskType(turn);
    const inferredComplexity = this.inferComplexity(turn);
    const inferredToolUse = this.inferLikelyToolUsage(turn);

    const inferredLatency: LatencySensitivity =
      turn.latencySensitivity || (inferredToolUse ? "high" : "medium");

    const inferredCost: CostSensitivity =
      turn.costSensitivity || (inferredComplexity === "expert" ? "low" : "medium");

    const estimatedPromptTokens =
      turn.estimatedPromptTokens ?? Math.max(128, Math.ceil(((turn.message || "").length || 0) / 4));

    const baseContext: ModelContext = {
      taskType: inferredTaskType,
      estimatedComplexity: inferredComplexity,
      expectsToolUse: inferredToolUse,
      latencySensitivity: inferredLatency,
      costSensitivity: inferredCost,
      agentRole: "general",
      estimatedPromptTokens,
      estimatedOutputTokens: turn.estimatedOutputTokens,
      requestId: this.requestId,
      forceModel: routeClass,
    };

    return {
      ...baseContext,
      ...this.getRoleModelContextOverrides(turn),
    };
  }

  /**
   * Select a model for the current task using flexible routing
   *
   * @param context - Task context for model selection
   * @returns Selected model with reasoning and alternatives
   *
   * @example
   *   const context: ModelContext = {
   *     taskType: "reasoning",
   *     estimatedComplexity: "complex",
   *     expectsToolUse: true,
   *     latencySensitivity: "medium",
   *     costSensitivity: "medium",
   *     agentRole: "general"
   *   };
   *   const selection = await agent.selectModel(context);
   *   console.log(`Selected: ${selection.selected.name}`);
   */
  async selectModel(context: Partial<ModelContext>): Promise<ModelSelectionResult> {
    // Fill in default values for required fields
    const fullContext: ModelContext = {
      taskType: context.taskType || "general",
      estimatedComplexity: context.estimatedComplexity || "moderate",
      expectsToolUse: context.expectsToolUse ?? false,
      latencySensitivity: context.latencySensitivity || "medium",
      costSensitivity: context.costSensitivity || "medium",
      agentRole: context.agentRole || "general",
      requestId: context.requestId || this.requestId,
      ...context,
    };

    return this.modelRouter.selectModel(fullContext);
  }

  /**
   * Think model entrypoint.
   *
   * Think requires a synchronous return value here, so this path resolves
   * the router default model. For per-turn dynamic selection, use
   * `getModelForTurn()` in explicit orchestration paths.
   */
  getModel(): LanguageModel {
    const fallback = this.modelRouter.getDefaultModel();
    this._turnModelId = fallback.id;
    this._turnRouteClass = fallback.routeClass;
    this._turnDynamicRouteModel = fallback.modelId;
    const selection: ModelSelectionResult = {
      selected: fallback,
      reason: "Default model for Think runtime getModel()",
      score: 0,
      alternatives: [],
      selectedRouteClass: fallback.routeClass,
      dynamicRouteModel: fallback.modelId,
      gatewayBaseUrl: this.aiGatewayBaseUrl,
    };
    const bindings = buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, { agent: "MainAgent" });
    return resolveLanguageModel(selection, bindings);
  }

  /**
   * Explicit per-turn model resolver for callers that have turn context.
   */
  async getModelForTurn(turn: AgentTurnContext = {}): Promise<LanguageModel> {
    const selection = await this.selectModelForTurn(turn);
    const obs = turn.aiGatewayObservability;
    const bindings = buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, {
      agent: obs?.agent ?? "MainAgent",
      projectId: obs?.projectId,
      taskId: obs?.taskId,
      runId: obs?.runId,
    });
    return resolveLanguageModel(selection, bindings);
  }

  /**
   * Select a model configuration for the current turn.
   *
   * This method is useful when callers want routing telemetry (selected model,
   * reason, alternatives) in addition to the resolved LanguageModel instance.
   */
  async selectModelForTurn(
    turn: AgentTurnContext = {}
  ): Promise<ModelSelectionResult> {
    const context = this.buildTurnModelContext(turn);
    try {
      const result = await this.selectModel(context);
      // Cache the selected model ID for the turn.summary event.
      this._turnModelId = result.selected.id;
      this._turnRouteClass = result.selectedRouteClass;
      this._turnDynamicRouteModel = result.dynamicRouteModel;
      return result;
    } catch (err) {
      // Emit a fallback event before retrying with the default model.
      const errorSummary = err instanceof Error
        ? err.message.substring(0, 200)
        : String(err).substring(0, 200);
      const fallback = this.modelRouter.getDefaultModel();
      this.obs.emit({
        event: "model.fallback",
        ts: new Date().toISOString(),
        requestId: this.requestId,
        agentName: this.constructor.name,
        fallbackModelId: fallback.id,
        errorSummary,
      });
      // Build a minimal selection result from the default model and re-throw
      // if no default exists; otherwise return the fallback.
      this._turnModelId = fallback.id;
      this._turnRouteClass = fallback.routeClass;
      this._turnDynamicRouteModel = fallback.modelId;
      return {
        selected: fallback,
        reason: "Fallback to default — original selection failed",
        score: 0,
        alternatives: [],
        selectedRouteClass: fallback.routeClass,
        dynamicRouteModel: fallback.modelId,
        gatewayBaseUrl: this.aiGatewayBaseUrl,
        warnings: [`Model selection failed: ${errorSummary}`],
      };
    }
  }

  /**
   * Get the currently configured model router
   */
  getModelRouter(): IModelRouter {
    return this.modelRouter;
  }

  /**
   * Set a custom model router (for specialized agents or runtime changes)
   *
   * @example
   *   const customRouter = createCostOptimizedRouter();
   *   customRouter.registerModel(...);
   *   agent.setModelRouter(customRouter);
   */
  setModelRouter(router: IModelRouter): void {
    this.modelRouter = router;
  }

  /**
   * Get the default model from the current router
   * Useful for simple cases where no context-aware selection is needed
   */
  getDefaultModel(): ModelConfig {
    return this.modelRouter.getDefaultModel();
  }

  /**
   * Resolve a LanguageModel for use with Think's getModel().
   *
   * This is the primary way to get a live AI SDK model from the agent.
   * Combines selectModel() (routing) with resolveLanguageModel() (AI SDK
   * instantiation) in a single call.
   *
   * How it works:
   *   1. selectModel() picks the best ModelConfig from the router pool
   *      based on the provided context (defaults to a general moderate task).
   *   2. resolveLanguageModel() converts the result to an AI SDK LanguageModel
   *      by routing to the correct provider (Anthropic, OpenAI, Workers AI).
   *
   * Sub-agents override getModel() to pass a role-specific context:
   *   override async getModel() {
   *     return this.resolveModel({ taskType: "research", estimatedComplexity: "complex" });
   *   }
   *
   * @param context - Optional partial context; missing fields use safe defaults
   * @example
   *   // Inside Think's getModel():
   *   return this.resolveModel({ taskType: "code", expectsToolUse: true });
   */
  async resolveModel(context: Partial<ModelContext> = {}): Promise<LanguageModel> {
    const selection = await this.selectModel(context);
    const bindings = buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, { agent: "MainAgent" });
    return resolveLanguageModel(selection, bindings);
  }

  /**
   * Configure Think session blocks for durable memory and long conversations.
   *
   * The reusable session module owns all core memory behavior. MainAgent only
   * provides agent-specific defaults and optional extra blocks.
   */
  configureSession(session: Session): Session {
    const appName = getRuntimeConfig(this.env).appName;
    const compactionTokenThreshold = 45_000;
    const options: SessionConfigurationOptions = {
      soulPrompt: buildSoulPrompt(
        // ── Identity ──────────────────────────────────────────────────────────
        `Your name is ${appName}, a careful, tool-using assistant built on the Cloudflare Think framework. ` +
        `When asked your name or what you are called, always answer "${appName}". ` +
        // ── Core persona ──────────────────────────────────────────────────────
        `${appName} prefers sharp truth over comforting vagueness. ` +
        "You operate like a Mentat: calm, precise, analytical, and disciplined under uncertainty. " +
        "Your purpose is to turn ambiguity into reliable action while minimizing avoidable error. " +
        "Reason through problems step by step. Consider multiple approaches before choosing an action. " +
        "Prioritize correctness over speed, clarity over cleverness, and useful progress over unnecessary caution. " +
        "Use available tools when they materially improve accuracy, verification, or execution. Do not use tools performatively. " +
        "If essential information is missing, ask concise clarifying questions. " +
        "If the task can be advanced safely, make the best justified assumption, state it clearly, and proceed. " +
        "Be direct, structured, and useful. Do not invent facts or overstate confidence. " +
        "When you make a mistake, correct it plainly and move forward. " +
        "Your goal is not just to answer, but to help the user arrive at sound decisions. " +
        "RESPONSE FORMATTING: The chat UI renders your replies as Markdown (GitHub Flavored Markdown, including pipe tables). " +
        "For comparisons, inventories, rule lists, or multi-field data, prefer `##` / `###` section headings and stable-column GFM tables over long dense prose. " +
        "Keep table headers short; align similar values in columns. " +
        // ── Browser grounding rules ───────────────────────────────────────────
        "BROWSER ACTION GROUNDING RULE: For any request involving opening a URL, navigating, taking a screenshot, recording a session, or any browser automation, " +
        "you MUST only claim the action occurred if a browser tool was actually called and returned a successful result in this conversation turn. " +
        "If no browser tool was executed, respond with: \"No browser tool was executed, so I cannot confirm the action occurred.\" " +
        "STRUCTURED BROWSER ACTIONS: Prefer using structured actions in browser_session when appropriate: " +
        "  - navigate { url, waitUntil? } to load pages " +
        "  - click { selector, delayMs? } to click buttons/links " +
        "  - type { selector, value, delayMs?, clearFirst? } to fill forms " +
        "  - wait { selector?, timeoutMs?, waitUntil? } to wait for page elements " +
        "  - screenshot { fullPage? } to capture page state " +
        "Example: launch Amazon with actions [navigate(url), type(search box, 'backpacks'), click(search button), wait(results), screenshot]. " +
        "Use cdpScript only for complex, manual CDP operations not covered by structured actions. " +
        "BROWSER SESSION CONTROL MAPPING: If the user asks to pause for human review, wait for them, let them log in, or stop for review, use browser_session launch with pauseForHuman=true, sessionMode='reusable', and keepAliveMs. " +
        "If the user asks to pause on blocker, use pauseForHumanOnBlocker=true in reusable mode. " +
        "If the user asks for recording, set recordingEnabled=true. " +
        "If the user asks to keep the session alive, reuse it later, or resume an existing session, prefer reusable mode and use resume_browser_session or reuseSessionId instead of launching a fresh unrelated session. " +
        "Never describe a screenshot as taken, a page as loaded, or a session as recorded unless the tool result in this turn explicitly contains screenshot data, a page title, or a session artifact reference. " +
        // ── Screenshot data policy ────────────────────────────────────────────
        "SCREENSHOT DATA POLICY — CRITICAL: When a browser_session result includes a \"_screenshotDataUrl\" field, that is a UI-rendered image for the user interface ONLY. " +
        "You MUST NEVER copy, quote, reproduce, or include any base64-encoded data, data: URLs, or binary-encoded strings in your text response under any circumstances. " +
        "When a screenshot was captured, simply write a short plain-text sentence like \"Here is the screenshot of <page name>.\" — the UI will display the actual image automatically. " +
        // ── Task scheduling grounding rule ────────────────────────────────────
        "TASK SCHEDULING GROUNDING RULE: For any request to create, schedule, remind, set up a recurring task, or similar, " +
        "you MUST call the schedule_task tool and receive a successful result before telling the user the task was created. " +
        "Never describe a task as scheduled, created, or set up unless the schedule_task tool was called and returned { \"created\": true } in this conversation turn. " +
        "If you did not call schedule_task, respond with: \"I haven't scheduled the task yet — let me do that now.\" and call the tool immediately. " +
        "After a successful schedule_task call, confirm the task by echoing the title, schedule type, and expression from the tool result — not from your prior reasoning. " +
        "TASK LIST DISPLAY RULE: After calling list_tasks, you MUST display the actual task data returned by the tool. " +
        "Present each task as a readable summary showing: title, schedule (type + expression), status, and next run time. " +
        "If the list is empty, say so explicitly. Never respond with only a tool-call badge or 'Tools used: list_tasks' — the user cannot see raw tool output."
      ),
      memoryDescription: "Important durable facts learned across the conversation.",
      memoryMaxTokens: 4000,
      compaction: {
        // Use a conservative threshold that compacts long noisy threads without over-compacting short chats.
        summarize: this.createCompactionSummarizer(),
        tokenThreshold: compactionTokenThreshold,
      },
      additionalContexts: [
        {
          label: "model_context",
          options: {
            description: "Context about which model is being used and why",
            maxTokens: 800,
          },
        },
      ],
      // Provide the R2 bucket when the binding is present so configureSession
      // registers the "skills" context block with R2SkillProvider.  Absent when
      // SKILLS_BUCKET is not bound (e.g. dev without R2) — skills are silently
      // disabled and no context block is registered.
      skillsBucket: hasSkillsBucket(this.env) ? this.env.SKILLS_BUCKET : undefined,
    };

    this._sessionCachedPromptEnabled = options.enableCachedPrompt ?? true;
    this._sessionCompactionEnabled = options.compaction?.enabled ?? true;
    this._sessionCompactionThresholdTokens =
      options.compaction?.tokenThreshold ?? compactionTokenThreshold;

    console.info(
      `[EdgeClaw][session-config] cachedPrompt=${this._sessionCachedPromptEnabled ? "enabled" : "disabled"} ` +
        `compaction=${this._sessionCompactionEnabled ? "enabled" : "disabled"} ` +
        `compactionThresholdTokens=${this._sessionCompactionThresholdTokens}`
    );

    return applySessionConfiguration(session, options);
  }

  /**
   * Default compaction summarizer uses the same model-routing stack as normal turns.
   * This keeps memory overlays aligned with current provider/model policy.
   */
  protected createCompactionSummarizer(): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      // A summarize() invocation indicates Session compaction ran for this turn.
      this._turnCompactionRuns += 1;
      this._turnCompactionSegmentCharsBefore = prompt.length;
      this._turnCompactionSegmentTokensBefore = Math.max(1, Math.ceil(prompt.length / 4));

      const model = await this.getModelForTurn({
        taskType: "analysis",
        estimatedComplexity: "moderate",
        likelyToolUsage: false,
        aiGatewayObservability: { agent: "MainAgent" },
      });

      const result = await generateText({
        model,
        prompt:
          "Summarize the following older conversation segment for durable operational context. " +
          "Preserve only durable facts, current task context, browser session state, and important tool outcomes. " +
          "Do not preserve repetitive greetings, placeholder assistant chatter, or contradictory obsolete tool-availability claims. " +
          "Output concise bullet points only.\n\n" +
          prompt,
        maxOutputTokens: 500,
      });
      const summary = result.text.trim();
      this._turnCompactionSummaryInserted = summary.length > 0;
      this._turnCompactionSegmentCharsAfter = summary.length;
      this._turnCompactionSegmentTokensAfter = Math.max(1, Math.ceil(summary.length / 4));
      this._turnCompactionPromptReductionTokens = Math.max(
        0,
        this._turnCompactionSegmentTokensBefore - this._turnCompactionSegmentTokensAfter
      );
      this._turnCompactionPromptReductionPercent =
        this._turnCompactionSegmentTokensBefore > 0
          ? Math.max(
              0,
              Number(
                (
                  (this._turnCompactionPromptReductionTokens /
                    this._turnCompactionSegmentTokensBefore) *
                  100
                ).toFixed(1)
              )
            )
          : 0;
      this._turnSummaryCarriesBrowserSessionState =
        this.summaryCarriesBrowserSessionState(summary);
      this._turnSummaryCarriesDurableFacts = this.summaryCarriesDurableFacts(summary);

      return summary;
    };
  }

  /**
   * Get custom server-side tools available to this agent.
   *
   * Think auto-merges built-in workspace tools separately, so this method only
   * returns additional domain tools defined by the framework.
   */
  getTools(): ToolSet {
    const hasBrowserBinding = Boolean(this.env.BROWSER);
    const hasLoaderBinding = Boolean(this.env.LOADER);

    console.log("[EdgeClaw][tools-audit] ENTERING getTools()");
    console.log(
      `[EdgeClaw][tools-audit] ENABLE_BROWSER_TOOLS raw=${this.rawEnableBrowserTools ?? "(unset)"}`
    );
    console.log(
      `[EdgeClaw][tools-audit] ENABLE_BROWSER_TOOLS parsed=${this.parsedEnableBrowserTools}`
    );
    console.log(`[EdgeClaw][tools-audit] enableBrowserTools (effective)=${this.enableBrowserTools}`);
    console.log(`[EdgeClaw][tools-audit] BROWSER binding exists=${hasBrowserBinding}`);
    console.log(`[EdgeClaw][tools-audit] LOADER binding exists=${hasLoaderBinding}`);

    if (this.enableBrowserTools && (!hasBrowserBinding || !hasLoaderBinding)) {
      const missing = [
        ...(hasBrowserBinding ? [] : ["BROWSER"]),
        ...(hasLoaderBinding ? [] : ["LOADER"]),
      ];
      throw new Error(
        `[EdgeClaw] Browser tools are enabled but missing binding(s): ${missing.join(", ")}. ` +
          'Configure wrangler.jsonc with "browser": { "binding": "BROWSER" } and ' +
          '"worker_loaders": [{ "binding": "LOADER" }].'
      );
    }

    const baseTools = createAgentTools({
      // Cast: Workspace.readFile returns string|null but WorkspaceLike expects string;
      // the stat() guard in each tool call site already ensures non-null reads.
      workspace: this.getWorkspace() as unknown as WorkspaceLike | undefined,
      approvalEvaluator: defaultApprovalEvaluator,
      // Cast: MainAgent implements TaskToolAdapter structurally via tasksCreate /
      // tasksGetAll / tasksDelete. The cast is safe — TS structural typing verifies
      // this at compile time if the method signatures match.
      taskAdapter: this as unknown as TaskToolAdapter,
    });

    console.log(
      `[EdgeClaw][tools-audit] baseTools contains: ${Object.keys(baseTools).join(", ") || "(none)"}`
    );

    const includeBrowserTools = shouldIncludeBrowserTools({
      enableBrowserTools: this.enableBrowserTools,
      hasBrowserBinding,
      hasLoaderBinding,
    });

    // Browser tools are composed in only when enabled and both bindings exist.
    // This keeps behavior safe in environments where browser tooling is not configured.
    const browserTools = includeBrowserTools
      ? createAgentBrowserTools({
          browser: this.env.BROWSER as Fetcher,
          loader: this.env.LOADER as WorkerLoader,
        })
      : {};

    console.log(
      `[EdgeClaw][tools-audit] browserTools contains: ${Object.keys(browserTools).join(", ") || "(none)"}`
    );

    // Sandboxed code execution tool — omitted when LOADER binding is absent
    // or the feature is disabled. When workspace is present, the sandbox
    // also gets the full state.* filesystem API (readFile, planEdits, …).
    const codeExecutionEntry = this.enableCodeExecution
      ? createCodeExecutionTool({
          loader: this.env.LOADER,
          workspace: this.getWorkspace(),
          tools: baseTools,
        })
      : undefined;

    // Persistent browser session tool — only available when browser bindings exist
    const { accountId: cloudflareAccountId, token: cloudflareApiToken, selectedTokenSource: cloudflareAuthSource } =
      resolveBrowserRunAuth(this.env);

    const browserSessionTools = includeBrowserTools
      ? createBrowserSessionTool(
          (() => {
            console.info(
              `[EdgeClaw][browser-session] hasBrowserSessionProvider=${this.browserSessionProvider ? "yes" : "no"}`
            );
            return new BrowserSessionManager({
              storage: this.ctx.storage,
              tools: browserTools,
              browserSessionProvider: this.browserSessionProvider,
              cloudflareBrowserRunApi:
                cloudflareAccountId && cloudflareApiToken
                  ? {
                      accountId: cloudflareAccountId,
                      apiToken: cloudflareApiToken,
                      authSource: cloudflareAuthSource,
                    }
                  : undefined,
            });
          })(),
          {
            getLatestUserText: () => this._turnLatestUserMessage,
            getStepExecutor: () => this._browserStepExecutor,
          }
        )
      : {};

    // ── Workflow tools ──────────────────────────────────────────────────────
    // Defined inline so they close over `agent` (this instance).
    // Both tools return pre-formatted strings so any model — including the
    // smaller routed model — simply relays the text rather than
    // needing to interpret a structured object.
    const agent = this;
    const workflowTools = {
      list_workflows: tool({
        description:
          "List all workflow definitions the user has created in EdgeClaw. " +
          "Always present the full list in your reply — do not summarise as 'Done'. " +
          "Call this first if the user asks what workflows exist or before launching one.",
        inputSchema: z.object({
          _unused: z.string().optional().describe("No parameters required."),
        }),
        execute: async (_args: { _unused?: string }) => {
          const defs = await agent.listWorkflowDefinitions();
          if (defs.length === 0) {
            return "No workflow definitions have been created yet. " +
              "The user can create one from the Workflows page in the EdgeClaw UI.";
          }
          const lines = defs.map((d, i) => {
            const last = d.lastRunAt
              ? new Date(d.lastRunAt).toLocaleString()
              : "never";
            const status = d.enabled ? "enabled" : "disabled";
            return (
              `${i + 1}. "${d.name}" — entrypoint: ${d.entrypoint}, ` +
              `trigger: ${d.triggerMode}, approval: ${d.approvalMode}, ` +
              `status: ${status}, runs: ${d.runCount}, last run: ${last}`
            );
          });
          return `You have ${defs.length} workflow definition(s):\n${lines.join("\n")}`;
        },
      }),

      run_workflow: tool({
        description:
          "Launch a workflow by its definition name. " +
          "Always tell the user the run ID and that they can watch progress in the Workflows → Runs tab. " +
          "Use list_workflows first if you are unsure of the exact name. " +
          "For page intel workflows supply input: { url, requireApproval?, saveReport? }. " +
          "For research workflows supply input: { topic, requireApproval? }.",
        inputSchema: z.object({
          name:  z.string().describe("Exact or partial name of the workflow definition to run."),
          input: z.record(z.string(), z.unknown()).optional().describe(
            "Payload for the workflow. Ask the user for required fields if unclear.",
          ),
        }),
        execute: async (args: { name: string; input?: Record<string, unknown> }) => {
          const defs = await agent.listWorkflowDefinitions();
          const lower = args.name.toLowerCase();
          const def = defs.find(
            (d) =>
              d.name.toLowerCase() === lower ||
              d.name.toLowerCase().includes(lower),
          );
          if (!def) {
            const available = defs.map((d) => `"${d.name}"`).join(", ");
            return `No workflow definition matching "${args.name}" found. ` +
              `Available: ${available || "(none — create one in the Workflows page)"}.`;
          }
          if (!def.enabled) {
            return `Workflow "${def.name}" is disabled. Enable it from the Workflows page before running.`;
          }
          const run = await agent.launchWorkflow(def.id, args.input);
          return (
            `Workflow "${def.name}" is now running. ` +
            `Run ID: ${run.id}. ` +
            `Watch live progress in the Workflows → Runs tab in the EdgeClaw UI.`
          );
        },
      }),
    };

    const finalToolSet = {
      ...baseTools,
      ...browserTools,
      ...browserSessionTools,
      ...(codeExecutionEntry ?? {}),
      ...workflowTools,
    };

    const orchestratorShared =
      this.constructor === MainAgent
        ? createSharedWorkspaceToolSet(getSharedWorkspaceGateway(this.env), "orchestrator")
        : {};

    const orchestratorGit =
      this.constructor === MainAgent && isGitIntegrationToolsEnabled(this.env)
        ? createGitIntegrationToolSet("orchestrator", {
            gateway: getSharedWorkspaceGateway(this.env),
            adapter: createNoopGitExecutionAdapter(),
          })
        : {};

    const mergedToolSet = {
      ...finalToolSet,
      ...orchestratorShared,
      ...orchestratorGit,
    };

    const auditSnapshot = buildBrowserCapabilityAuditSnapshot({
      rawEnableBrowserTools: this.rawEnableBrowserTools,
      parsedEnableBrowserTools: this.parsedEnableBrowserTools,
      finalToolNames: Object.keys(mergedToolSet),
    });

    console.log(
      `[EdgeClaw][tools-audit] FINAL TOOL SET: ${auditSnapshot.finalToolNames.join(", ") || "(empty)"}`
    );
    console.log(
      `[EdgeClaw][tools-audit] browser capability available=${auditSnapshot.browserCapabilityAvailable}`
    );

    return mergedToolSet;
  }

  // ── MCP server management ─────────────────────────────────────

  /**
   * Connect to an external MCP server by URL.
   *
   * MCP tools from the server are automatically merged by Think into every
   * subsequent turn alongside getTools() output.  Because `waitForMcpConnections`
   * is `true`, Think waits for the connection to reach "ready" (up to ~10 s)
   * before starting inference.  If the server does not connect in time the turn
   * proceeds with whatever tools are available.
   *
   * The `name` uniquely identifies this server within the agent instance and
   * is used by `removeServer`. Choose a short, descriptive name.
   *
   * @param name   Unique identifier for this server (e.g. "github", "search").
   * @param url    Full MCP endpoint URL — do NOT hardcode private URLs.
   *               Read them from environment variables or worker bindings.
   * @param options Optional transport and auth options.
   * @returns      The connection ID returned by Think (use with removeServer).
   *
   * @example
   *   // Recommended: read URL from environment / secret binding
   *   await agent.addServer("my-tools", env.MCP_MY_TOOLS_URL);
   *
   *   // With bearer-token auth header
   *   await agent.addServer("private", env.MCP_PRIVATE_URL, {
   *     headers: { Authorization: `Bearer ${env.MCP_TOKEN}` },
   *   });
   */
  async addServer(
    name: string,
    url: string,
    options: McpServerOptions = {}
  ): Promise<McpAddServerResult> {
    if (!this.enableMcp) {
      throw new Error(
        "[EdgeClaw] MCP is disabled. Set ENABLE_MCP=true to enable addServer()."
      );
    }

    // Validate that the URL is a well-formed https:// endpoint.
    // Plain http:// is rejected to prevent credential leakage over insecure channels.
    // file://, data:, and relative paths are blocked as well.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`[EdgeClaw] addServer: invalid URL for MCP server "${name}".`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        `[EdgeClaw] addServer: MCP server "${name}" must use https:// (got ${parsed.protocol}). ` +
          "Plain http:// endpoints are not permitted — credentials and tool results " +
          "would be transmitted in cleartext."
      );
    }

    // Reject empty server names to prevent accidental namespace collisions.
    if (!name || name.trim() === "") {
      throw new Error("[EdgeClaw] addServer: server name must be a non-empty string.");
    }

    // The SDK's addMcpServer returns { id, state, authUrl? }.
    // state === "authenticating" means the server requires OAuth.
    // authUrl must be surfaced to the frontend so the user can authorize.
    const self = this as unknown as {
      addMcpServer(
        name: string,
        url: string,
        options?: Record<string, unknown>
      ): Promise<McpAddServerResult>;
    };

    const sdkOptions: Record<string, unknown> = {
      transport: {
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.transport ? { type: options.transport } : {}),
      },
    };
    if (options.callbackHost) {
      sdkOptions.callbackHost = options.callbackHost;
    }

    return self.addMcpServer(name, url, sdkOptions);
  }

  /**
   * Disconnect and remove an MCP server by its connection ID.
   *
   * After removal the server's tools are no longer merged into turns.
   * The connection ID is the value returned by `addServer`.
   *
   * @param serverId  The connection ID returned by `addServer`.
   *
   * @example
   *   const id = await agent.addServer("search", env.MCP_SEARCH_URL);
   *   // … later …
   *   await agent.removeServer(id);
   */
  async removeServer(serverId: string): Promise<void> {
    const self = this as unknown as {
      removeMcpServer(id: string): Promise<void>;
    };
    return self.removeMcpServer(serverId);
  }

  // ── MCP route-adapter bridge (implements McpRouteAdapter) ────────────────
  //
  // These methods are called exclusively by mcpRoutes.ts via the McpRouteAdapter
  // cast in onRequest().  All state building is delegated to buildDiscoverySnapshot()
  // from mcpDiscovery.ts — MainAgent only owns persistence and SDK wiring.
  //
  // Data boundaries:
  //   PERSISTED (DO SQLite via configure/getConfig — key: mcpServers):
  //     id, name, url, transport, enabled, headers (server-side only), token (deprecated),
  //     createdAt, updatedAt
  //   RUNTIME-ONLY (from SDK getMcpServers() — rebuilt on every snapshot call):
  //     state, error, auth_url, instructions, capabilities, tools, prompts, resources

  /**
   * Read the SDK's live MCP state as a RawSdkMcpState.
   * The cast is safe — we fail gracefully in buildDiscoverySnapshot if fields are absent.
   */
  private _sdkGetMcpServers(): RawSdkMcpState {
    const sdk = this as unknown as { getMcpServers?: () => unknown };
    const raw = sdk.getMcpServers?.() ?? EMPTY_RAW_SDK_STATE;
    return raw as RawSdkMcpState;
  }

  /**
   * Read and migrate persisted MCP server configs from DO SQLite.
   * Runs migratePersistedMcpServer() on each entry to handle schema evolution:
   *   - Generates id when absent (old configs only had name/url/transport/addedAt)
   *   - Defaults enabled=true when absent
   *   - Maps addedAt → createdAt for backward compatibility
   * Malformed entries are skipped with a warning rather than aborting the read.
   */
  private _mcpReadConfig(): PersistedMcpServer[] {
    const cfg = (this.getConfig() ?? {}) as Record<string, unknown>;
    const list = cfg.mcpServers;
    if (!Array.isArray(list)) return [];
    const migrated: PersistedMcpServer[] = [];
    for (const raw of list) {
      try {
        migrated.push(migratePersistedMcpServer(raw));
      } catch (err) {
        console.warn("[EdgeClaw][mcp] Skipping malformed persisted server entry:", err);
      }
    }
    return migrated;
  }

  /** Overwrite the persisted MCP server list (merges with other DO config keys). */
  private async _mcpWriteConfig(servers: PersistedMcpServer[]): Promise<void> {
    const existing = (this.getConfig() ?? {}) as Record<string, unknown>;
    await this.configure({ ...existing, mcpServers: servers });
  }

  /**
   * Return the credential-free projection of the persisted config for use in
   * buildDiscoverySnapshot().  Strips both `headers` and `token` so neither
   * auth credential can leak into any API response, regardless of how the
   * snapshot builder evolves.
   */
  private _mcpConfigForSnapshot(): PersistedMcpServerSafe[] {
    return this._mcpReadConfig().map(
      ({ headers: _h, token: _t, ...safe }) => safe
    );
  }

  /**
   * Find the SDK's internal server ID for a given user-assigned name.
   * Returns null if the server is not currently connected in the SDK.
   */
  private _sdkServerIdByName(name: string): string | null {
    const raw = this._sdkGetMcpServers();
    const entry = Object.entries(raw.servers ?? {}).find(([, s]) => s?.name === name);
    return entry ? entry[0] : null;
  }

  /**
   * Build and return the full normalized MCP discovery snapshot.
   * Credentials (headers, token) are stripped by _mcpConfigForSnapshot() before
   * reaching the builder.  The runtime cache is passed so transition timestamps
   * (connectedAt, discoveredAt, firstErrorAt) are accurate.
   */
  mcpGetState(): McpDiscoverySnapshot {
    const raw = this._sdkGetMcpServers();
    return buildDiscoverySnapshot(raw, this._mcpConfigForSnapshot(), this._mcpRuntimeCache);
  }

  /**
   * Connect a new MCP server and persist its config.
   * The bearer token, if provided, is stored server-side and never returned
   * in any discovery snapshot.
   */
  async mcpAddServer(
    name: string,
    url: string,
    options: {
      transport?: McpTransport;
      /** Arbitrary HTTP headers forwarded to the server (Authorization, CF-Access, etc.). */
      headers?: Record<string, string>;
      /** @deprecated Use headers instead. */
      token?: string;
    } = {}
  ): Promise<McpDiscoverySnapshot> {
    if (!this.enableMcp) {
      throw new Error("[EdgeClaw] MCP is disabled. Set ENABLE_MCP=true to enable MCP server management.");
    }

    // Default to streamable-http — the recommended transport per the MCP spec.
    // "auto" is accepted for backward compat but not used for new connections.
    const transport: McpTransport = options.transport ?? "streamable-http";

    // Resolve the effective headers: explicit headers take precedence over legacy token.
    const effectiveHeaders =
      options.headers ??
      (options.token ? { Authorization: `Bearer ${options.token}` } : undefined);

    const existing = this._mcpReadConfig();
    if (existing.some((s) => s.name === name)) {
      throw new Error(
        `[EdgeClaw] An MCP server named "${name}" is already connected. Remove it first or choose a different name.`
      );
    }

    // addServer() validates the URL (https:// only) and calls addMcpServer on the SDK.
    // result.state === "authenticating" means the server needs OAuth; result.authUrl holds
    // the authorization URL the frontend should open in a popup.
    const result = await this.addServer(name, url, {
      transport,
      ...(effectiveHeaders ? { headers: effectiveHeaders } : {}),
    });

    if (result.state === "authenticating" && result.authUrl) {
      console.log(
        `[EdgeClaw][mcp] Server "${name}" requires OAuth authorization. ` +
        `Returning authUrl to frontend for popup flow.`
      );
    }

    const now = new Date().toISOString();
    const persistEntry: PersistedMcpServer = {
      id:        crypto.randomUUID(),
      name,
      url,
      transport,
      enabled:   true,
      createdAt: now,
      updatedAt: now,
      ...(options.headers ? { headers: options.headers } :
          options.token  ? { token: options.token }      : {}),
    };
    await this._mcpWriteConfig([...existing, persistEntry]);

    return this.mcpGetState();
  }

  /** Disconnect and remove an MCP server by its user-assigned name. */
  async mcpRemoveServer(name: string): Promise<McpDiscoverySnapshot> {
    if (!this._mcpReadConfig().some((s) => s.name === name)) {
      throw new Error(`[EdgeClaw] No MCP server named "${name}" found.`);
    }

    const sdkId = this._sdkServerIdByName(name);
    if (sdkId) {
      try { await this.removeServer(sdkId); } catch (err) {
        console.warn(`[EdgeClaw][mcp] removeServer SDK call failed for "${name}":`, err);
      }
    }

    const remaining = this._mcpReadConfig().filter((s) => s.name !== name);
    // Clear the runtime cache for the removed server so its timestamps don't linger.
    const removed = this._mcpReadConfig().find((s) => s.name === name);
    if (removed) this._mcpRuntimeCache.delete(removed.id);
    await this._mcpWriteConfig(remaining);
    return this.mcpGetState();
  }

  /**
   * Disconnect then reconnect a server using its persisted config.
   * Use this to recover a stuck or failed connection without losing settings.
   */
  async mcpReconnectServer(name: string): Promise<McpDiscoverySnapshot> {
    const persisted = this._mcpReadConfig().find((s) => s.name === name);
    if (!persisted) {
      throw new Error(`[EdgeClaw] No MCP server named "${name}" found in persisted config.`);
    }

    const sdkId = this._sdkServerIdByName(name);
    if (sdkId) {
      try { await this.removeServer(sdkId); } catch (err) {
        console.warn(`[EdgeClaw][mcp] removeServer during reconnect for "${name}":`, err);
      }
    }

    // Prefer stored `headers`; fall back to legacy `token` field for old persisted configs.
    const persistedHeaders =
      persisted.headers ??
      (persisted.token ? { Authorization: `Bearer ${persisted.token}` } : undefined);

    // Clear the runtime cache entry so timestamps reset cleanly for the new connection.
    this._mcpRuntimeCache.delete(persisted.id);

    const result = await this.addServer(persisted.name, persisted.url, {
      transport: persisted.transport,
      ...(persistedHeaders ? { headers: persistedHeaders } : {}),
    });

    if (result.state === "authenticating" && result.authUrl) {
      console.log(
        `[EdgeClaw][mcp] Server "${name}" requires OAuth re-authorization after reconnect. ` +
        `Returning authUrl to frontend.`
      );
    }

    return this.mcpGetState();
  }

  /**
   * Enable or disable a server, or update other mutable config fields.
   * This is the only way to toggle enabled without a full remove+add cycle.
   * Returns the updated snapshot.
   */
  async mcpUpdateServer(
    name: string,
    updates: { enabled?: boolean }
  ): Promise<McpDiscoverySnapshot> {
    const all = this._mcpReadConfig();
    const idx = all.findIndex((s) => s.name === name);
    if (idx === -1) {
      throw new Error(`[EdgeClaw] No MCP server named "${name}" found.`);
    }

    const now = new Date().toISOString();
    const updated: PersistedMcpServer = {
      ...all[idx],
      ...("enabled" in updates && updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      updatedAt: now,
    };
    all[idx] = updated;
    await this._mcpWriteConfig(all);

    // If disabling, also disconnect from the SDK so tools are removed from inference.
    if (updates.enabled === false) {
      const sdkId = this._sdkServerIdByName(name);
      if (sdkId) {
        try { await this.removeServer(sdkId); } catch (err) {
          console.warn(`[EdgeClaw][mcp] SDK disconnect on disable failed for "${name}":`, err);
        }
      }
      this._mcpRuntimeCache.delete(updated.id);
    }

    // If re-enabling, connect using the persisted config.
    if (updates.enabled === true) {
      const persistedHeaders =
        updated.headers ??
        (updated.token ? { Authorization: `Bearer ${updated.token}` } : undefined);
      try {
        await this.addServer(updated.name, updated.url, {
          transport: updated.transport,
          ...(persistedHeaders ? { headers: persistedHeaders } : {}),
        });
      } catch (err) {
        console.warn(`[EdgeClaw][mcp] SDK connect on re-enable failed for "${name}":`, err);
      }
    }

    return this.mcpGetState();
  }

  /**
   * Restore all persisted MCP servers on DO startup (after hibernation).
   * Disabled servers (enabled=false) are skipped — their config is preserved but
   * no SDK connection is made.
   * Called from onStart() before any inference turn starts.
   */
  private async _mcpRestoreServers(): Promise<void> {
    if (!this.enableMcp) return;

    const servers = this._mcpReadConfig();
    if (servers.length === 0) return;

    const enabledServers = servers.filter((s) => s.enabled);
    const disabledCount = servers.length - enabledServers.length;

    console.log(
      `[EdgeClaw][mcp] Restoring ${enabledServers.length} enabled MCP server(s) after startup` +
      (disabledCount > 0 ? ` (${disabledCount} disabled, skipped)` : "") + "."
    );

    for (const server of enabledServers) {
      try {
        // Prefer stored `headers`; fall back to legacy `token` field for old persisted configs.
        const persistedHeaders =
          server.headers ??
          (server.token ? { Authorization: `Bearer ${server.token}` } : undefined);

        const result = await this.addServer(server.name, server.url, {
          transport: server.transport,
          ...(persistedHeaders ? { headers: persistedHeaders } : {}),
        });
        if (result.state === "authenticating") {
          // OAuth token expired or not yet present; the SDK has no stored token.
          // The server will appear as "authenticating" in the discovery snapshot.
          // The frontend Authorize button lets the user re-authorize without removing the server.
          console.log(
            `[EdgeClaw][mcp] Server "${server.name}" needs OAuth re-authorization after restore. ` +
            `User must authorize via the Settings panel.`
          );
        } else {
          console.log(`[EdgeClaw][mcp] Restored server "${server.name}" (state=${result.state}).`);
        }
      } catch (err) {
        console.error(`[EdgeClaw][mcp] Failed to restore server "${server.name}":`, err);
      }
    }
  }

  // ── Think lifecycle hooks ──────────────────────────────────────────────────

  /**
   * Called when the Durable Object instance starts (including after hibernation).
   *
   * Restores any persisted MCP servers so their tools are available on the
   * first inference turn without requiring the user to manually reconnect.
   * Think's own onStart (if it exists on the base) is called first via super.
   */
  override async onStart(): Promise<void> {
    if (typeof super.onStart === "function") {
      await super.onStart();
    }

    // Configure the OAuth callback response so the popup window closes cleanly
    // and posts a message back to the opener (frontend) so it can refresh MCP state.
    //
    // We install a customHandler so both the success AND failure paths close the popup
    // and notify the opener, instead of the SDK's default redirect-on-success / error-page
    // behavior.  The handler receives MCPClientOAuthResult from the SDK:
    //   { authSuccess: true }  — token exchange completed.
    //   { authSuccess: false, authError?: string }  — provider rejected or error occurred.
    //
    // NOTE: authError text may originate from the external OAuth provider.  We do NOT
    // embed it in the HTML response to avoid XSS — we only post a boolean back to the
    // opener.  The frontend refreshes state and reads the server's lifecycle state directly.
    if (this.enableMcp) {
      const sdkMcp = (this as unknown as {
        mcp?: { configureOAuthCallback?: (opts: unknown) => void };
      }).mcp;

      if (typeof sdkMcp?.configureOAuthCallback === "function") {
        // Inline type reflects MCPClientOAuthResult from the agents SDK.
        type OAuthResult = { authSuccess: boolean; authError?: string };

        sdkMcp.configureOAuthCallback({
          customHandler: (result: OAuthResult) => {
            const success = result.authSuccess === true;
            if (!success) {
              console.warn(
                "[EdgeClaw][mcp] OAuth callback received failure result. " +
                "Server will remain in authenticating state until user retries."
              );
            }
            const html = success
              ? [
                  "<!DOCTYPE html>",
                  "<html><head><meta charset=utf-8>",
                  "<title>Authorization Complete</title>",
                  "<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}",
                  ".card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.1)}",
                  "h2{color:#16a34a;margin:0 0 .5rem}p{color:#64748b;margin:0}</style>",
                  "</head><body><div class=card>",
                  "<h2>&#10003; Authorized</h2>",
                  "<p>This window will close automatically&hellip;</p>",
                  "</div>",
                ].join("")
              : [
                  "<!DOCTYPE html>",
                  "<html><head><meta charset=utf-8>",
                  "<title>Authorization Failed</title>",
                  "<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}",
                  ".card{text-align:center;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.1)}",
                  "h2{color:#dc2626;margin:0 0 .5rem}p{color:#64748b;margin:0}</style>",
                  "</head><body><div class=card>",
                  "<h2>&#10007; Authorization failed</h2>",
                  "<p>Please close this window and try again from the Settings panel.</p>",
                  "</div>",
                ].join("");

            return new Response(
              html +
                [
                  "<script>",
                  "(function(){",
                  // Notify the opener with success/failure so it can show the right message.
                  `try{if(window.opener&&!window.opener.closed){`,
                  `window.opener.postMessage({type:'mcp-oauth-complete',success:${success}},window.location.origin);`,
                  "}}catch(e){}",
                  "setTimeout(function(){window.close();},800);",
                  "})();",
                  "</script></body></html>",
                ].join(""),
              { headers: { "content-type": "text/html; charset=utf-8" } }
            );
          },
        });
        console.log("[EdgeClaw][mcp] OAuth callback configured: popup-close mode (success+failure).");
      }
    }

    await this._restoreAuraTtsFromStorage();
    await this._mcpRestoreServers();
  }

  /**
   * `_auraTtsSpeaker` and `this.tts` are in-memory only. After the DO hibernates, the
   * new process reconstructs the default (asteria). Reload the user's choice from
   * `ctx.storage` (written from `reconfigureAuraTtsIfNeeded` / `applyAuraTtsSpeaker`).
   */
  private async _restoreAuraTtsFromStorage(): Promise<void> {
    if (!this.env.AI) {
      return;
    }
    let raw: unknown;
    try {
      raw = await this.ctx.storage.get(EDGECLAW_AURA_TTS_SPEAKER_STORAGE_KEY);
    } catch (e) {
      console.warn(
        "[EdgeClaw][tts-debug] failed to read aura TTS speaker from DO storage",
        e instanceof Error ? e.message : e
      );
      return;
    }
    const p = parseAuraTtsSpeaker(raw);
    if (!p) {
      return;
    }
    if (p === this._auraTtsSpeaker) {
      return;
    }
    this.reconfigureAuraTtsIfNeeded(p);
    console.info(
      `[EdgeClaw][tts-debug] Restored @cf/deepgram/aura-1 TTS from DO storage after DO wake/hibernation: ${p}`
    );
  }

  private _persistAuraTtsSpeakerToStorage(speaker: AuraTtsSpeaker): void {
    void this.ctx.storage
      .put(EDGECLAW_AURA_TTS_SPEAKER_STORAGE_KEY, speaker)
      .catch((e: unknown) => {
        console.warn(
          "[EdgeClaw][tts-debug] failed to persist aura TTS speaker to DO storage",
          e instanceof Error ? e.message : e
        );
      });
  }

  /**
   * Inspect and optionally override the assembled turn context.
   * Delegates to `hooks.beforeTurn` pipeline. The last non-void handler
   * return is forwarded to Think as the `TurnConfig` override.
   */
  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this._turnLatestUserMessage = "";
    this._turnAgentShouldSpeakTts = false;
    const availableToolNames = Object.keys(ctx.tools ?? {});
    const browserSearchPresent = availableToolNames.includes("browser_search");
    const browserExecutePresent = availableToolNames.includes("browser_execute");
    const browserToolsPresent = browserSearchPresent && browserExecutePresent;
    const userMessage = this.extractLatestUserMessageText(ctx.messages);
    // Do not assign _turnLatestUserMessage here — hooks.beforeTurn.run() runs a handler that
    // clears turn state (see constructor); assign after the hook so merge in browser_session
    // execute still sees the user text.

    // Read browser executor preference from the client request body.
    // The frontend sends { settings: { browserStepExecutor: "cdp" | "puppeteer" } }.
    // Because beforeTurn fires before any tool execute() call, this value is picked up
    // by the lazy getStepExecutor getter closed over by createBrowserSessionTool.
    const bodySettings = ctx.body?.settings;
    if (bodySettings && typeof bodySettings === "object") {
      const s = bodySettings as Record<string, unknown>;
      if (s.agentShouldSpeak === true) {
        this._turnAgentShouldSpeakTts = true;
      }
      const rawTts = s.ttsSpeaker;
      const ttsSp = parseAuraTtsSpeaker(rawTts);
      if (ttsSp) {
        // Chat bodies sometimes carry the app default (`asteria`) while the user already chose
        // another speaker via Settings + `POST /api/voice/tts-speaker`. Never let that stomp
        // the active DO speaker. Voice `saveMessages` paths can also lack real browser settings.
        const staleDefaultWouldStomp =
          ttsSp === DEFAULT_AURA_TTS_SPEAKER && this._auraTtsSpeaker !== DEFAULT_AURA_TTS_SPEAKER;
        if (staleDefaultWouldStomp) {
          console.info(
            `[EdgeClaw][tts-debug] beforeTurn: ignore body settings.ttsSpeaker=${ttsSp} ` +
              `(would stomp active speaker=${this._auraTtsSpeaker}; ` +
              `${this._inVoiceOnTurn ? "voice onTurn" : "typed chat"})`
          );
        } else {
          this.reconfigureAuraTtsIfNeeded(ttsSp);
        }
      } else if (rawTts !== undefined && rawTts !== null) {
        console.info(
          `[EdgeClaw][tts-debug] beforeTurn: ttsSpeaker is not a valid aura id (ignored): ` +
            `${JSON.stringify(rawTts)} (type=${typeof rawTts})`
        );
      }
      if (s.browserStepExecutor === "puppeteer" || s.browserStepExecutor === "cdp") {
        if (this._browserStepExecutor !== s.browserStepExecutor) {
          console.info(
            `[EdgeClaw][settings] browserStepExecutor changed: ${this._browserStepExecutor} → ${s.browserStepExecutor}`
          );
          this._browserStepExecutor = s.browserStepExecutor;
        }
      }
      if (typeof s.voiceFluxEotThreshold === "number" && typeof s.voiceFluxEotTimeoutMs === "number") {
        const ev = s.voiceFluxEagerEotThreshold;
        let eager: number | null | undefined;
        if ("voiceFluxEagerEotThreshold" in s) {
          if (ev == null) {
            eager = null;
          } else if (typeof ev === "number") {
            eager = ev;
          } else {
            eager = undefined;
          }
        } else {
          eager = undefined;
        }
        this.applyVoiceFluxSttState(s.voiceFluxEotThreshold, s.voiceFluxEotTimeoutMs, eager);
      }
    }

    console.log("[EdgeClaw][turn-audit] beforeTurn called");
    console.log(`[EdgeClaw][turn-audit] User message length: ${userMessage.length}`);
    console.log(
      `[EdgeClaw][turn-audit] Tools available in TurnContext: ${availableToolNames.join(", ") || "(none)"}`
    );
    console.log(
      `[EdgeClaw][turn-audit] browser_search=${browserSearchPresent} browser_execute=${browserExecutePresent}`
    );

    // MCP turn audit: log per-server state and how many MCP tools reached this turn.
    // MCP tools arrive via Think's internal merge of getMcpServers().tools with getTools().
    // They appear in ctx.tools alongside local tools — no special handling needed here.
    if (this.enableMcp) {
      try {
        const sdkState = this._sdkGetMcpServers();
        const persistedCount = this._mcpReadConfig().length;
        const serverSummaries = Object.values(sdkState.servers ?? {}).map(
          (s) => `${s.name}:${s.state}`
        );
        const mcpToolNames = sdkState.tools.map((t) => t.name);
        // Tools from MCP are already merged into ctx.tools by Think before beforeTurn fires.
        const mcpToolsVisibleThisTurn = availableToolNames.filter(
          (n) => mcpToolNames.includes(n)
        );
        console.log(
          `[EdgeClaw][mcp-audit] configured=${persistedCount} ` +
          `live_servers=${serverSummaries.join(", ") || "(none)"} ` +
          `mcp_tools_this_turn=${mcpToolsVisibleThisTurn.length}` +
          (mcpToolsVisibleThisTurn.length > 0 ? ` (${mcpToolsVisibleThisTurn.join(", ")})` : "")
        );
      } catch {
        // Non-fatal: MCP audit failure must not abort the turn.
      }
    }

    const guardDecision = decideBrowserRequestGuard({
      userMessage,
      availableToolNames,
    });

    const browserIntentDetected = isBrowserIntentRequest(userMessage);
    this._turnBrowserIntentDetected = browserIntentDetected;

    const hookConfig = await this.hooks.beforeTurn.run({ ...ctx, requestId: this.requestId });
    this._turnLatestUserMessage = userMessage;

    // Think assembles message history from Session storage (ctx.messages).
    // Do not replace messages manually here; Session is the inference source of truth.
    const { messages: _ignoredMessagesOverride, ...sanitizedHookConfig } =
      (hookConfig ?? {}) as TurnConfig & { messages?: unknown };

    if (_ignoredMessagesOverride !== undefined) {
      console.warn(
        "[EdgeClaw][turn-audit] Ignoring beforeTurn.messages override to preserve Think Session history assembly."
      );
    }

    this._turnRawInferenceMessageCount = Array.isArray(ctx.messages) ? ctx.messages.length : 0;
    this._turnRawPromptCharsEstimate = this.estimatePromptChars(ctx.system, ctx.messages);
    this._turnRawPromptTokensEstimate = Math.max(1, Math.ceil(this._turnRawPromptCharsEstimate / 4));

    const hygiene = this.applyLightweightHistoryHygiene(ctx.messages);
    const effectiveMessages = hygiene.changed ? hygiene.messages : ctx.messages;

    this._turnDroppedEmptyAssistant = hygiene.droppedEmptyAssistant;
    this._turnDroppedDuplicateGreeting = hygiene.droppedDuplicateGreeting;
    this._turnDroppedAssistantStatus = hygiene.droppedAssistantStatus;
    this._turnInferenceMessageCount = effectiveMessages.length;
    const retainedQuality = this.analyzeRetainedHistoryQuality(effectiveMessages);
    this._turnRetainedToolMessages = retainedQuality.toolMessages;
    this._turnRetainedSubstantiveUserMessages = retainedQuality.substantiveUserMessages;
    this._turnSystemOverridden =
      typeof sanitizedHookConfig.system === "string" && sanitizedHookConfig.system !== ctx.system;
    this._turnPromptCharsEstimate = this.estimatePromptChars(ctx.system, effectiveMessages);
    this._turnPromptTokensEstimate = Math.max(1, Math.ceil(this._turnPromptCharsEstimate / 4));
    const compactionDistanceTokens =
      this._sessionCompactionThresholdTokens - this._turnPromptTokensEstimate;

    const compactionEligible =
      this._sessionCompactionEnabled &&
      this._turnPromptTokensEstimate >= this._sessionCompactionThresholdTokens;

    const compactionPreReason = !this._sessionCompactionEnabled
      ? "disabled"
      : compactionEligible
        ? "eligible-at-or-above-threshold"
        : "below-threshold";

    console.info(
      `[EdgeClaw][compaction-diag] requestId=${this.requestId} ` +
        `thresholdTokens=${this._sessionCompactionThresholdTokens} ` +
        `messageCountRaw=${this._turnRawInferenceMessageCount} ` +
        `messageCountAfterHygiene=${this._turnInferenceMessageCount} ` +
        `promptCharsRaw≈${this._turnRawPromptCharsEstimate} ` +
        `promptTokensRaw≈${this._turnRawPromptTokensEstimate} ` +
        `promptCharsAfterHygiene≈${this._turnPromptCharsEstimate} ` +
        `promptTokensAfterHygiene≈${this._turnPromptTokensEstimate} ` +
        `compactionDistanceTokens=${compactionDistanceTokens} ` +
        `retainedToolMessages=${this._turnRetainedToolMessages} ` +
        `retainedSubstantiveUserMessages=${this._turnRetainedSubstantiveUserMessages} ` +
        `compactionPreReason=${compactionPreReason}`
    );

    const baseConfig: TurnConfig = {
      ...sanitizedHookConfig,
    };

    if (hygiene.changed) {
      // Keep Think Session as source-of-truth; only trim clear low-value noise pre-inference.
      baseConfig.messages = effectiveMessages as TurnConfig["messages"];
    }

    if (guardDecision.shouldShortCircuit && !browserToolsPresent) {
      console.warn(
        "[EdgeClaw][turn-audit] Browser intent detected while browser tools are unavailable; returning deterministic fallback."
      );
      console.info(
        `[browser-grounding] browserIntentDetected=${browserIntentDetected} routeClass=n/a toolChoice=none toolCallCount=0 screenshotPresent=no renderedAs=none`
      );
      return {
        ...baseConfig,
        model: createDeterministicTextModel(
          guardDecision.responseText ?? BROWSER_TOOLS_FALLBACK_RESPONSE
        ),
        activeTools: [],
        toolChoice: "none",
        maxSteps: 1,
      };
    }

    // Browser grounding gate: when browser intent is detected and tools are available,
    // force the model to call a tool so it cannot fabricate a browser action result.
    if (browserIntentDetected && browserToolsPresent) {
      const explicitBrowserSessionStructuredCall =
        this.isExplicitBrowserSessionStructuredCall(userMessage);
      const browserToolNames = availableToolNames.filter(
        (t) => t === "browser_execute" || t === "browser_search" || t === "browser_session"
      );

      if (explicitBrowserSessionStructuredCall) {
        const explicitlyRequestedAdvancedTools = this.extractExplicitAdvancedBrowserTools(userMessage);
        const activeBrowserTools = [
          "browser_session",
          ...(explicitlyRequestedAdvancedTools.includes("browser_search") ? ["browser_search"] : []),
          ...(explicitlyRequestedAdvancedTools.includes("browser_execute") ? ["browser_execute"] : []),
        ];
        const maxSteps = 1;
        const baseSystem =
          typeof baseConfig.system === "string" ? baseConfig.system : ctx.system;
        const structuredSessionSupplement =
          "Structured browser_session: pass every requested field in a single launch tool call, including the full " +
          "`actions` array. Omitting `actions` when the user listed steps is wrong. " +
          "`task` must be a short human summary only—never put reasoning, plans, JSON, or action syntax in `task`. " +
          "Reply with only the tool result payload (no preamble or meta-commentary). " +
          "`keepAliveMs` is valid up to 3600000 (1 hour) in tool arguments.";
        console.info(
          `[browser-grounding] explicitBrowserSessionStructuredCall=yes maxSteps=${maxSteps} ` +
            `activeTools=${activeBrowserTools.join(",") || "(none)"}`
        );
        return {
          ...baseConfig,
          system: baseSystem
            ? `${baseSystem}\n\n${structuredSessionSupplement}`
            : structuredSessionSupplement,
          activeTools: activeBrowserTools,
          toolChoice: "required",
          maxSteps,
        };
      }

      const routeClass = "tools";
      const maxSteps = Math.max((baseConfig as { maxSteps?: number }).maxSteps ?? 1, 2);
      console.info(
        `[browser-grounding] browserIntentDetected=yes routeClass=${routeClass} toolChoice=required` +
          ` activeBrowserTools=${browserToolNames.join(",") || "(none)"} maxSteps=${maxSteps}`
      );
      console.info(
        `[browser-grounding] explicitBrowserSessionStructuredCall=no maxSteps=${maxSteps} ` +
          `activeTools=${browserToolNames.join(",") || "(none)"}`
      );
      return {
        ...baseConfig,
        activeTools: browserToolNames,
        toolChoice: "required",
        maxSteps,
      };
    }

    console.info(
      `[browser-grounding] browserIntentDetected=${browserIntentDetected} routeClass=default toolChoice=auto`
    );

    // ── Pending workflow notification delivery ────────────────────────────────
    // onWorkflowComplete/onWorkflowError writes pending_notification to the DB
    // so notifications survive DO eviction.  Here we drain any undelivered ones
    // by appending them to the system prompt for this turn.
    //
    // Skip injection when the current user message already starts with
    // "[Workflow notification]" — that means saveMessages delivered it directly
    // in this very turn (we still clear the DB row to prevent future duplication).
    try {
      this.wfEnsureTables();
      const pendingRows = this.sql<{ id: string; pending_notification: string }>`
        SELECT id, pending_notification FROM wf_runs
        WHERE pending_notification IS NOT NULL
        LIMIT 5
      `;
      if (pendingRows.length > 0) {
        // Always clear from DB — avoids re-delivery on the next turn.
        for (const r of pendingRows) {
          this.sql`UPDATE wf_runs SET pending_notification = NULL WHERE id = ${r.id}`;
        }

        const alreadyInTurn = userMessage.trimStart().startsWith("[Workflow notification]");
        if (!alreadyInTurn) {
          const notificationBlock = pendingRows
            .map((r) => r.pending_notification)
            .join("\n\n---\n\n");
          const baseSystem =
            typeof baseConfig.system === "string"
              ? baseConfig.system
              : typeof ctx.system === "string"
                ? ctx.system
                : "";
          baseConfig.system = baseSystem
            ? `${baseSystem}\n\n${notificationBlock}`
            : notificationBlock;
          console.log(
            `[EdgeClaw][workflow-notification] Injected ${pendingRows.length} pending notification(s) via system prompt`
          );
        } else {
          console.log(
            `[EdgeClaw][workflow-notification] Cleared ${pendingRows.length} pending notification(s) (already in user message)`
          );
        }
      }
    } catch (e) {
      console.error(`[EdgeClaw][workflow-notification] Failed to drain pending notifications: ${e}`);
    }

    return Object.keys(baseConfig).length > 0 ? baseConfig : undefined;
  }

  private getRawEnvString(key: "ENABLE_BROWSER_TOOLS"): string | undefined {
    const nested = this.env.Variables?.[key];
    if (typeof nested === "string") return nested;

    const topLevel = (this.env as unknown as Record<string, unknown>)[key];
    return typeof topLevel === "string" ? topLevel : undefined;
  }

  private extractLatestUserMessageText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== "object") continue;

      const role = (message as { role?: unknown }).role;
      if (role !== "user") continue;

      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;

      if (Array.isArray(content)) {
        const pieces = content
          .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          })
          .filter(Boolean);
        if (pieces.length > 0) return pieces.join(" ");
      }
    }
    return "";
  }

  /**
   * Called before each tool executes.
   * 1. Runs `hooks.toolPolicy` — can block or substitute the call.
   * 2. Runs `hooks.beforeToolCall` observational pipeline.
   *
   * Returns a `ToolCallDecision` from the policy layer if it intercepts;
   * otherwise returns `void` to allow normal execution.
   */
  async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
    if (this.enableBrowserToolDebug && this.isBrowserTool(ctx.toolName)) {
      this.logBrowserToolDebug("before", ctx.toolName, { input: ctx.input });
    }

    if (
      ctx.toolName === "browser_session" &&
      this.isBrowserSessionLaunchArgs(ctx.input) &&
      this._turnBrowserSessionLaunchSucceeded &&
      !this._turnFirstBrowserSessionLaunchAllowsFollowup &&
      this._turnFirstBrowserSessionLaunchResult !== undefined
    ) {
      console.warn(
        "[browser-grounding] Prevented duplicate browser_session launch in the same turn; reusing first successful launch result."
      );
      return {
        action: "substitute",
        output: this._turnFirstBrowserSessionLaunchResult,
      };
    }

    if (this.hooks.toolPolicy.size > 0) {
      const decision = await this.hooks.toolPolicy.evaluate({
        ...ctx,
        agentName: this.constructor.name,
        requestId: this.requestId,
      });
      if (decision) return decision;
    }
    await this.hooks.beforeToolCall.run({ ...ctx, requestId: this.requestId });
  }

  /**
   * Called after each tool executes. Fires `hooks.afterToolCall` with Think’s
   * `ToolCallResultContext` (`input`, `success`, `output`/`error`, `durationMs`).
   */
  async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    if (this.enableBrowserToolDebug && this.isBrowserTool(ctx.toolName)) {
      this.logBrowserToolDebug("after", ctx.toolName, {
        input: ctx.input,
        success: ctx.success,
        output: ctx.success ? ctx.output : ctx.error,
      });
    }

    if (
      ctx.toolName === "browser_session" &&
      ctx.success &&
      this.isBrowserSessionLaunchArgs(ctx.input) &&
      this.isSuccessfulBrowserSessionLaunchResult(ctx.output)
    ) {
      if (!this._turnBrowserSessionLaunchSucceeded) {
        this._turnBrowserSessionLaunchSucceeded = true;
        this._turnFirstBrowserSessionLaunchResult = ctx.output;
        this._turnFirstBrowserSessionLaunchAllowsFollowup =
          this.browserSessionLaunchAllowsFollowup(ctx.output);
      }
    }

    await this.hooks.afterToolCall.run({
      ...ctx,
      requestId: this.requestId,
      ok: ctx.success,
    });
  }

  private isBrowserTool(toolName: string): boolean {
    return (
      toolName === "browser_search" ||
      toolName === "browser_execute" ||
      toolName === "browser_session"
    );
  }

  private logBrowserToolDebug(
    stage: "before" | "after",
    toolName: string,
    payload: unknown
  ): void {
    const preview = JSON.stringify(this.compactForLog(payload));
    const capped = preview.length > 2500 ? `${preview.slice(0, 2500)}...(truncated)` : preview;
    console.log(`[EdgeClaw][browser-debug] stage=${stage} tool=${toolName} payload=${capped}`);
  }

  private compactForLog(value: unknown, depth = 0): unknown {
    if (depth > 3) return "[max-depth]";
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 500)}...(truncated)` : value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 8).map((v) => this.compactForLog(v, depth + 1));
    }
    if (!value || typeof value !== "object") return value;

    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(entries.map(([k, v]) => [k, this.compactForLog(v, depth + 1)]));
  }

  private isExplicitBrowserSessionStructuredCall(text: string): boolean {
    return isExplicitBrowserSessionStructuredUserMessage(text);
  }

  private extractExplicitAdvancedBrowserTools(
    text: string
  ): Array<"browser_search" | "browser_execute"> {
    const normalized = text.toLowerCase();
    const tools: Array<"browser_search" | "browser_execute"> = [];
    if (/\bbrowser_search\b/.test(normalized)) tools.push("browser_search");
    if (/\bbrowser_execute\b/.test(normalized)) tools.push("browser_execute");
    return tools;
  }

  private isBrowserSessionLaunchArgs(args: unknown): boolean {
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    return (args as { operation?: unknown }).operation === "launch";
  }

  private isSuccessfulBrowserSessionLaunchResult(result: unknown): boolean {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const rec = result as {
      schema?: unknown;
      sessionId?: unknown;
      status?: unknown;
    };
    if (rec.schema !== "edgeclaw.browser-session-result") return false;
    if (typeof rec.sessionId !== "string" || rec.sessionId.length === 0) return false;
    return rec.status === "active" || rec.status === "awaiting_human" || rec.status === "disconnected";
  }

  private browserSessionLaunchAllowsFollowup(result: unknown): boolean {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const rec = result as {
      status?: unknown;
      needsHumanIntervention?: unknown;
      summary?: unknown;
    };
    if (rec.status === "awaiting_human") return true;
    if (rec.needsHumanIntervention === true) return true;
    if (typeof rec.summary === "string" && /reconnect|resume/i.test(rec.summary)) return true;
    return false;
  }

  /**
   * Called after each agentic step. Fires `hooks.onStepFinish` — useful for
   * token accounting and per-step analytics.
   */
  async onStepFinish(ctx: StepContext): Promise<void> {
    await this.hooks.onStepFinish.run({ ...ctx, requestId: this.requestId });
  }

  /**
   * Called for each streaming chunk. High-frequency — keep handlers fast.
   * Fires `hooks.onChunk`.
   */
  async onChunk(ctx: ChunkContext): Promise<void> {
    await this.hooks.onChunk.run({ ...ctx, requestId: this.requestId });
  }

  /**
   * Called after the chat turn completes and the assistant message is persisted.
   * Fires `hooks.onChatResponse` — suitable for logging and usage tracking.
   */
  async onChatResponse(result: ChatResponseResult): Promise<void> {
    const errorText =
      typeof (result as { error?: unknown }).error === "string"
        ? ((result as { error?: string }).error ?? "")
        : "";
    const isBadRequest =
      errorText.length > 0 && /\bbad request\b|\b400\b/i.test(errorText);

    if (isBadRequest) {
      const compatSuffix = /\/compat$/i.test(this.aiGatewayBaseUrl.trim().replace(/\/+$/, ""));
      console.error(
        `[EdgeClaw][aig] Bad Request from AI Gateway: ` +
          `routeClass=${this._turnRouteClass ?? "unknown"} ` +
          `model=${this._turnDynamicRouteModel ?? "unknown"} ` +
          `baseURL=${this.aiGatewayBaseUrl} ` +
          `baseUrlEndsWithCompat=${compatSuffix}`
      );
    }

    // Browser grounding post-check: warn if the model described a browser action
    // but never actually called a tool. This indicates a hallucinated response.
    if (this._turnBrowserIntentDetected && this._turnToolCount === 0) {
      console.warn(
        `[browser-grounding] browserIntentDetected=yes toolCallCount=0 screenshotPresent=no renderedAs=none ` +
          `WARNING: browser-action turn completed with no tool call — response may be fabricated`
      );
    } else if (this._turnBrowserIntentDetected) {
      console.info(
        `[browser-grounding] browserIntentDetected=yes toolCallCount=${this._turnToolCount}`
      );
    }

    console.info(
      `[EdgeClaw][inference-diag] requestId=${result.requestId ?? this.requestId} ` +
        `cachedPrompt=${this._sessionCachedPromptEnabled ? "enabled" : "disabled"} ` +
        `systemOverridden=${this._turnSystemOverridden ? "yes" : "no"} ` +
        `messageCount=${this._turnInferenceMessageCount} ` +
        `promptChars≈${this._turnPromptCharsEstimate} ` +
        `promptTokens≈${this._turnPromptTokensEstimate} ` +
        `compaction=${this._turnCompactionRuns > 0 ? "ran" : "not-run"}`
    );

    const compactionPostReason = this._turnCompactionRuns > 0
      ? "summary-generated"
      : !this._sessionCompactionEnabled
        ? "disabled"
        : this._turnPromptTokensEstimate < this._sessionCompactionThresholdTokens
          ? "below-threshold"
          : "eligible-not-triggered-this-turn";

    console.info(
      `[EdgeClaw][retention-diag] requestId=${result.requestId ?? this.requestId} ` +
        `messageCountBefore=${this._turnRawInferenceMessageCount} ` +
        `messageCountAfter=${this._turnInferenceMessageCount} ` +
        `promptCharsBefore≈${this._turnRawPromptCharsEstimate} ` +
        `promptCharsAfter≈${this._turnPromptCharsEstimate} ` +
        `promptTokensBefore≈${this._turnRawPromptTokensEstimate} ` +
        `promptTokensAfter≈${this._turnPromptTokensEstimate} ` +
        `compactionDistanceTokens=${
          this._sessionCompactionThresholdTokens - this._turnPromptTokensEstimate
        } ` +
        `droppedEmptyAssistant=${this._turnDroppedEmptyAssistant} ` +
        `droppedDuplicateGreeting=${this._turnDroppedDuplicateGreeting} ` +
        `droppedAssistantStatus=${this._turnDroppedAssistantStatus} ` +
        `retainedToolMessages=${this._turnRetainedToolMessages} ` +
        `retainedSubstantiveUserMessages=${this._turnRetainedSubstantiveUserMessages} ` +
        `compaction=${this._turnCompactionRuns > 0 ? "ran" : "not-run"} ` +
        `compactionReason=${compactionPostReason} ` +
        `compactionSummaryInserted=${this._turnCompactionSummaryInserted ? "yes" : "no"} ` +
        `promptReductionTokens=${
          this._turnCompactionRuns > 0 ? this._turnCompactionPromptReductionTokens : 0
        } ` +
        `promptReductionPercent=${
          this._turnCompactionRuns > 0
            ? this._turnCompactionPromptReductionPercent.toFixed(1)
            : "0.0"
        } ` +
        `summaryCarriesBrowserSessionState=${
          this._turnCompactionRuns > 0
            ? this._turnSummaryCarriesBrowserSessionState
              ? "yes"
              : "no"
            : "n/a"
        } ` +
        `summaryCarriesDurableFacts=${
          this._turnCompactionRuns > 0
            ? this._turnSummaryCarriesDurableFacts
              ? "yes"
              : "no"
            : "n/a"
        } ` +
        `compactionSegmentPromptCharsBefore≈${this._turnCompactionSegmentCharsBefore} ` +
        `compactionSegmentPromptCharsAfter≈${this._turnCompactionSegmentCharsAfter} ` +
        `compactionSegmentPromptTokensBefore≈${this._turnCompactionSegmentTokensBefore} ` +
        `compactionSegmentPromptTokensAfter≈${this._turnCompactionSegmentTokensAfter}`
    );

    await this.hooks.onChatResponse.run({ ...result, requestId: this.requestId });
    // Typed assistant text is already persisted and streamed to the **chat**
    // WebSocket by Think. Do not add another user/assistant UIMessage here.
    await this._maybeSpeakTypedResponseAfterChat(result);
  }

  /**
   * After a Think `cf_agent_use_chat_request` turn, optionally play the same
   * assistant text on the **voice** WebSocket via `speak()` (Workers AI TTS).
   *
   * Why this does not duplicate the chat UI / timeline:
   * - The only canonical assistant text for the session is the Think `UIMessage`
   *   in `result.message` / `getMessages()`, already broadcast on the chat socket.
   * - `speak()` sends audio and updates the **voice** side table (`cf_voice_messages`)
   *   only; it does not append a second message to the Think history or the
   *   `cf_agent_*` chat stream, so the timeline renderer is unchanged.
   *
   * Spoken-input turns: while `onTurn` runs `saveMessages`, `_inVoiceOnTurn` is
   * true, so this is skipped — the @cloudflare/voice pipeline already runs TTS
   * from `onTurn`’s return value.
   */
  private async _maybeSpeakTypedResponseAfterChat(
    result: ChatResponseResult
  ): Promise<void> {
    if (result.status !== "completed" || this._inVoiceOnTurn) return;
    if (!this._turnAgentShouldSpeakTts) return;
    if (!this.enableVoice || !this.tts) return;
    if (this._voiceInCallConnectionIds.size === 0) return;
    // displayText: same plain string the chat already shows; never mutate UIMessage.
    const displayText = voiceExtractTextFromUiMessage(result.message).trim()
      || voiceLastAssistantPlainText(this.getMessages()).trim();
    if (!displayText) return;
    // TTS only: short, non-markdown phrasing so the model is not read character-by-character.
    const spokenText = deriveSpokenText(displayText);
    if (!spokenText) return;
    for (const connection of this.getConnections()) {
      if (!this._voiceInCallConnectionIds.has(connection.id)) continue;
      try {
        await this.speak(connection, spokenText);
      } catch (err) {
        console.error("[MainAgent] TTS (typed turn, active voice call) failed:", err);
      }
    }
  }

  private applyLightweightHistoryHygiene(messages: unknown[]): {
    messages: unknown[];
    changed: boolean;
    droppedEmptyAssistant: number;
    droppedDuplicateGreeting: number;
    droppedAssistantStatus: number;
  } {
    const kept: unknown[] = [];
    let droppedEmptyAssistant = 0;
    let droppedDuplicateGreeting = 0;
    let droppedAssistantStatus = 0;

    let previousKeptUserGreeting: string | undefined;
    let previousKeptAssistantStatus: string | undefined;

    for (const message of messages) {
      const role = this.getMessageRole(message);
      const text = this.extractMessageText(message).trim();
      const normalizedText = this.normalizeSimpleText(text);
      const hasToolData = this.messageCarriesToolData(message);

      if (role === "assistant") {
        if (!hasToolData && text.length === 0) {
          droppedEmptyAssistant += 1;
          continue;
        }

        if (
          !hasToolData &&
          this.isAssistantStatusOnly(text) &&
          previousKeptAssistantStatus === normalizedText
        ) {
          droppedAssistantStatus += 1;
          continue;
        }

        previousKeptAssistantStatus =
          !hasToolData && this.isAssistantStatusOnly(text) ? normalizedText : undefined;
        previousKeptUserGreeting = undefined;
      } else if (role === "user") {
        if (this.isSimpleGreeting(text) && previousKeptUserGreeting === normalizedText) {
          droppedDuplicateGreeting += 1;
          continue;
        }

        previousKeptUserGreeting = this.isSimpleGreeting(text) ? normalizedText : undefined;
        previousKeptAssistantStatus = undefined;
      } else {
        previousKeptUserGreeting = undefined;
        previousKeptAssistantStatus = undefined;
      }

      kept.push(message);
    }

    const changed =
      droppedEmptyAssistant > 0 || droppedDuplicateGreeting > 0 || droppedAssistantStatus > 0;

    return {
      messages: changed ? kept : messages,
      changed,
      droppedEmptyAssistant,
      droppedDuplicateGreeting,
      droppedAssistantStatus,
    };
  }

  private getMessageRole(message: unknown): string | undefined {
    if (!message || typeof message !== "object") return undefined;
    const role = (message as { role?: unknown }).role;
    return typeof role === "string" ? role : undefined;
  }

  private extractMessageText(message: unknown): string {
    if (!message || typeof message !== "object") return "";

    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const pieces: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        pieces.push(part);
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") pieces.push(text);
    }

    return pieces.join(" ");
  }

  private normalizeSimpleText(text: string): string {
    return text.trim().toLowerCase().replace(/[.!?]+$/g, "");
  }

  private isSimpleGreeting(text: string): boolean {
    const normalized = this.normalizeSimpleText(text);
    return (
      normalized === "hi" ||
      normalized === "hello" ||
      normalized === "hey" ||
      normalized === "hi there" ||
      normalized === "hello there"
    );
  }

  private isAssistantStatusOnly(text: string): boolean {
    const normalized = this.normalizeSimpleText(text);
    if (normalized.length === 0 || normalized.length > 64) return false;

    return /^(ok|okay|got it|understood|on it|working on it|one moment|just a moment|let me check|checking now|thinking|stand by)$/.test(
      normalized
    );
  }

  private messageCarriesToolData(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;

    const msg = message as {
      content?: unknown;
      toolCalls?: unknown;
      tool_results?: unknown;
      toolResult?: unknown;
      toolInvocations?: unknown;
    };

    if (
      Array.isArray(msg.toolCalls) ||
      Array.isArray(msg.toolInvocations) ||
      Array.isArray(msg.tool_results) ||
      Array.isArray(msg.toolResult)
    ) {
      return true;
    }

    if (!Array.isArray(msg.content)) return false;

    return msg.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const typedPart = part as { type?: unknown; toolName?: unknown; toolCallId?: unknown };
      if (typeof typedPart.toolName === "string" || typeof typedPart.toolCallId === "string") {
        return true;
      }
      if (typeof typedPart.type !== "string") return false;
      return typedPart.type !== "text";
    });
  }

  private analyzeRetainedHistoryQuality(messages: unknown[]): {
    toolMessages: number;
    substantiveUserMessages: number;
  } {
    let toolMessages = 0;
    let substantiveUserMessages = 0;

    for (const message of messages) {
      if (this.messageCarriesToolData(message)) {
        toolMessages += 1;
      }

      if (this.getMessageRole(message) !== "user") continue;
      const userText = this.extractMessageText(message).trim();
      if (this.isSubstantiveUserMessage(userText)) {
        substantiveUserMessages += 1;
      }
    }

    return { toolMessages, substantiveUserMessages };
  }

  private isSubstantiveUserMessage(text: string): boolean {
    if (!text) return false;
    if (this.isSimpleGreeting(text)) return false;

    const normalized = this.normalizeSimpleText(text);
    return normalized.length >= 8 || /\s/.test(normalized) || /[?]/.test(text);
  }

  private summaryCarriesBrowserSessionState(summary: string): boolean {
    const normalized = summary.toLowerCase();
    return (
      /\bbrowser session\b/.test(normalized) ||
      /\bsession(?:id)?\b/.test(normalized) ||
      /\bawaiting_human\b|\bdisconnected\b|\bactive\b|\bcompleted\b|\babandoned\b/.test(
        normalized
      ) ||
      /\bcurrenturl\b|https?:\/\//.test(normalized)
    );
  }

  private summaryCarriesDurableFacts(summary: string): boolean {
    const normalized = summary.toLowerCase();
    return (
      /\bname is\b|\buser name\b|\bprefers\b|\btimezone\b|\bemail\b/.test(normalized) ||
      /\bconstraint\b|\bdurable fact\b|\bremember\b/.test(normalized)
    );
  }

  private estimatePromptChars(system: string, messages: unknown[]): number {
    const systemChars = typeof system === "string" ? system.length : 0;
    const messageChars = this.estimateMessagesChars(messages);
    return systemChars + messageChars;
  }

  private estimateMessagesChars(messages: unknown[]): number {
    let total = 0;

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;

      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") {
        total += content.length;
        continue;
      }

      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (typeof part === "string") {
          total += part.length;
          continue;
        }
        if (!part || typeof part !== "object") continue;
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          total += text.length;
        }
      }
    }

    return total;
  }

  /**
   * Get the hook registry for this agent
   * Can be used to register lifecycle hooks
   */
  getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * @cloudflare/voice: reject WebSocket `start_call` when voice is off or AI is missing.
   */
  override beforeCallStart(_connection: Connection): boolean {
    const ok =
      this.enableVoice === true && Boolean(this.transcriber) && Boolean(this.tts);
    if (!ok) {
      // TEMP: [voice-dbg]
      console.info(
        `[voice-dbg] call_reject conn=${String(_connection.id).slice(0, 8)} ` +
          `enableVoice=${this.enableVoice} stt=${Boolean(this.transcriber)} tts=${Boolean(this.tts)}`
      );
    }
    return ok;
  }

  /**
   * Track which connections have an active voice call so typed chat can target
   * TTS to voice clients only (avoids `speakAll` fan-out to the text chat).
   */
  override onCallStart(connection: Connection): void | Promise<void> {
    // TEMP: [voice-dbg]
    console.info(
      `[voice-dbg] call_start turn=n/a conn=${String(connection.id).slice(0, 8)} ` +
        `in_call_n=${this._voiceInCallConnectionIds.size} enableVoice=${this.enableVoice}`
    );
    this._voiceInCallConnectionIds.add(connection.id);
  }

  override onCallEnd(connection: Connection): void | Promise<void> {
    this._voiceInCallConnectionIds.delete(connection.id);
  }

  /**
   * @cloudflare/voice: after STT produces a final utterance, run the same
   * Think + tools pipeline as a typed `saveMessages` turn, then return text
   * for TTS. The chat WebSocket also receives the streamed UIMessage chunks
   * from the inference loop.
   * TEMP: [voice-dbg] in `afterTranscribe` — log STT line (STT path only; `text_message` skips this).
   */
  override afterTranscribe(
    transcript: string,
    connection: Connection
  ): string | null | Promise<string | null> {
    this._voiceDbgNewTurn("stt", connection);
    const t = typeof transcript === "string" ? transcript : "";
    console.info(
      `[voice-dbg] stt id=${this._voiceDbgTurn} text_len=${t.length} ` +
        `conn=${String(connection.id).slice(0, 8)} snip=${JSON.stringify(t.length > 70 ? `${t.slice(0, 70)}…` : t)}`
    );
    return super.afterTranscribe(transcript, connection) as string | null | Promise<string | null>;
  }

  /**
   * TEMP: [voice-dbg] TTS about to / after synthesis (all paths using mixin synthesize).
   */
  override beforeSynthesize(text: string, connection: Connection): string | null | Promise<string | null> {
    console.info(
      `[voice-dbg] tts_begin id=${this._voiceDbgTurn || "n/a"} text_len=${(text ?? "").length} ` +
        `conn=${String(connection.id).slice(0, 8)}`
    );
    console.info(
      `[EdgeClaw][tts-debug] TTS about to run @cf/deepgram/aura-1 speaker=${this._auraTtsSpeaker} ` +
        `(not browser — check wrangler tail; compare to Settings and HTTP tts-speaker for this DO session)`
    );
    return super.beforeSynthesize(text, connection) as string | null | Promise<string | null>;
  }

  override afterSynthesize(
    audio: ArrayBuffer | null,
    text: string,
    connection: Connection
  ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
    const b = audio?.byteLength ?? 0;
    if (b > 0) {
      console.info(
        `[voice-dbg] tts_ok id=${this._voiceDbgTurn || "n/a"} bytes=${b} ` +
          `text_len=${(text ?? "").length} conn=${String(connection.id).slice(0, 8)}`
      );
    } else {
      console.info(
        `[voice-dbg] tts_empty id=${this._voiceDbgTurn || "n/a"} text_len=${(text ?? "").length} ` +
          `conn=${String(connection.id).slice(0, 8)}`
      );
    }
    return super.afterSynthesize(audio, text, connection) as ArrayBuffer | null | Promise<ArrayBuffer | null>;
  }

  /**
   * TEMP: [voice-dbg] `speak()` path (e.g. post–chat-typed TTS) — log hard failures.
   */
  override async speak(connection: Connection, text: string): Promise<void> {
    console.info(
      `[voice-dbg] speak id=${this._voiceDbgTurn || "n/a"} text_len=${(text ?? "").length} ` +
        `conn=${String(connection.id).slice(0, 8)}`
    );
    try {
      await super.speak(connection, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[voice-dbg] speak_err id=${this._voiceDbgTurn || "n/a"} conn=${String(connection.id).slice(0, 8)} msg=${msg}`
      );
      throw e;
    }
  }

  override async onTurn(transcript: string, _context: VoiceTurnContext): Promise<TextSource> {
    this._inVoiceOnTurn = true;
    try {
      if (this._voiceDbgTurn.length === 0) {
        this._voiceDbgNewTurn("text_msg", _context.connection);
      }
      // TEMP: [voice-dbg]
      console.info(
        `[voice-dbg] on_turn id=${this._voiceDbgTurn} ` +
          `in_len=${(transcript ?? "").trim().length} conn=${String(_context.connection.id).slice(0, 8)}`
      );
      if (!this.enableVoice || !this.transcriber || !this.tts) {
        console.info(`[voice-dbg] on_turn_skip id=${this._voiceDbgTurn} reason=no_pipeline`);
        return "Voice is not enabled on the server. Enable it in your deployment settings or wrangler vars.";
      }
      const text = transcript.trim();
      if (!text) {
        console.info(`[voice-dbg] on_turn_skip id=${this._voiceDbgTurn} reason=empty_utterance`);
        return "I did not catch that. Please try again.";
      }
      try {
        const userId = crypto.randomUUID();
        const result = await this.saveMessages([
          {
            id: userId,
            role: "user",
            parts: [{ type: "text" as const, text }],
          },
        ]);
        if (result.status === "skipped") {
          console.info(`[voice-dbg] llm_skip id=${this._voiceDbgTurn} reason=saveMessages_skipped`);
          return "That request was skipped. Please try again.";
        }
        const all = this.getMessages();
        const response = voiceLastAssistantPlainText(all);
        if (!response) {
          console.info(`[voice-dbg] llm_text id=${this._voiceDbgTurn} text_len=0 empty=1`);
          return "I processed your request but have no text reply to read aloud. Check the chat panel.";
        }
        const r = response;
        const sn = r.length > 120 ? `${r.slice(0, 120)}…` : r;
        // TEMP: [voice-dbg]
        console.info(
          `[voice-dbg] llm_text id=${this._voiceDbgTurn} text_len=${r.length} ` +
            `snip=${JSON.stringify(sn)}`
        );
        // Spoken line only: same assistant markdown remains in history; TTS uses voice-safe text.
        return deriveSpokenText(response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[voice-dbg] on_turn_err id=${this._voiceDbgTurn} err=${msg}`);
        console.error("[MainAgent] onTurn (voice) failed:", err);
        return err instanceof Error
          ? `Sorry, something went wrong: ${err.message}`
          : "Sorry, something went wrong with voice request.";
      }
    } finally {
      this._inVoiceOnTurn = false;
    }
  }

  /**
   * Returns the app-level voice service helper (separate from @cloudflare/voice WebSocket).
   */
  getVoiceService(): VoiceService {
    return this.voiceService;
  }

  // ── Sub-agent delegation ────────────────────────────────────────

  /**
   * Child-side: run one buffered Think turn via {@link Think.saveMessages} and return {@link SubAgentResult}.
   *
   * The parent calls `subAgent(...).rpcCollectChatTurn(message)` with a **plain string** only.
   * We intentionally do **not** use `this.chat(..., StreamCallback)` on the cross-DO RPC path: a
   * callback-adjacent stream lifecycle plus Agents `AsyncLocalStorage` (`connection` / native I/O)
   * can produce “Cannot perform I/O on behalf of a different Durable Object”.
   *
   * `saveMessages` still runs the same inference + tools pipeline; assistant text is read from
   * persisted `getMessages()` after the turn. {@link SubAgentResult.events} is left empty here.
   */
  @callable()
  async rpcCollectChatTurn(message: string): Promise<SubAgentResult> {
    return executeRpcCollectChatTurn(this, typeof message === "string" ? message : "");
  }

  /**
   * Delegate a turn to a named child agent via Think’s sub-agent RPC pattern.
   *
   * The child runs as an independent Durable Object (facet) with its own SQLite-backed
   * session, workspace, tools, and conversation history. Delegation uses the child’s
   * {@link rpcCollectChatTurn} (buffered `saveMessages` inside the child — no streaming callback on RPC).
   *
   * How it works:
   *   1. `this.subAgent(agentClass, name)` resolves (or creates) the child DO.
   *   2. `stub.rpcCollectChatTurn(message)` runs the child turn and returns a {@link SubAgentResult}.
   *
   * Limitations: `options.onEvent` and `options.tools` are not supported across this RPC boundary.
   * Only a string `message` is sent to the child; keep `DelegationOptions` to serializable fields.
   *
   * The `agentClass` must be exported from the Worker entry point by its class
   * name so Think can resolve it via `ctx.exports`.
   *
   * @param agentClass   The sub-agent class (must extend {@link Think} — e.g. {@link MainAgent} or {@link BaseSubAgentThink}).
   * @param name         Stable instance name — Think maps this to a unique DO ID.
   * @param message      User message to send to the child agent.
   * @param options      Optional: `sharedProjectId` / `subAgentInstanceSuffix` / `statelessSubAgentModelTurn`.
   *
   * @example
   *   const result = await this.delegateTo(
   *     ResearchAgent, "research-session-1",
   *     "Find papers on Cloudflare Durable Objects"
   *   );
   *   console.log(result.text);
   */
  async delegateTo<T extends Think>(
    agentClass: new (ctx: DurableObjectState, env: never) => T,
    name: string,
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    if (options.onEvent != null) {
      throw new Error(
        "delegateTo: options.onEvent is not supported across sub-agent RPC (use in-process chat only)."
      );
    }
    if (options.tools != null && Object.keys(options.tools).length > 0) {
      throw new Error(
        "delegateTo: options.tools cannot be merged across sub-agent RPC; register tools on the child class."
      );
    }

    const self = this as unknown as {
      subAgent(
        cls: new (ctx: DurableObjectState, env: never) => T,
        name: string
      ): Promise<{
        rpcCollectChatTurn(msg: string): Promise<SubAgentResult>;
        rpcCollectStatelessModelTurn?(msg: string): Promise<SubAgentResult>;
      }>;
    };

    const stub = await self.subAgent(agentClass, name);
    const safeMessage = truncateMessageForSubagentRpcInbound(message);
    // Outbound sub-agent RPC must not run while AsyncLocalStorage still attributes this isolate to
    // the parent WebSocket `connection` (common when `debugRunOrchestrationRpc` is invoked over
    // the chat protocol). Think's `chat()` streams *after* an inner `agentContext.run` scope; that
    // stream iteration can otherwise bind Native I/O to the wrong DO. Clearing `connection`/`request`
    // for the duration of the child RPC keeps the parent facet neutral during the await.
    return __DO_NOT_USE_WILL_BREAK__agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined,
      },
      async () => {
        if (options.statelessSubAgentModelTurn === true) {
          const alt = stub.rpcCollectStatelessModelTurn;
          if (typeof alt !== "function") {
            throw new Error(
              "delegateTo: statelessSubAgentModelTurn requires the child class to expose @callable rpcCollectStatelessModelTurn (CoderAgent/TesterAgent)."
            );
          }
          return alt.call(stub, safeMessage);
        }
        return stub.rpcCollectChatTurn(safeMessage);
      }
    );
  }

  /**
   * Delegate a research task to a `ResearchAgent` child.
   *
   * Creates or reuses a child DO named `research-${sessionId}` where
   * `sessionId` is the current request ID. This gives each parent turn its
   * own isolated research thread while allowing resumability.
   *
   * @param message  Research question or synthesis task.
   * @param options  Optional: naming / shared-project context only (see {@link DelegationOptions}).
   *
   * @example
   *   const result = await this.delegateToResearch(
   *     "Summarize the latest Cloudflare Workers DX improvements"
   *   );
   *   return result.text;
   */
  async delegateToResearch(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    // Lazy import avoids circular dep at module init time.
    const { ResearchAgent } = await import("./subagents/ResearchAgent");
    return this.delegateTo(
      ResearchAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      `research-${this.requestId}`,
      message,
      options
    );
  }

  /**
   * Delegate an execution task to an `ExecutionAgent` child.
   *
   * Creates or reuses a child DO named `execution-${sessionId}`.
   *
   * @param message  Task or structured workflow to execute.
   * @param options  Optional: naming / shared-project context only (see {@link DelegationOptions}).
   *
   * @example
   *   const result = await this.delegateToExecution(
   *     "Run the data validation pipeline and report results"
   *   );
   *   return result.text;
   */
  async delegateToExecution(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    const { ExecutionAgent } = await import("./subagents/ExecutionAgent");
    return this.delegateTo(
      ExecutionAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      `execution-${this.requestId}`,
      message,
      options
    );
  }

  /**
   * When `env.SUBAGENT_COORDINATOR` is bound, coder/tester delegation runs in {@link SubagentCoordinatorThink}
   * via `stub.fetch` + JSON (minimal Think parent — see Cloudflare Agents sub-agent RFCs).
   */
  protected subagentCoordinatorBound(): boolean {
    return this.env.SUBAGENT_COORDINATOR != null;
  }

  /** Fresh coordinator DO name for one coding loop or single delegate call. */
  protected newCoordinatorRunName(prefix: string): string {
    return sanitizeCoordinatorInstanceName(`${prefix}-${crypto.randomUUID()}`);
  }

  /**
   * Delegate a coding-oriented turn to a `CoderAgent` child (isolated DO + session).
   *
   * **Canonical path:** when `env.SUBAGENT_COORDINATOR` is bound, this method does **not** call
   * `subAgent(CoderAgent)` from MainAgent — it forwards JSON to {@link SubagentCoordinatorThink}.
   * All production coder entrypoints should go through here (or through {@link runCodingCollaborationLoop},
   * which uses this method).
   */
  async delegateToCoder(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    if (this.subagentCoordinatorBound()) {
      return invokeCoordinatorDelegateCoder(
        this.env,
        this.newCoordinatorRunName("dc"),
        message,
        options
      );
    }
    const { CoderAgent } = await import("./subagents/CoderAgent");
    const envelopeObs =
      options.sharedProjectId != null
        ? {
            controlPlaneProjectId: options.controlPlaneProjectId,
            taskId: options.controlPlaneTaskId,
            runId: options.controlPlaneRunId,
          }
        : undefined;
    let body =
      options.sharedProjectId != null
        ? formatSharedDelegationEnvelope(
            options.sharedProjectId,
            "coder",
            message,
            envelopeObs
          )
        : message;
    if (
      options.debugDisableSharedWorkspaceTools === true &&
      isDebugOrchestrationEnvEnabled(this.env)
    ) {
      body = DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX + body;
    }
    const childName =
      options.subAgentInstanceSuffix != null
        ? `coder-${this.requestId}-${options.subAgentInstanceSuffix}`
        : `coder-${this.requestId}`;
    return this.delegateTo(
      CoderAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName,
      body,
      options
    );
  }

  /**
   * Delegate a read/verification-oriented turn to a `TesterAgent` child.
   */
  async delegateToTester(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    if (this.subagentCoordinatorBound()) {
      return invokeCoordinatorDelegateTester(
        this.env,
        this.newCoordinatorRunName("dt"),
        message,
        options
      );
    }
    const { TesterAgent } = await import("./subagents/TesterAgent");
    const envelopeObs =
      options.sharedProjectId != null
        ? {
            controlPlaneProjectId: options.controlPlaneProjectId,
            taskId: options.controlPlaneTaskId,
            runId: options.controlPlaneRunId,
          }
        : undefined;
    let body =
      options.sharedProjectId != null
        ? formatSharedDelegationEnvelope(
            options.sharedProjectId,
            "tester",
            message,
            envelopeObs
          )
        : message;
    if (
      options.debugDisableSharedWorkspaceTools === true &&
      isDebugOrchestrationEnvEnabled(this.env)
    ) {
      body = DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX + body;
    }
    const childName =
      options.subAgentInstanceSuffix != null
        ? `tester-${this.requestId}-${options.subAgentInstanceSuffix}`
        : `tester-${this.requestId}`;
    return this.delegateTo(
      TesterAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName,
      body,
      options
    );
  }

  /**
   * DEBUG ONLY — {@link delegateTo} with a minimal Think child (Workers AI + empty tools), same RPC
   * boundary as {@link delegateToCoder}. Gated by {@link isDebugOrchestrationEnvEnabled}; not for production.
   */
  async delegateToDebugMinimalDelegationChild(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "delegateToDebugMinimalDelegationChild requires ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker."
      );
    }
    const { DebugMinimalDelegationChildThink } = await import("../debug/DebugMinimalDelegationChildThink");
    const childName =
      options.subAgentInstanceSuffix != null
        ? `debug-minimal-delegation-${this.requestId}-${options.subAgentInstanceSuffix}`
        : `debug-minimal-delegation-${this.requestId}`;
    console.info(
      "debug_minimal_delegation_parent_before_child",
      JSON.stringify({
        requestId: this.requestId,
        childName,
        stateless: options.statelessSubAgentModelTurn === true,
        messageChars: typeof message === "string" ? message.length : 0,
      })
    );
    return this.delegateTo(
      DebugMinimalDelegationChildThink as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName,
      typeof message === "string" ? message : "",
      options
    );
  }

  /**
   * DEBUG ONLY — same transport shell as {@link delegateTo} (subAgent + neutral `agentContext` during
   * the await) but invokes `DebugPingChildThink.rpcPing` instead of `rpcCollectChatTurn` (no model / saveMessages / tools).
   */
  async delegateToDebugPingChildTransportProbe(options: {
    subAgentInstanceSuffix?: string;
  } = {}): Promise<{ ok: boolean; who: string }> {
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "delegateToDebugPingChildTransportProbe requires ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker."
      );
    }
    const { DebugPingChildThink } = await import("../debug/DebugPingChildThink");
    const childName =
      options.subAgentInstanceSuffix != null
        ? `debug-ping-child-${this.requestId}-${options.subAgentInstanceSuffix}`
        : `debug-ping-child-${this.requestId}`;

    console.info(
      "debug_delegated_child_ping_parent_before_child",
      JSON.stringify({ requestId: this.requestId, childName })
    );

    const self = this as unknown as {
      subAgent(
        cls: new (ctx: DurableObjectState, env: never) => Think,
        name: string
      ): Promise<{ rpcPing(): Promise<{ ok: boolean; who: string }> }>;
    };

    const stub = await self.subAgent(
      DebugPingChildThink as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName
    );

    const result = await __DO_NOT_USE_WILL_BREAK__agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined,
      },
      async () => stub.rpcPing()
    );

    console.info(
      "debug_delegated_child_ping_parent_after_child",
      JSON.stringify({ requestId: this.requestId, childName, result })
    );

    return result;
  }

  /**
   * Manager-led coding loop: coder proposes → tester verifies → orchestrator applies or requests revision / user approval.
   * Requires `SHARED_WORKSPACE_KV`. Interactive-first; persist `loopRunId` + iteration externally when moving to Workflows.
   */
  async runCodingCollaborationLoop(
    input: CodingCollaborationLoopInput
  ): Promise<CodingCollaborationLoopResult> {
    if (this.subagentCoordinatorBound()) {
      return invokeCoordinatorCodingLoop(
        this.env,
        this.newCoordinatorRunName("cl"),
        input
      );
    }
    const loopRunId = crypto.randomUUID();
    const parentRequestId = this.requestId;
    return runCodingCollaborationLoop(
      {
        loopRunId,
        parentRequestId,
        delegateToCoder: (m, o) => this.delegateToCoder(m, o),
        delegateToTester: (m, o) => this.delegateToTester(m, o),
        getOrchestratorGateway: () => getSharedWorkspaceGateway(this.env),
        log: (event, data) => {
          console.info(`[EdgeClaw][coding-loop][${loopRunId}] ${event}`, data);
        },
      },
      input
    );
  }

  /**
   * Callable RPC for smoke-testing {@link delegateToCoder} without natural-language routing.
   * Remove or harden before exposing broadly — surfaced via `useAgent()` like other `@callable()` methods.
   */
  @callable()
  async debugSmokeDelegateCoder(message: string): Promise<SubAgentResult> {
    const m = typeof message === "string" ? message.trim() : "";
    if (!m) {
      throw new Error("debugSmokeDelegateCoder: message must be non-empty.");
    }
    return this.delegateToCoder(`[smoke] ${m}`);
  }

  /**
   * Callable RPC for smoke-testing {@link delegateToTester}.
   * @see debugSmokeDelegateCoder
   */
  @callable()
  async debugSmokeDelegateTester(message: string): Promise<SubAgentResult> {
    const m = typeof message === "string" ? message.trim() : "";
    if (!m) {
      throw new Error("debugSmokeDelegateTester: message must be non-empty.");
    }
    return this.delegateToTester(`[smoke] ${m}`);
  }

  /**
   * Callable RPC — exercise {@link runCodingCollaborationLoop} (requires shared workspace KV).
   */
  @callable()
  async debugCodingCollaborationLoop(payload: {
    sharedProjectId: string;
    task: string;
    maxIterations?: number;
    autoApplyVerifiedPatches?: boolean;
  }): Promise<CodingCollaborationLoopResult> {
    const sharedProjectId =
      typeof payload.sharedProjectId === "string" ? payload.sharedProjectId.trim() : "";
    const task = typeof payload.task === "string" ? payload.task.trim() : "";
    if (!sharedProjectId || !task) {
      throw new Error("debugCodingCollaborationLoop: sharedProjectId and task are required.");
    }
    return this.runCodingCollaborationLoop({
      sharedProjectId,
      task,
      maxIterations: payload.maxIterations,
      autoApplyVerifiedPatches: payload.autoApplyVerifiedPatches === true,
      exitOnPassWithoutAutoApply: payload.autoApplyVerifiedPatches !== true,
    });
  }

  /**
   * DEBUG ONLY — real {@link runCodingCollaborationLoop} over the fixed debug shared project id
   * (`orchestrationDebugProjectId.ts`). Used by `GET|POST /api/debug/orchestrate` (Worker-gated).
   * Re-checks `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT` in the DO.
   *
   * `entry` selects log prefix only (`http_debug_orchestration_start` vs `rpc_debug_orchestration_start`).
   * `runOptions` controls child turn mode and optional shared-workspace tool stripping (debug orchestration only).
   *
   * TODO(remove or harden): Temporary diagnostic surface; do not use for production traffic.
   */
  async runDebugOrchestrationScenario(
    mode: DebugOrchestrationMode,
    entry: "http" | "rpc" = "http",
    runOptions?: DebugOrchestrationRunOptions
  ): Promise<DebugOrchestrationScenarioOutcome> {
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug orchestration is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    const childTurn = runOptions?.childTurn ?? "normal";
    const disableShared = runOptions?.disableSharedWorkspaceTools === true;
    const stateless = childTurn === "stateless";
    const cpProjectId = runOptions?.controlPlaneProjectId?.trim();
    const cpTaskIdRaw = runOptions?.controlPlaneTaskId?.trim();
    const cpTaskId = cpTaskIdRaw && cpTaskIdRaw.length > 0 ? cpTaskIdRaw : undefined;

    if (cpTaskId && !cpProjectId) {
      throw new OrchestrationBlueprintError(
        "taskId requires projectId (control-plane project) for orchestration.",
        400
      );
    }

    type DebugOrchMeta = NonNullable<DebugOrchestrationScenarioOutcome["orchestrationMeta"]>;
    let orchestrationMeta: DebugOrchMeta = {
      projectIdUsed: null,
      taskIdUsed: null,
      blueprintContextLoaded: false,
      coordinatorPathUsed: this.subagentCoordinatorBound(),
      controlPlaneRunRecorded: false,
      controlPlaneRunId: null,
    };

    let sharedProjectId = ORCHESTRATION_DEBUG_SHARED_PROJECT_ID;
    let controlPlaneProjectIdForLoop: string | undefined;
    let projectBlueprintPackage: ProjectBlueprintContextPackage | undefined;
    let validatedTaskForPrompt:
      | { task: import("../coordinatorControlPlane/types").CoordinatorTask; projectDisplayName: string }
      | undefined;

    if (cpProjectId) {
      const pkg = await loadReadyControlPlaneProjectBlueprint(this.env, cpProjectId);
      projectBlueprintPackage = pkg;
      sharedProjectId = pkg.sharedProjectId;
      controlPlaneProjectIdForLoop = pkg.projectId;
      orchestrationMeta = {
        ...orchestrationMeta,
        projectIdUsed: pkg.projectId,
        blueprintContextLoaded: true,
        blueprintReadiness: pkg.readiness,
      };

      if (cpTaskId) {
        const row = await getTaskById(this.env, cpTaskId);
        const taskRow = assertTaskRunnableForProject(row, cpProjectId);
        validatedTaskForPrompt = { task: taskRow, projectDisplayName: pkg.projectName };
        orchestrationMeta = {
          ...orchestrationMeta,
          taskIdUsed: taskRow.taskId,
        };
      }
    }

    const managerTask = buildDebugOrchestrationManagerTask(mode, sharedProjectId, validatedTaskForPrompt);
    const sessionId = parseDebugOrchestrationSessionId(runOptions?.sessionId);
    const runSource = entry === "http" ? ("debug_http_orchestrate" as const) : ("debug_rpc_orchestrate" as const);

    return __DO_NOT_USE_WILL_BREAK__agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined,
      },
      async () => {
        console.info(
          entry === "rpc" ? "rpc_debug_orchestration_start" : "http_debug_orchestration_start",
          JSON.stringify({
            mode,
            childTurn,
            disableSharedWorkspaceTools: disableShared,
            controlPlaneProjectId: cpProjectId ?? null,
            controlPlaneTaskId: cpTaskId ?? null,
            sharedProjectIdUsed: sharedProjectId,
            blueprintContextLoaded: orchestrationMeta.blueprintContextLoaded,
            sessionId,
          })
        );

        let persistedRunId: string | null = null;
        let loopResult: CodingCollaborationLoopResult | null = null;
        const taskBackedKvLive =
          !!(cpTaskId && cpProjectId && this.env.COORDINATOR_CONTROL_PLANE_KV);
        /** True after finalize succeeds or abort path successfully wrote KV (avoids zombie `running` rows). */
        let controlPlaneRunTerminalized = false;
        const tryAbortTaskBackedRun = async (errorMessage: string): Promise<void> => {
          if (!persistedRunId || !taskBackedKvLive || !cpProjectId || !cpTaskId) return;
          try {
            await abortTaskBackedDebugOrchestrationRun(this.env, {
              runId: persistedRunId,
              projectId: cpProjectId,
              taskId: cpTaskId,
              errorMessage,
              coordinatorPathUsed: orchestrationMeta.coordinatorPathUsed ?? false,
              blueprintContextLoaded: orchestrationMeta.blueprintContextLoaded ?? false,
            });
            await appendFollowUpCoordinatorTasksAfterRun(this.env, {
              projectId: cpProjectId,
              parentTaskId: cpTaskId,
              runId: persistedRunId,
              result: null,
              parentTitle: validatedTaskForPrompt?.task.title,
              abortMessage: errorMessage,
            });
            controlPlaneRunTerminalized = true;
          } catch (e2) {
            console.warn("[EdgeClaw][task-orchestration] abort or follow-up append failed", e2);
          }
        };

        try {
          if (cpTaskId && cpProjectId && this.env.COORDINATOR_CONTROL_PLANE_KV) {
            persistedRunId = crypto.randomUUID();
            try {
              await beginTaskBackedDebugOrchestrationRun(this.env, {
                runId: persistedRunId,
                projectId: cpProjectId,
                taskId: cpTaskId,
                sessionId,
                source: runSource,
                coordinatorPathUsed: orchestrationMeta.coordinatorPathUsed ?? false,
                blueprintContextLoaded: orchestrationMeta.blueprintContextLoaded ?? false,
              });
              orchestrationMeta = {
                ...orchestrationMeta,
                controlPlaneRunRecorded: true,
                controlPlaneRunId: persistedRunId,
              };
            } catch (e) {
              console.warn("[EdgeClaw][task-orchestration] beginTaskBackedDebugOrchestrationRun failed", e);
              persistedRunId = null;
            }
          }

          const opNote = validatedTaskForPrompt?.task.operatorRevisionNote?.trim();
          loopResult = await this.runCodingCollaborationLoop({
            sharedProjectId,
            task: managerTask,
            maxIterations: mode === "fail_revise" ? 6 : 4,
            autoApplyVerifiedPatches: true,
            scopeTesterToNewPatchesOnly: true,
            statelessSubAgentModelTurn: stateless,
            debugDisableSharedWorkspaceTools: disableShared,
            projectBlueprintPackage,
            controlPlaneProjectId: controlPlaneProjectIdForLoop,
            ...(cpTaskId ? { controlPlaneTaskId: cpTaskId } : {}),
            ...(persistedRunId ? { controlPlaneRunId: persistedRunId } : {}),
            ...(opNote ? { operatorRevisionNote: opNote } : {}),
          });

          let followUpCreated: string[] = [];
          let followUpSkipped: string[] = [];
          if (persistedRunId && cpTaskId && cpProjectId && this.env.COORDINATOR_CONTROL_PLANE_KV) {
            try {
              await finalizeTaskBackedDebugOrchestrationRun(this.env, {
                runId: persistedRunId,
                projectId: cpProjectId,
                taskId: cpTaskId,
                result: loopResult,
                coordinatorPathUsed: orchestrationMeta.coordinatorPathUsed ?? false,
                blueprintContextLoaded: orchestrationMeta.blueprintContextLoaded ?? false,
                blueprintContextAssembly: loopResult.blueprintContextAssembly ?? null,
              });
              controlPlaneRunTerminalized = true;
              try {
                const fu = await appendFollowUpCoordinatorTasksAfterRun(this.env, {
                  projectId: cpProjectId,
                  parentTaskId: cpTaskId,
                  runId: persistedRunId,
                  result: loopResult,
                  parentTitle: validatedTaskForPrompt?.task.title,
                });
                followUpCreated = fu.createdTaskIds;
                followUpSkipped = fu.skippedReasons;
                if (followUpCreated.length > 0) {
                  try {
                    await patchCoordinatorRun(this.env, persistedRunId, { followUpTaskIds: followUpCreated });
                  } catch (patchErr) {
                    console.warn("[EdgeClaw][task-orchestration] patchCoordinatorRun followUps failed", patchErr);
                  }
                }
              } catch (e) {
                console.warn("[EdgeClaw][task-orchestration] follow-up append after finalize failed", e);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn("[EdgeClaw][task-orchestration] finalizeTaskBackedDebugOrchestrationRun failed", e);
              await tryAbortTaskBackedRun(`finalize failed: ${msg}`);
            }
          }

          const iterationTrace = loopResult.iterations.map((record) =>
            JSON.stringify({
              iteration: record.iteration,
              subAgentSuffix: record.subAgentSuffix,
              newPendingPatchIds: record.newPendingPatchIds,
              pendingPatchIdsAfterCoder: record.pendingPatchIdsAfterCoder,
              activePatchIdsForIteration: record.activePatchIdsForIteration,
              testerVerdict: record.testerVerdict,
              managerDecision: record.managerDecision,
            })
          );
          return {
            result: loopResult,
            iterationTrace,
            childTurnModeUsed: stateless ? "stateless" : "normal",
            sharedWorkspaceToolsEnabled: !disableShared,
            orchestrationMeta: {
              ...orchestrationMeta,
              blueprintContextAssembly: loopResult.blueprintContextAssembly ?? null,
              ...(followUpCreated.length ? { followUpTasksCreated: followUpCreated } : {}),
              ...(followUpSkipped.length ? { followUpTasksSkipped: followUpSkipped } : {}),
            },
          };
        } catch (e) {
          if (!controlPlaneRunTerminalized && persistedRunId && taskBackedKvLive) {
            const msg = e instanceof Error ? e.message : String(e);
            await tryAbortTaskBackedRun(msg);
          }
          throw e;
        } finally {
          if (!controlPlaneRunTerminalized && persistedRunId && taskBackedKvLive) {
            await tryAbortTaskBackedRun(
              "run was still active in KV after orchestration (client disconnect, coordinator cancel, or earlier abort failure); closed in finally"
            );
          }
        }
      }
    );
  }

  /**
   * DEBUG ONLY — bounded project autonomy: pick the next runnable task (`todo` or `in_progress`), run task-backed orchestration,
   * optionally repeat up to {@link ProjectAutonomyScenarioInput.maxSteps}. Stops on explicit flags (review,
   * blocked terminal outcomes, follow-up tasks created) or when no runnable task remains.
   */
  async runProjectAutonomyScenario(
    input: ProjectAutonomyScenarioInput
  ): Promise<ProjectAutonomyScenarioResult> {
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug orchestration is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }

    const steps: ProjectAutonomyStepRecord[] = [];
    let totalFollowUpsCreated = 0;
    let explicitStop: ProjectAutonomyStopReason | undefined;
    let pickAudit: ProjectAutonomyScenarioResult["pickAudit"];

    const mapPickFailure = async (reason: PickRunnableTaskFailureReason): Promise<ProjectAutonomyStopReason> => {
      if (reason === "project_not_found") return "project_not_found";
      if (reason === "project_archived") return "project_archived";
      if (reason === "project_not_ready") return "project_not_ready";
      if (reason === "dependency_blocked") return "dependency_unmet";
      if (reason === "no_runnable_tasks") return "no_runnable_tasks";
      if (reason === "no_todo_tasks") {
        return "project_complete_candidate";
      }
      return "no_runnable_tasks";
    };

    const isBlockedTerminal = (s: DebugOrchestrationScenarioOutcome["result"]["status"]): boolean =>
      s === "blocked_no_shared_workspace" || s === "stopped_aborted" || s === "completed_failure";

    for (let stepIndex = 0; stepIndex < input.maxSteps; stepIndex++) {
      const pick = await pickNextRunnableTaskForProject(this.env, input.projectId);
      if (!pick.ok) {
        explicitStop = await mapPickFailure(pick.reason);
        if (pick.reason === "dependency_blocked" && pick.skippedDueToDependencies?.length) {
          pickAudit = { skippedDueToDependencies: pick.skippedDueToDependencies };
        }
        console.info(
          "project_autonomy_stop",
          JSON.stringify({
            projectId: input.projectId,
            stopReason: explicitStop,
            pickFailure: pick.reason,
            stepIndex,
            ...(pickAudit ? { pickAudit } : {}),
          })
        );
        break;
      }

      console.info(
        "project_autonomy_pick",
        JSON.stringify({
          projectId: input.projectId,
          taskId: pick.task.taskId,
          selectionReason: pick.selectionReason,
          stepIndex,
          sessionId: input.sessionId,
        })
      );

      const runOptions = {
        controlPlaneProjectId: input.projectId,
        controlPlaneTaskId: pick.task.taskId,
        sessionId: input.sessionId,
      };

      let outcome = await this.runDebugOrchestrationScenario(input.mode, "http", runOptions);

      const deployResetRetry =
        outcome.result.status === "completed_failure" &&
        orchestrationResultIndicatesDeployReset(outcome.result);
      if (deployResetRetry) {
        const failedRunId = outcome.orchestrationMeta?.controlPlaneRunId ?? null;
        let canRetry = true;
        if (this.env.COORDINATOR_CONTROL_PLANE_KV && failedRunId) {
          const t = await getTaskById(this.env, pick.task.taskId);
          if (t?.status === "blocked" && t.lastRunId === failedRunId) {
            const note = `retry_after_deploy_reset; previous_run=${failedRunId}`;
            await updateTask(this.env, pick.task.taskId, {
              status: "in_progress",
              lastRunErrorNote: note.length > 500 ? note.slice(0, 500) : note,
            });
          } else if (t?.status === "blocked" && t.lastRunId != null && t.lastRunId !== failedRunId) {
            canRetry = false;
          }
        }
        if (canRetry) {
          console.info(
            "project_autonomy_orchestration_retry_after_deploy_reset",
            JSON.stringify({
              projectId: input.projectId,
              taskId: pick.task.taskId,
              stepIndex,
              ...(failedRunId ? { failedRunId } : {}),
            })
          );
          outcome = await this.runDebugOrchestrationScenario(input.mode, "http", runOptions);
        }
      }

      const loopStatus = outcome.result.status;
      const followUps = outcome.orchestrationMeta?.followUpTasksCreated ?? [];
      totalFollowUpsCreated += followUps.length;

      const row = await getTaskById(this.env, pick.task.taskId);
      const summary = outcome.result.summaryForUser;
      steps.push({
        taskId: pick.task.taskId,
        selectionReason: pick.selectionReason,
        loopTerminalStatus: loopStatus,
        taskStatusAfter: row?.status,
        followUpTaskIds: followUps,
        summaryPreview: summary.length > 280 ? `${summary.slice(0, 280)}…` : summary,
      });

      if (input.stopOnFollowUpTasks && followUps.length > 0) {
        explicitStop = "follow_up_tasks_created";
        console.info(
          "project_autonomy_stop",
          JSON.stringify({
            projectId: input.projectId,
            stopReason: explicitStop,
            followUpTaskIds: followUps,
            stepIndex,
          })
        );
        break;
      }
      if (input.stopOnReview && loopStatus === "needs_user_approval") {
        explicitStop = "review_required";
        console.info(
          "project_autonomy_stop",
          JSON.stringify({ projectId: input.projectId, stopReason: explicitStop, stepIndex })
        );
        break;
      }
      if (input.stopOnBlocked && isBlockedTerminal(loopStatus)) {
        explicitStop = "blocked";
        console.info(
          "project_autonomy_stop",
          JSON.stringify({ projectId: input.projectId, stopReason: explicitStop, loopStatus, stepIndex })
        );
        break;
      }
    }

    const stopReason: ProjectAutonomyStopReason = explicitStop ?? "max_steps_reached";

    console.info(
      "project_autonomy_complete",
      JSON.stringify({
        projectId: input.projectId,
        stopReason,
        stepsExecuted: steps.length,
        maxStepsRequested: input.maxSteps,
        totalFollowUpsCreated,
      })
    );

    return {
      debug: true,
      autonomy: true,
      projectId: input.projectId,
      sessionId: input.sessionId,
      maxStepsRequested: input.maxSteps,
      stepsExecuted: steps.length,
      stopReason,
      steps,
      totalFollowUpsCreated,
      ...(pickAudit ? { pickAudit } : {}),
    };
  }

  /**
   * DEBUG ONLY — baseline: MainAgent → `subAgent(ReproChildThink).chat(...)` (minimal Think child, no CoderAgent).
   * Compare when Coder path fails but isolated Think repro passes. Same auth gate as debug orchestration.
   */
  @callable()
  async debugChatChildBaselineFromMainRpc(payload?: {
    debugOrchestrationToken?: string;
    message?: string;
  }): Promise<Record<string, unknown>> {
    const p = payload ?? {};
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug baseline is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    if (!debugOrchestrationSecretMatches(this.env, p.debugOrchestrationToken)) {
      throw new Error(
        "Unauthorized — pass debugOrchestrationToken matching Workers secret DEBUG_ORCHESTRATION_TOKEN."
      );
    }
    const { ReproChildThink } = await import("../repro/subagentThinkReproDo");
    return __DO_NOT_USE_WILL_BREAK__agentContext.run(
      {
        agent: this,
        connection: undefined,
        request: undefined,
        email: undefined,
      },
      async () => {
        const self = this as unknown as {
          subAgent(
            cls: new (ctx: DurableObjectState, env: never) => Think,
            name: string
          ): Promise<{ chat(msg: string, cb: StreamCallback, opts?: object): Promise<void> }>;
        };
        const stub = await self.subAgent(
          ReproChildThink as unknown as new (ctx: DurableObjectState, env: never) => Think,
          `baseline-${this.requestId}`
        );
        const events: string[] = [];
        const callback: StreamCallback = {
          onEvent(json: string) {
            events.push(json);
          },
          async onDone() {},
          onError(err: string) {
            throw new Error(err);
          },
        };
        const msg = typeof p.message === "string" && p.message.trim() ? p.message.trim() : "hello";
        await stub.chat(msg, callback, {});
        return {
          debug: true,
          probe: "main_agent_to_repro_child_think_chat",
          message: msg,
          streamEventCount: events.length,
          lastEventPreview:
            events.length > 0 ? events[events.length - 1]!.slice(0, 800) : null,
        };
      }
    );
  }

  /**
   * DEBUG ONLY — exercise real {@link delegateTo} / `rpcCollectChatTurn` (or stateless RPC) against
   * {@link DebugMinimalDelegationChildThink} instead of CoderAgent. Same token gate as other debug orchestration RPCs.
   */
  @callable()
  async debugDelegateMinimalChildLikeCoderRpc(payload?: {
    debugOrchestrationToken?: string;
    message?: string;
    stateless?: boolean | string;
  }): Promise<Record<string, unknown>> {
    const p = payload ?? {};
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug minimal delegation is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    if (!debugOrchestrationSecretMatches(this.env, p.debugOrchestrationToken)) {
      throw new Error(
        "Unauthorized — pass debugOrchestrationToken matching Workers secret DEBUG_ORCHESTRATION_TOKEN."
      );
    }
    const msg =
      typeof p.message === "string" && p.message.trim()
        ? p.message.trim()
        : "[debug] minimal delegation probe — reply briefly.";
    const stateless =
      p.stateless === true || (typeof p.stateless === "string" && p.stateless.toLowerCase() === "true");
    const result = await this.delegateToDebugMinimalDelegationChild(msg, {
      statelessSubAgentModelTurn: stateless,
    });
    console.info(
      "debug_minimal_delegation_parent_after_child",
      JSON.stringify({
        requestId: this.requestId,
        childRpc: stateless ? "rpcCollectStatelessModelTurn" : "rpcCollectChatTurn",
        ok: result.ok,
        textLen: (result.text ?? "").length,
      })
    );
    return {
      debug: true,
      probe: "main_delegate_to_minimal_child_like_coder",
      stateless,
      ok: result.ok,
      text: result.text,
      error: result.error,
      eventsCount: result.events.length,
    };
  }

  /**
   * DEBUG ONLY — `subAgent(DebugPingChildThink)` + neutral `agentContext` + `rpcPing()` (no chat stack).
   * Same transport framing as failing delegation paths; isolates cross-DO RPC from model/tools/messages.
   */
  @callable()
  async debugDelegatedChildPingRpc(payload?: {
    debugOrchestrationToken?: string;
  }): Promise<Record<string, unknown>> {
    const p = payload ?? {};
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug delegated child ping is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    if (!debugOrchestrationSecretMatches(this.env, p.debugOrchestrationToken)) {
      throw new Error(
        "Unauthorized — pass debugOrchestrationToken matching Workers secret DEBUG_ORCHESTRATION_TOKEN."
      );
    }
    const ping = await this.delegateToDebugPingChildTransportProbe();
    return {
      debug: true,
      probe: "main_delegated_child_ping_transport",
      ping,
    };
  }

  /**
   * DEBUG ONLY — same outcome as `GET /api/debug/orchestrate`, callable over the chat WebSocket (RPC).
   * Gated by `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT`. When Workers secret `DEBUG_ORCHESTRATION_TOKEN` is set,
   * pass the same string as `debugOrchestrationToken`.
   *
   * This exercises the real manager → CoderAgent → TesterAgent loop on the sandbox debug project id
   * (see `orchestrationDebugProjectId.ts` and `runDebugOrchestrationScenario`).
   */
  @callable()
  async debugRunOrchestrationRpc(payload?: {
    mode?: string;
    debugOrchestrationToken?: string;
    childTurn?: string;
    noSharedTools?: string | boolean;
    /** Control-plane project id — same as HTTP `?projectId=` */
    projectId?: string;
    /** Control-plane task id — same as HTTP `?taskId=`; requires `projectId` */
    taskId?: string;
    /** Agent session id for persisted run rows (defaults to `default` when omitted). */
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const p = payload ?? {};
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug orchestration is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    if (!debugOrchestrationSecretMatches(this.env, p.debugOrchestrationToken)) {
      throw new Error(
        "Unauthorized — pass debugOrchestrationToken matching Workers secret DEBUG_ORCHESTRATION_TOKEN."
      );
    }
    const mode =
      typeof p.mode === "string" ? parseDebugOrchestrationMode(p.mode) : parseDebugOrchestrationMode(undefined);
    const childTurn = parseDebugChildTurnMode(typeof p.childTurn === "string" ? p.childTurn : undefined);
    const disableShared =
      typeof p.noSharedTools === "boolean"
        ? p.noSharedTools
        : parseDebugDisableSharedTools(typeof p.noSharedTools === "string" ? p.noSharedTools : undefined);
    const cpId = typeof p.projectId === "string" && p.projectId.trim() ? p.projectId.trim() : undefined;
    const taskId = typeof p.taskId === "string" && p.taskId.trim() ? p.taskId.trim() : undefined;
    const sessionId = parseDebugOrchestrationSessionId(
      typeof p.sessionId === "string" ? p.sessionId : undefined
    );
    const outcome = await this.runDebugOrchestrationScenario(mode, "rpc", {
      childTurn,
      disableSharedWorkspaceTools: disableShared,
      controlPlaneProjectId: cpId,
      controlPlaneTaskId: taskId,
      sessionId,
    });
    return formatDebugOrchestrationResponseBody({
      mode,
      result: outcome.result,
      iterationTrace: outcome.iterationTrace,
      childTurnModeUsed: outcome.childTurnModeUsed,
      sharedWorkspaceToolsForCoderTester: outcome.sharedWorkspaceToolsEnabled ? "enabled" : "disabled",
      orchestrationMeta: outcome.orchestrationMeta,
    });
  }

  /**
   * DEBUG ONLY — same outcome as `GET|POST /api/debug/project-autonomy`, over WebSocket RPC.
   */
  @callable()
  async runProjectAutonomyRpc(payload?: {
    debugOrchestrationToken?: string;
    projectId?: string;
    sessionId?: string;
    maxSteps?: number;
    stopOnReview?: boolean;
    stopOnBlocked?: boolean;
    stopOnFollowUpTasks?: boolean;
    mode?: string;
  }): Promise<ProjectAutonomyScenarioResult> {
    const p = payload ?? {};
    if (!isDebugOrchestrationEnvEnabled(this.env)) {
      throw new Error(
        "Debug orchestration is disabled (set ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true on the Worker)."
      );
    }
    if (!debugOrchestrationSecretMatches(this.env, p.debugOrchestrationToken)) {
      throw new Error(
        "Unauthorized — pass debugOrchestrationToken matching Workers secret DEBUG_ORCHESTRATION_TOKEN."
      );
    }
    const projectId = typeof p.projectId === "string" ? p.projectId.trim() : "";
    if (!projectId) {
      throw new Error("projectId is required");
    }
    const maxRaw = typeof p.maxSteps === "number" ? p.maxSteps : 1;
    const maxSteps = Math.min(3, Math.max(1, Number.isNaN(maxRaw) ? 1 : Math.floor(maxRaw)));
    return this.runProjectAutonomyScenario({
      projectId,
      sessionId: parseDebugOrchestrationSessionId(
        typeof p.sessionId === "string" ? p.sessionId : undefined
      ),
      maxSteps,
      stopOnReview: typeof p.stopOnReview === "boolean" ? p.stopOnReview : true,
      stopOnBlocked: typeof p.stopOnBlocked === "boolean" ? p.stopOnBlocked : true,
      stopOnFollowUpTasks: typeof p.stopOnFollowUpTasks === "boolean" ? p.stopOnFollowUpTasks : true,
      mode: parseDebugOrchestrationMode(typeof p.mode === "string" ? p.mode : undefined),
    });
  }

  // ── Promotion artifacts + Flagship release gates (orchestrator-only; not used by coding loop yet) ──

  /**
   * Validates shared-workspace patches are `approved`, then builds an in-memory promotion manifest.
   * Does not write Artifacts — call {@link buildPromotionArtifact} next.
   */
  async prepareApprovedPromotion(
    projectId: string,
    patchIds: readonly string[],
    options?: { verificationRefs?: readonly string[] }
  ): Promise<PrepareApprovedPromotionResult> {
    this.assertOrchestratorPromotionApis();
    const gateway = getSharedWorkspaceGateway(this.env);
    if (!gateway) {
      return { ok: false, error: "Shared workspace gateway unavailable (SHARED_WORKSPACE_KV)." };
    }
    return buildPromotionManifestFromApprovedPatches(gateway, projectId, patchIds, options);
  }

  /**
   * Manager-only: bridge a coding-loop outcome to promotion inputs — does **not** call
   * {@link buildPromotionArtifact} or {@link evaluateReleaseGate}. Keeps promotion explicit.
   */
  async derivePromotionCandidateFromCodingLoop(
    projectId: string,
    loopResult: CodingCollaborationLoopResult,
    options?: {
      patchIdsHint?: readonly string[];
      prepareApprovedPromotion?: boolean;
      verificationRefs?: readonly string[];
    }
  ): Promise<PromotionCandidateFromLoopResult> {
    this.assertOrchestratorPromotionApis();
    const gateway = getSharedWorkspaceGateway(this.env);
    if (!gateway) {
      return {
        kind: "failed_verification",
        approvedPatchIds: [],
        notes: "Shared workspace gateway unavailable (SHARED_WORKSPACE_KV).",
      };
    }
    const pid = typeof projectId === "string" ? projectId.trim() : "";
    return derivePromotionCandidateFromCodingLoopCore(gateway, pid, loopResult, options);
  }

  /**
   * Persists the manifest via {@link ArtifactPromotionWriter} (R2 when PROMOTION_ARTIFACTS_BUCKET is bound, else noop).
   */
  async buildPromotionArtifact(
    manifest: PromotionArtifactManifest
  ): Promise<{ ok: true; ref: PromotionArtifactRef } | { ok: false; error: string }> {
    this.assertOrchestratorPromotionApis();
    try {
      const ref = await this.getArtifactPromotionWriter().writeManifest(manifest);
      console.info("[EdgeClaw][promotion] artifact manifest materialized", {
        bundleId: ref.bundleId,
        digest: ref.manifestDigest,
      });
      return { ok: true, ref };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  /**
   * Flagship / policy gate — call only after patches are approved and {@link buildPromotionArtifact} succeeded.
   * Verifies `bundleRef.bundleId` and, when set, `bundleRef.manifestDigest` against the manifest before delegating.
   * Optional `correlationId` is forwarded to the Flagship adapter (e.g. HTTP policy service).
   */
  async evaluateReleaseGate(params: {
    projectId: string;
    tier: ReleaseTier;
    bundleRef: PromotionArtifactRef;
    manifest: PromotionArtifactManifest;
    verificationRefs?: readonly string[];
    correlationId?: string;
  }): Promise<ReleaseGateDecision> {
    this.assertOrchestratorPromotionApis();
    return evaluatePromotionReleaseGate(this.getFlagshipEvaluationAdapter(), params);
  }

  /**
   * Preview-only deploy — runs after approved patches, manifest build, artifact write, and release gate allow.
   * Preconditions are enforced in {@link runPreviewDeployment}; does not touch coding loop or sub-agents.
   */
  async executePreviewDeployment(request: PreviewDeployRequest): Promise<PreviewDeployResult> {
    this.assertOrchestratorPromotionApis();
    return runPreviewDeployment(this.getPreviewDeployAdapter(), request);
  }

  /**
   * Production deploy — **separate adapter** from preview (`getProductionDeployAdapter` vs `getPreviewDeployAdapter`).
   * Stronger preconditions: production-tier release gate allow, `artifactWritten`, multi-party `productionApprovals`
   * (see `productionDeployPolicy.ts`). Prefer {@link launchProductionDeployWorkflow} for long-running execution.
   */
  async executeProductionDeployment(request: ProductionDeployRequest): Promise<ProductionDeployResult> {
    this.assertOrchestratorPromotionApis();
    return runProductionDeployment(this.getProductionDeployAdapter(), request);
  }

  /**
   * Orchestrator-only preview pipeline: {@link prepareApprovedPromotion} → {@link buildPromotionArtifact} →
   * {@link evaluateReleaseGate} (preview tier) → {@link executePreviewDeployment} when the gate allows.
   *
   * Same boundary as other orchestrator promotion APIs — not for CoderAgent/TesterAgent.
   * Interactive synchronous pipeline — same stages as the durable Workflow (`launchPreviewPromotionWorkflow`).
   */
  async runApprovedPatchesPreviewPipeline(
    input: PreviewPromotionPipelineInput
  ): Promise<PreviewPromotionPipelineResult> {
    this.assertOrchestratorPromotionApis();
    return runPreviewPromotionPipeline(
      {
        prepareApprovedPromotion: (projectId, patchIds, options) =>
          this.prepareApprovedPromotion(projectId, patchIds, options),
        buildPromotionArtifact: (manifest) => this.buildPromotionArtifact(manifest),
        evaluateReleaseGate: (params) => this.evaluateReleaseGate(params),
        executePreviewDeployment: (request) => this.executePreviewDeployment(request),
      },
      input
    );
  }

  /**
   * Starts the durable preview promotion pipeline (`EdgeclawPreviewPromotionWorkflow`) — retry-safe `step.do`
   * checkpoints for artifact write, release gate, and preview deploy. Requires `EDGECLAW_PREVIEW_PROMOTION_WORKFLOW`
   * in wrangler.jsonc.
   *
   * Coding collaboration stays interactive; call this only after approved patch ids exist.
   */
  async launchPreviewPromotionWorkflow(
    input: PreviewPromotionPipelineInput,
    options?: { workflowInstanceId?: string }
  ): Promise<{ workflowInstanceId: string }> {
    this.assertOrchestratorPromotionApis();
    const env = this.env as Env;
    if (!env.EDGECLAW_PREVIEW_PROMOTION_WORKFLOW) {
      throw new Error(
        "EDGECLAW_PREVIEW_PROMOTION_WORKFLOW is not bound — add edgeclaw-preview-promotion-workflow to wrangler.jsonc workflows."
      );
    }
    const workflowInstanceId = await this.runWorkflow(
      "EDGECLAW_PREVIEW_PROMOTION_WORKFLOW",
      input,
      options?.workflowInstanceId ? { id: options.workflowInstanceId } : undefined
    );
    return { workflowInstanceId };
  }

  /**
   * Durable **production** deploy — uses `EdgeclawProductionDeployWorkflow` (not the preview promotion workflow).
   * Requires `EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW` in wrangler.jsonc.
   */
  async launchProductionDeployWorkflow(
    input: ProductionDeployRequest,
    options?: { workflowInstanceId?: string }
  ): Promise<{ workflowInstanceId: string }> {
    this.assertOrchestratorPromotionApis();
    const env = this.env as Env;
    if (!env.EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW) {
      throw new Error(
        "EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW is not bound — add edgeclaw-production-deploy-workflow to wrangler.jsonc workflows."
      );
    }
    const workflowInstanceId = await this.runWorkflow(
      "EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW",
      input,
      options?.workflowInstanceId ? { id: options.workflowInstanceId } : undefined
    );
    return { workflowInstanceId };
  }

  /** Override for production backend — never returns a {@link PreviewDeployAdapter}. */
  protected getProductionDeployAdapter(): ProductionDeployAdapter {
    return resolveProductionDeployAdapter(this.env);
  }

  /** Override when injecting a custom preview backend in tests — default uses {@link resolvePreviewDeployAdapter}. */
  protected getPreviewDeployAdapter(): PreviewDeployAdapter {
    return resolvePreviewDeployAdapter(this.env);
  }

  /** Resolve via {@link resolveArtifactPromotionWriter} — override to inject a custom writer in tests. */
  protected getArtifactPromotionWriter(): ArtifactPromotionWriter {
    return resolveArtifactPromotionWriter(this.env);
  }

  /** Override when injecting a policy client in tests — default uses {@link resolveFlagshipEvaluationAdapter}. */
  protected getFlagshipEvaluationAdapter(): FlagshipEvaluationAdapter {
    return resolveFlagshipEvaluationAdapter(this.env);
  }

  private assertOrchestratorPromotionApis(): void {
    assertOrchestratorPromotionBoundary(this, MainAgent);
  }

  /**
   * Infer the most appropriate delegation target from a user message.
   *
   * Returns `"research"` for information-gathering intents,
   * `"execution"` for code/structured workflow intents, and
   * `"self"` when the orchestrator should handle the request locally.
   *
   * This heuristic is intentionally simple — override it in sub-agents
   * or replace with a model-routed intent-classification step.
   */
  inferDelegationTarget(
    message: string
  ): "research" | "execution" | "self" {
    const text = message.toLowerCase();

    if (
      /\b(search|browse|find|lookup|research|citation|source|summarize|synthesize|analyze|explain)\b/.test(
        text
      )
    ) {
      return "research";
    }

    if (
      /\b(execute|run|code|build|deploy|task|pipeline|workflow|generate|create|write|fix|install)\b/.test(
        text
      )
    ) {
      return "execution";
    }

    return "self";
  }

  /**
   * Convenience wrapper: route a message to the appropriate child agent
   * based on `inferDelegationTarget`, or handle it locally.
   *
   * Returns `null` when `target === "self"` (caller should process locally).
   *
   * @param message   User message to route.
   * @param options   Forwarded to the chosen delegate.
   */
  async routeToDelegate(
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult | null> {
    const target = this.inferDelegationTarget(message);

    if (target === "research") {
      return this.delegateToResearch(message, options);
    }
    if (target === "execution") {
      return this.delegateToExecution(message, options);
    }

    return null;
  }

  /**
   * Execute a lifecycle hook
   */
  async executeHook(hookType: HookType, context: HookContext): Promise<void> {
    await this.hookRegistry.execute(hookType, context);
  }

  /**
   * Initialize the agent
   * Called on first startup, before processing messages
   */
  async initialize(): Promise<void> {
    const context: HookContext = {
      agentName: this.constructor.name,
      timestamp: new Date(),
      requestId: this.requestId,
    };

    await this.executeHook(HookType.ON_INIT, context);
  }

  /**
   * Shutdown the agent
   * Called on cleanup or deactivation
   */
  async shutdown(): Promise<void> {
    const context: HookContext = {
      agentName: this.constructor.name,
      timestamp: new Date(),
      requestId: this.requestId,
    };

    await this.executeHook(HookType.ON_SHUTDOWN, context);
  }

  // ── Chat recovery ────────────────────────────────────────────────────────

  /**
   * Called by Think when an interrupted chat fiber is detected after a
   * Durable Object restart. Requires `chatRecovery = true` (already set).
   *
   * Policy: persist the partial text and continue inference if the interrupted
   * turn started within the last 5 minutes; otherwise persist only.
   */
  async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    const ageMs = Date.now() - ctx.createdAt;
    const withinWindow = ageMs < 5 * 60 * 1_000;

    console.log(
      `[EdgeClaw][recovery] streamId=${ctx.streamId} requestId=${ctx.requestId} ` +
        `ageMs=${ageMs} continue=${withinWindow} partialLength=${ctx.partialText.length}`
    );

    return {
      persist: true,
      continue: withinWindow,
    };
  }

  // ── Programmatic turn triggers ───────────────────────────────────────────

  /**
   * Inject a user message and trigger a model turn without an active
   * WebSocket connection. Safe to call from a Cloudflare `scheduled` handler
   * or from a webhook HTTP handler via the stub returned by `getAgentByName`.
   *
   * Think's `saveMessages()` persists the message and queues an agentic turn;
   * tools, approval, streaming, and all lifecycle hooks fire normally.
   *
   * @param text      The user message text.
   * @param metadata  Optional key-value context appended inline to the text.
   *
   * @example
   *   // From a cron-triggered Worker scheduled handler:
   *   const stub = await getAgentByName(env.MAIN_AGENT, "default");
   *   await stub.triggerTurn("Run the daily health check.");
   *
   *   // With metadata:
   *   await stub.triggerTurn("Process GitHub event.", {
   *     source: "webhook", event: "push", repo: "org/repo",
   *   });
   */
  async triggerTurn(
    text: string,
    metadata?: Record<string, string>,
    /** Optional human-readable label prepended to the injected message (e.g. "Scheduled: Daily standup reminder"). */
    label?: string
  ): Promise<{ requestId: string; status: "completed" | "skipped" }> {
    // Build the visible message text.
    // `label` produces a clean header; raw metadata is logged for diagnostics only.
    const header = label ? `[${label}]\n\n` : "";
    const body = `${header}${text}`;

    if (metadata) {
      console.info(
        "[triggerTurn] metadata:",
        Object.entries(metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      );
    }

    // `saveMessages` is inherited from Think at runtime; cast bridges the
    // abstract-class gap until the class formally extends Think<Env>.
    const self = this as unknown as {
      saveMessages(
        messages: Array<{
          id: string;
          role: string;
          parts: Array<{ type: string; text: string }>;
        }>
      ): Promise<{ requestId: string; status: "completed" | "skipped" }>;
    };

    return self.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: body }],
      },
    ]);
  }

  // ── Memory API bridge methods ─────────────────────────────────────────────
  //
  // `session` is typed as private in Think's .d.ts but is always present at
  // runtime. These thin wrappers keep type-safe call sites in the route
  // handler while hiding the cast in one place.

  private get _sess(): Session {
    return (this as unknown as { session: Session }).session;
  }

  /**
   * Ensure context blocks are loaded and all user-created blocks are re-registered.
   *
   * Two problems solved here:
   *
   * 1. Think's getContextBlocks() returns an empty Map until freezeSystemPrompt()
   *    triggers the async provider load(). Calling it here populates the Map
   *    before any read on a cold DO instance.
   *
   * 2. User-created blocks (added at runtime via addContext) are stored durably in
   *    SQLite but are NOT part of configureSession()'s startup config. After DO
   *    hibernation the in-memory session resets to only soul + memory, so user
   *    blocks disappear from getContextBlocks() even though their content is still
   *    in the cf_agents_context_blocks table. We scan that table and re-register
   *    any missing labels so they appear in the Memory page and in the agent's
   *    next system prompt.
   */
  async memoryEnsureReady(): Promise<void> {
    // Use refreshSystemPrompt() — NOT freezeSystemPrompt().
    // freezeSystemPrompt() returns the cached string early without ever calling
    // load(), leaving this.loaded=false and the blocks Map empty.
    // refreshSystemPrompt() always calls load() first, guaranteeing the Map is
    // populated before we read getContextBlocks() below.
    await this._sess.refreshSystemPrompt();

    // Re-register user-created blocks that survived DO hibernation in SQLite but
    // are not in the configureSession() startup config (soul + memory).
    // knownLabels is built AFTER refreshSystemPrompt so the Map is fully populated.
    const knownLabels = new Set(this._sess.getContextBlocks().map((b) => b.label));
    let addedAny = false;
    try {
      type Row = { label: string };
      const rows = (this as unknown as { sql(s: TemplateStringsArray): Row[] })
        .sql`SELECT label FROM cf_agents_context_blocks`;
      for (const { label } of rows) {
        // Skip internal keys (_system_prompt etc.) and already-registered blocks.
        if (label.startsWith("_") || knownLabels.has(label)) continue;
        try {
          await this._sess.addContext(label);
          addedAny = true;
        } catch {
          // Block already registered in a concurrent call — skip without
          // aborting the rest of the loop.
        }
      }
    } catch {
      // cf_agents_context_blocks table doesn't exist yet on first ever use.
    }

    // Rebuild the cached prompt so the agent sees re-registered blocks on its
    // next turn without needing a separate manual refresh.
    if (addedAny) {
      await this._sess.refreshSystemPrompt();
    }
  }

  /** List every registered context block. */
  memoryGetBlocks(): ContextBlock[] {
    return this._sess.getContextBlocks();
  }

  /** Get a single context block by label, or null if missing. */
  memoryGetBlock(label: string): ContextBlock | null {
    return this._sess.getContextBlock(label);
  }

  /** Overwrite a context block's content, creating it first if it doesn't exist. */
  async memoryReplaceBlock(label: string, content: string): Promise<ContextBlock> {
    // Think's setBlock() throws "is readonly" for any unregistered label because
    // a missing block has writable=undefined (falsy). Dynamically register new
    // labels with a durable AgentContextProvider before writing.
    if (!this._sess.getContextBlock(label)) {
      await this._sess.addContext(label);
    }
    return this._sess.replaceContextBlock(label, content);
  }

  /** Append text to a context block. Returns a clear error if the block doesn't exist. */
  async memoryAppendBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this._sess.getContextBlock(label)) {
      throw new Error(`Block "${label}" not found. Create it first before appending.`);
    }
    return this._sess.appendContextBlock(label, content);
  }

  /**
   * Remove a context block.
   * Returns true if the block existed, false otherwise.
   */
  memoryRemoveBlock(label: string): boolean {
    return this._sess.removeContext(label);
  }

  /** Full-text search over message history. */
  memorySearch(query: string, limit?: number): Array<{
    id: string;
    role: string;
    content: string;
    createdAt?: string;
  }> {
    return this._sess.search(query, { limit });
  }

  /** Permanently delete specific messages by ID. */
  memoryDeleteMessages(ids: string[]): void {
    this._sess.deleteMessages(ids);
  }

  /** Rebuild the frozen system prompt from current context blocks. */
  memoryRefreshPrompt(): Promise<string> {
    return this._sess.refreshSystemPrompt();
  }

  // ── Task management ───────────────────────────────────────────────────────
  //
  // Implements TaskRouteAdapter (src/api/tasksRoutes.ts).
  //
  // Storage: task definitions are persisted in the DO config blob under the
  // key "tasks" — the same mechanism used for MCP server config.  Each write
  // calls this.configure() which atomically replaces the entire config object.
  //
  // Scheduling: the CF Agents `this.schedule()` / `this.cancelSchedule()` /
  // `this.getSchedules()` API is inherited from the Agent base class via Think.
  //
  // ASSUMPTION: Think<Env> extends Agent<Env>, which exposes:
  //   this.schedule(when, callbackName, data?)  → Promise<{ id: string; ... }>
  //   this.getSchedules()                       → Promise<ScheduleHandle[]>
  //   this.cancelSchedule(id)                   → Promise<void>
  //
  // If @cloudflare/think does not re-export these methods, cast `this` to
  // `SchedulingAgent` (defined in taskScheduler.ts) at each call site below.
  // The three PLACEHOLDER comments below mark these cast sites.

  /** Read the persisted task list from DO config (synchronous). */
  tasksGetAll(): PersistedTask[] {
    return readTasksFromConfig(this.getConfig());
  }

  /** Write a new task list to DO config (overwrites the tasks key only). */
  private async tasksSave(tasks: PersistedTask[]): Promise<void> {
    const existing = (this.getConfig() ?? {}) as Record<string, unknown>;
    await this.configure({ ...existing, tasks });
  }

  /** Generate a URL-safe random task ID. */
  private tasksNewId(): string {
    return "task_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }

  async tasksCreate(input: CreateTaskInput): Promise<PersistedTask> {
    const now = new Date().toISOString();
    const id = this.tasksNewId();

    const task: PersistedTask = {
      id,
      title: input.title,
      description: input.description,
      taskType: input.taskType ?? "other",
      scheduleType: input.scheduleType,
      scheduleExpression: input.scheduleExpression,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      status: (input.enabled ?? true) ? "active" : "paused",
      instructions: input.instructions,
      payload: input.payload,
      scheduleId: null,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: (input.enabled ?? true)
        ? estimateNextRunAt(input.scheduleType, input.scheduleExpression)
        : null,
    };

    // Register the schedule with the CF Agents runtime if the task is enabled.
    if (task.enabled) {
      const instruction = buildScheduleInstruction(task.scheduleType, task.scheduleExpression);
      if (instruction) {
        const scheduler = this as unknown as SchedulingAgent;
        // Intervals use scheduleEvery(); once/cron use schedule().
        const handle =
          instruction.method === "scheduleEvery"
            ? await scheduler.scheduleEvery(instruction.intervalSeconds, "onTaskFired", { taskId: id })
            : await scheduler.schedule(instruction.when, "onTaskFired", { taskId: id });
        task.scheduleId = handle.id;
      } else {
        // Expression was invalid — downgrade to draft so the UI can surface an error.
        task.status = "draft";
        task.enabled = false;
        task.nextRunAt = null;
      }
    }

    const all = this.tasksGetAll();
    await this.tasksSave([...all, task]);
    return task;
  }

  async tasksUpdate(id: string, input: UpdateTaskInput): Promise<PersistedTask> {
    const all = this.tasksGetAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Task "${id}" not found.`);

    const existing = all[idx];
    const now = new Date().toISOString();

    const scheduleChanged =
      (input.scheduleType !== undefined && input.scheduleType !== existing.scheduleType) ||
      (input.scheduleExpression !== undefined && input.scheduleExpression !== existing.scheduleExpression);

    const enabledChanged =
      input.enabled !== undefined && input.enabled !== existing.enabled;

    const updated: PersistedTask = {
      ...existing,
      ...input,
      updatedAt: now,
    };

    // Recompute nextRunAt if schedule fields changed.
    if (scheduleChanged || enabledChanged) {
      updated.nextRunAt = updated.enabled
        ? estimateNextRunAt(updated.scheduleType, updated.scheduleExpression)
        : null;
    }

    // Re-schedule when schedule fields or enabled state changed.
    const scheduler = this as unknown as SchedulingAgent; // PLACEHOLDER: see note above

    if (scheduleChanged || enabledChanged) {
      // Cancel existing schedule if present.
      if (existing.scheduleId) {
        try {
          await scheduler.cancelSchedule(existing.scheduleId);
        } catch {
          // Schedule may have already fired/expired — ignore the error.
        }
        updated.scheduleId = null;
      }

      // Create a new schedule if the task is now enabled.
      if (updated.enabled) {
        const instruction = buildScheduleInstruction(updated.scheduleType, updated.scheduleExpression);
        if (instruction) {
          // Intervals use scheduleEvery(); once/cron use schedule().
          const handle =
            instruction.method === "scheduleEvery"
              ? await scheduler.scheduleEvery(instruction.intervalSeconds, "onTaskFired", { taskId: id })
              : await scheduler.schedule(instruction.when, "onTaskFired", { taskId: id });
          updated.scheduleId = handle.id;
          updated.status = "active";
        } else {
          updated.status = "draft";
          updated.enabled = false;
          updated.nextRunAt = null;
        }
      } else {
        updated.status = "paused";
      }
    }

    const newAll = all.map((t, i) => (i === idx ? updated : t));
    await this.tasksSave(newAll);
    return updated;
  }

  async tasksDelete(id: string): Promise<void> {
    const all = this.tasksGetAll();
    const task = all.find((t) => t.id === id);
    if (!task) throw new Error(`Task "${id}" not found.`);

    // Cancel the associated CF Agents schedule if one exists.
    if (task.scheduleId) {
      try {
        const scheduler = this as unknown as SchedulingAgent; // PLACEHOLDER
        await scheduler.cancelSchedule(task.scheduleId);
      } catch {
        // Already expired/cancelled — proceed with deletion.
      }
    }

    await this.tasksSave(all.filter((t) => t.id !== id));
  }

  async tasksToggle(id: string, enabled: boolean): Promise<PersistedTask> {
    return this.tasksUpdate(id, { enabled });
  }

  /**
   * Cloudflare Agents schedule callback — invoked by the runtime when a
   * scheduled task fires.
   *
   * The callback name "onTaskFired" must match the string passed to
   * `this.schedule(when, "onTaskFired", data)` in tasksCreate / tasksUpdate.
   *
   * ASSUMPTION: The CF Agents runtime calls this method directly on the DO
   * instance, passing the `data` object that was supplied to `this.schedule()`.
   * If the runtime uses a different dispatch mechanism, update the callback
   * name here AND in every `this.schedule()` call above.
   */
  async onTaskFired(data: { taskId: string }): Promise<void> {
    const all = this.tasksGetAll();
    const task = all.find((t) => t.id === data?.taskId);

    if (!task) {
      console.warn("[onTaskFired] Unknown taskId:", data?.taskId);
      return;
    }
    if (!task.enabled) {
      console.info("[onTaskFired] Skipping paused task:", task.id);
      return;
    }

    const firedAt = new Date().toISOString();

    // Build a metadata map for the agentic turn.  Record<string, string>
    // is required by triggerTurn — stringify any non-string values.
    const metadata: Record<string, string> = {
      source: "scheduled-task",
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.taskType,
      scheduleType: task.scheduleType,
    };
    if (task.payload) {
      metadata.payload = JSON.stringify(task.payload);
    }

    const label = `Scheduled task: ${task.title}`;

    try {
      await this.triggerTurn(task.instructions, metadata, label);
    } catch (err) {
      console.error("[onTaskFired] triggerTurn failed for task", task.id, err);

      const errMsg = err instanceof Error ? err.message : String(err);
      const raw = normalizeStoredTask({
        ...task,
        status: "error",
        lastRunAt: firedAt,
        lastRunStatus: "failed",
        lastRunError: errMsg,
        updatedAt: firedAt,
      });
      if (raw) {
        await this.tasksSave(all.map((t) => (t.id === task.id ? raw : t)));
      }
      return;
    }

    // Update lastRunAt and recompute nextRunAt after a successful run.
    const updatedTask: PersistedTask = {
      ...task,
      lastRunAt: firedAt,
      lastRunStatus: "success",
      lastRunError: null,
      updatedAt: firedAt,
      nextRunAt: nextRunAtAfterFire(task),
      // Downgrade "once" tasks to a completed-ish status after they fire.
      status: task.scheduleType === "once" ? "paused" : "active",
      enabled: task.scheduleType !== "once",
    };

    await this.tasksSave(all.map((t) => (t.id === task.id ? updatedTask : t)));
  }

  // ── Session skills ─────────────────────────────────────────────────────────
  //
  // These methods are exposed as typed RPC callable by the frontend via
  // useAgent().  They delegate to SkillStore which manages R2 reads/writes.
  //
  // The "skills" context block registered in configureSession() means skill
  // metadata (key + description) is always visible in the system prompt.
  // Full skill content is loaded on demand when the model calls load_context,
  // and freed via unload_context when the model is done with a skill.

  /**
   * Returns a SkillStore backed by SKILLS_BUCKET.
   * Throws a descriptive error when the binding is not present so callers
   * get a clear message rather than a null-pointer exception at runtime.
   */
  private getSkillStore(): SkillStore {
    if (!hasSkillsBucket(this.env)) {
      throw new Error(
        "Skills are not available: the SKILLS_BUCKET R2 binding is missing. " +
          "Add an r2_buckets entry in wrangler.jsonc and set ENABLE_SKILLS=true."
      );
    }
    return new SkillStore(this.env.SKILLS_BUCKET);
  }

  /** List all skills as summaries (no content), sorted newest-first. */
  @callable()
  async listSkills(): Promise<SkillSummary[]> {
    return this.getSkillStore().listSkills();
  }

  /**
   * Fetch a single skill including its full content.
   * Returns null when no skill exists with the given key.
   */
  @callable()
  async getSkill(key: string): Promise<SkillDocument | null> {
    if (!key?.trim()) throw new Error("Skill key must not be empty.");
    return this.getSkillStore().getSkill(key.trim());
  }

  /**
   * Create a new skill document.
   * Throws when the key already exists — use updateSkill to modify an existing skill.
   */
  @callable()
  async createSkill(input: CreateSkillInput): Promise<SkillDocument> {
    return this.getSkillStore().createSkill(input);
  }

  /**
   * Apply a partial update to an existing skill.
   * Bumps version and refreshes updatedAt.  Throws when the skill does not exist.
   */
  @callable()
  async updateSkill(key: string, patch: UpdateSkillInput): Promise<SkillDocument> {
    if (!key?.trim()) throw new Error("Skill key must not be empty.");
    return this.getSkillStore().updateSkill(key.trim(), patch);
  }

  /**
   * Permanently delete a skill by key.
   * Throws when the skill does not exist.
   */
  @callable()
  async deleteSkill(key: string): Promise<DeleteSkillResult> {
    if (!key?.trim()) throw new Error("Skill key must not be empty.");
    return this.getSkillStore().deleteSkill(key.trim());
  }

  // ── Session context load / unload (not yet implemented) ───────────────────
  //
  // TODO: Add manual load/unload controls once the @cloudflare/agents Session
  // type exposes a safe way to trigger context key operations from backend code.
  //
  // The model-driven path (agent calls load_context / unload_context as tools
  // during generation) is the default and remains the primary mechanism.
  // The methods below would enable the frontend SkillDrawer "Load into chat" /
  // "Unload from chat" buttons as a supplemental manual control.
  //
  // Before implementing, verify that the installed version of @cloudflare/agents
  // (or @cloudflare/think) exposes the required Session primitives.  Two APIs
  // to check:
  //
  //   Option A — dedicated context-key methods (preferred, if available):
  //     this._sess.loadContextKey("skills", key)   // mirrors load_context tool
  //     this._sess.unloadContextKey("skills", key) // mirrors unload_context tool
  //
  //   Option B — replaceContextBlock / removeContext (available today, but coarse):
  //     This replaces or removes the *entire* "skills" block, which would
  //     clobber the R2SkillProvider's per-key tracking.  Do NOT use without
  //     first confirming that R2SkillProvider's internal state won't diverge.
  //
  // Once the right API is confirmed, implement:
  //
  //   @callable()
  //   async loadSkillIntoSession(key: string): Promise<void> {
  //     if (!key?.trim()) throw new Error("Skill key must not be empty.");
  //     await this._sess.loadContextKey("skills", key.trim()); // verify API name
  //   }
  //
  //   @callable()
  //   async unloadSkillFromSession(key: string): Promise<void> {
  //     if (!key?.trim()) throw new Error("Skill key must not be empty.");
  //     await this._sess.unloadContextKey("skills", key.trim()); // verify API name
  //   }
  //
  // Then:
  //   • Add loadSkillIntoSession / unloadSkillFromSession to frontend/src/lib/skillsApi.ts
  //   • Wire onLoadIntoSession / onUnloadFromSession props in frontend/src/App.tsx
  //   • Skill routes may also need HTTP endpoints in src/api/skillsRoutes.ts if
  //     the frontend calls REST instead of the @callable() RPC path.

  // ── Workflow definitions & runs ───────────────────────────────────────────
  //
  // Implements WorkflowRouteAdapter from src/api/workflowsRoutes.ts.
  //
  // Storage:  SQLite tables wf_definitions and wf_runs, created lazily on
  //           first use via wfEnsureTables().  this.sql uses the tagged-template
  //           literal API: this.sql<RowType>`SELECT ...` returns RowType[].
  //
  // Runtime:  Cloudflare Workflows bindings accessed via this.env[entrypoint].
  //           Add bindings in wrangler.jsonc under the "workflows" key:
  //
  //   "workflows": [
  //     {
  //       "name":        "MY_WORKFLOW",
  //       "binding":     "MY_WORKFLOW",
  //       "class_name":  "MyWorkflowClass",
  //       "script_name": "edgeclaw-truth-agent"
  //     }
  //   ]
  //
  // See: https://developers.cloudflare.com/workflows/
  //      https://developers.cloudflare.com/agents/api-reference/run-workflows/

  private wfTablesReady = false;

  private wfEnsureTables(): void {
    if (this.wfTablesReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS wf_definitions (
        id               TEXT    PRIMARY KEY,
        name             TEXT    NOT NULL,
        description      TEXT,
        workflow_type    TEXT,
        trigger_mode     TEXT    NOT NULL DEFAULT 'manual',
        approval_mode    TEXT    NOT NULL DEFAULT 'none',
        status           TEXT    NOT NULL DEFAULT 'active',
        entrypoint       TEXT    NOT NULL,
        instructions     TEXT,
        input_schema     TEXT,
        example_payload  TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        tags             TEXT    NOT NULL DEFAULT '[]',
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL,
        last_run_at      TEXT,
        run_count        INTEGER NOT NULL DEFAULT 0
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS wf_runs (
        id                     TEXT    PRIMARY KEY,
        workflow_definition_id TEXT    NOT NULL,
        workflow_name          TEXT    NOT NULL,
        status                 TEXT    NOT NULL DEFAULT 'running',
        progress_percent       REAL,
        current_step           TEXT,
        started_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL,
        completed_at           TEXT,
        waiting_for_approval   INTEGER NOT NULL DEFAULT 0,
        result_summary         TEXT,
        error_message          TEXT,
        input                  TEXT,
        output                 TEXT,
        approval_action        TEXT,
        approval_comment       TEXT,
        approved_by            TEXT,
        approval_action_at     TEXT,
        error_code             TEXT,
        error_details          TEXT
      )
    `;

    // Additive migrations for tables created before Phase 2 columns existed.
    // try/catch is intentional: ALTER TABLE ADD COLUMN fails if the column
    // already exists (SQLite does not support ADD COLUMN IF NOT EXISTS pre-3.37).
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN approval_action    TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN approval_comment   TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN approved_by        TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN approval_action_at TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN error_code             TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN error_details          TEXT`; } catch { /* exists */ }
    // Pending chat notification: set by onWorkflowComplete/onWorkflowError,
    // cleared by beforeTurn once delivered to the model turn.
    try { this.sql`ALTER TABLE wf_runs ADD COLUMN pending_notification   TEXT`; } catch { /* exists */ }

    this.wfTablesReady = true;
  }

  // ── Definition CRUD ───────────────────────────────────────────────────────

  async listWorkflowDefinitions(): Promise<PersistedWorkflowDefinition[]> {
    this.wfEnsureTables();
    const rows = this.sql<WfDefRow>`SELECT * FROM wf_definitions ORDER BY created_at DESC`;
    return rows.map(rowToDefinition);
  }

  async getWorkflowDefinition(id: string): Promise<PersistedWorkflowDefinition | null> {
    this.wfEnsureTables();
    const rows = this.sql<WfDefRow>`SELECT * FROM wf_definitions WHERE id = ${id}`;
    return rows.length ? rowToDefinition(rows[0]) : null;
  }

  /**
   * Return the binding names of every CF Workflow registered in this worker's
   * environment.  A Workflow binding is any env key whose value exposes a
   * `create()` method (the CF Workflows binding API surface).
   *
   * This is intentionally runtime-introspective so that adding a new workflow
   * class to wrangler.jsonc and redeploying automatically surfaces it in the
   * frontend entrypoint dropdown — no hardcoded list to maintain.
   */
  listWorkflowBindings(): string[] {
    const env = this.env as unknown as Record<string, unknown>;
    return Object.keys(env).filter(key => {
      const val = env[key] as Record<string, unknown>;
      if (!val || typeof val !== "object") return false;

      // A CF Workflow binding has both .create() and .get() methods.
      // Fetcher bindings (BROWSER, ASSETS) also have .create() in the runtime
      // proxy but they expose .fetch() — use that as the exclusion signal.
      const hasCreate = typeof val.create === "function";
      const hasGet    = typeof val.get    === "function";
      const hasFetch  = typeof val.fetch  === "function";

      return hasCreate && hasGet && !hasFetch;
    }).sort();
  }

  async createWorkflowDefinition(
    input: CreateWorkflowDefinitionInput,
  ): Promise<PersistedWorkflowDefinition> {
    this.wfEnsureTables();
    const now         = new Date().toISOString();
    const id          = crypto.randomUUID();
    const triggerMode = input.triggerMode  ?? "manual";
    const approvalMode= input.approvalMode ?? "none";
    const defStatus   = input.status       ?? "active";
    const enabled     = input.enabled !== false ? 1 : 0;
    const tags        = JSON.stringify(input.tags ?? []);
    const desc        = input.description        ?? null;
    const wfType      = input.workflowType       ?? null;
    const instr       = input.instructions       ?? null;
    const schema      = input.inputSchemaText    ?? null;
    const example     = input.examplePayloadText ?? null;

    this.sql`
      INSERT INTO wf_definitions (
        id, name, description, workflow_type, trigger_mode, approval_mode, status,
        entrypoint, instructions, input_schema, example_payload, enabled,
        tags, created_at, updated_at, last_run_at, run_count
      ) VALUES (
        ${id}, ${input.name}, ${desc}, ${wfType}, ${triggerMode}, ${approvalMode}, ${defStatus},
        ${input.entrypoint}, ${instr}, ${schema}, ${example}, ${enabled},
        ${tags}, ${now}, ${now}, ${null}, ${0}
      )
    `;

    return (await this.getWorkflowDefinition(id))!;
  }

  async updateWorkflowDefinition(
    id:    string,
    patch: UpdateWorkflowDefinitionInput,
  ): Promise<PersistedWorkflowDefinition> {
    this.wfEnsureTables();

    const existing = await this.getWorkflowDefinition(id);
    if (!existing) throw new Error(`Workflow definition "${id}" not found.`);

    const now          = new Date().toISOString();
    const name         = patch.name               ?? existing.name;
    const desc         = patch.description        !== undefined ? (patch.description        ?? null) : (existing.description        ?? null);
    const wfType       = patch.workflowType       !== undefined ? (patch.workflowType       ?? null) : (existing.workflowType       ?? null);
    const triggerMode  = patch.triggerMode        ?? existing.triggerMode;
    const approvalMode = patch.approvalMode       ?? existing.approvalMode;
    const defStatus    = patch.status             ?? existing.status;
    const entrypoint   = patch.entrypoint         ?? existing.entrypoint;
    const instr        = patch.instructions       !== undefined ? (patch.instructions       ?? null) : (existing.instructions       ?? null);
    const schema       = patch.inputSchemaText    !== undefined ? (patch.inputSchemaText    ?? null) : (existing.inputSchemaText    ?? null);
    const example      = patch.examplePayloadText !== undefined ? (patch.examplePayloadText ?? null) : (existing.examplePayloadText ?? null);
    const enabled      = (patch.enabled           !== undefined ? patch.enabled : existing.enabled) ? 1 : 0;
    const tags         = JSON.stringify(patch.tags ?? existing.tags);

    this.sql`
      UPDATE wf_definitions SET
        name = ${name}, description = ${desc}, workflow_type = ${wfType},
        trigger_mode = ${triggerMode}, approval_mode = ${approvalMode}, status = ${defStatus},
        entrypoint = ${entrypoint}, instructions = ${instr}, input_schema = ${schema},
        example_payload = ${example}, enabled = ${enabled}, tags = ${tags},
        updated_at = ${now}
      WHERE id = ${id}
    `;

    return (await this.getWorkflowDefinition(id))!;
  }

  async deleteWorkflowDefinition(id: string): Promise<void> {
    this.wfEnsureTables();

    const existing = await this.getWorkflowDefinition(id);
    if (!existing) throw new Error(`Workflow definition "${id}" not found.`);

    this.sql`DELETE FROM wf_runs WHERE workflow_definition_id = ${id}`;
    this.sql`DELETE FROM wf_definitions WHERE id = ${id}`;
  }

  async toggleWorkflowDefinition(
    id:      string,
    enabled: boolean,
  ): Promise<PersistedWorkflowDefinition> {
    this.wfEnsureTables();

    const existing = await this.getWorkflowDefinition(id);
    if (!existing) throw new Error(`Workflow definition "${id}" not found.`);

    const now        = new Date().toISOString();
    const enabledInt = enabled ? 1 : 0;
    this.sql`UPDATE wf_definitions SET enabled = ${enabledInt}, updated_at = ${now} WHERE id = ${id}`;

    return (await this.getWorkflowDefinition(id))!;
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async launchWorkflow(
    id:     string,
    input?: Record<string, unknown>,
  ): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const def = await this.getWorkflowDefinition(id);
    if (!def) throw new Error(`Workflow definition "${id}" not found.`);
    if (!def.enabled) throw new Error(`Workflow "${def.name}" is disabled.`);

    const runId     = crypto.randomUUID();
    const now       = new Date().toISOString();
    const inputJson = input ? JSON.stringify(input) : null;
    const runStatus = "running";

    // this.runWorkflow() resolves the binding from env, creates the CF Workflow
    // instance with our chosen ID, and stores SDK-level tracking internally.
    // The wf_runs INSERT below maintains our richer UI tracking layer.
    await this.runWorkflow(def.entrypoint, input ?? {}, { id: runId });

    this.sql`
      INSERT INTO wf_runs (
        id, workflow_definition_id, workflow_name, status,
        progress_percent, current_step, started_at, updated_at, completed_at,
        waiting_for_approval, result_summary, error_message, input, output
      ) VALUES (
        ${runId}, ${def.id}, ${def.name}, ${runStatus},
        ${null}, ${null}, ${now}, ${now}, ${null},
        ${0}, ${null}, ${null}, ${inputJson}, ${null}
      )
    `;

    this.sql`
      UPDATE wf_definitions
      SET run_count = run_count + 1, last_run_at = ${now}, updated_at = ${now}
      WHERE id = ${id}
    `;

    return (await this.getWorkflowRun(runId))!;
  }

  // ── Run queries ───────────────────────────────────────────────────────────

  async listWorkflowRuns(
    workflowDefinitionId?: string,
  ): Promise<PersistedWorkflowRun[]> {
    this.wfEnsureTables();

    const rows: WfRunRow[] = workflowDefinitionId
      ? this.sql<WfRunRow>`
          SELECT * FROM wf_runs
          WHERE workflow_definition_id = ${workflowDefinitionId}
          ORDER BY started_at DESC
        `
      : this.sql<WfRunRow>`SELECT * FROM wf_runs ORDER BY started_at DESC`;

    const runs = rows.map(rowToRun);
    return Promise.all(runs.map((r: PersistedWorkflowRun) => this.wfRefreshRunStatus(r)));
  }

  async getWorkflowRun(runId: string): Promise<PersistedWorkflowRun | null> {
    this.wfEnsureTables();
    const rows = this.sql<WfRunRow>`SELECT * FROM wf_runs WHERE id = ${runId}`;
    if (!rows.length) return null;
    return this.wfRefreshRunStatus(rowToRun(rows[0]));
  }

  /**
   * Returns all runs that are currently active (running / waiting / paused).
   * Used by the SSE stream endpoint to send an initial snapshot to the client.
   * We intentionally skip `wfRefreshRunStatus` here to keep the response fast —
   * the SSE channel will emit individual updates as runs change.
   */
  async getActiveRunsForStream(): Promise<PersistedWorkflowRun[]> {
    this.wfEnsureTables();
    const rows = this.sql<WfRunRow>`
      SELECT * FROM wf_runs
      WHERE status IN ('running', 'waiting', 'paused')
      ORDER BY started_at DESC
    `;
    return rows.map(rowToRun);
  }

  // ── Run control ───────────────────────────────────────────────────────────

  async terminateWorkflowRun(runId: string): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (isTerminalRunStatus(run.status)) {
      throw new Error(`Run "${runId}" is already in terminal state "${run.status}".`);
    }

    try { await this.terminateWorkflow(runId); } catch { /* already gone or not tracked by SDK */ }

    const completedAt = new Date().toISOString();
    return this.wfPatchRun(runId, { status: "terminated", completedAt });
  }

  async resumeWorkflowRun(runId: string): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (run.status !== "paused" && run.status !== "waiting") {
      throw new Error(`Run "${runId}" is not in a resumable state (current: ${run.status}).`);
    }

    try { await this.resumeWorkflow(runId); } catch { /* best-effort; binding may not support pause/resume */ }

    return this.wfPatchRun(runId, { status: "running", waitingForApproval: false });
  }

  async restartWorkflowRun(runId: string): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (isActiveRunStatus(run.status)) {
      throw new Error(
        `Run "${runId}" is still active (status: ${run.status}). Terminate it first.`,
      );
    }

    return this.launchWorkflow(run.workflowDefinitionId, run.input);
  }

  async approveWorkflowRun(
    runId:    string,
    comment?: string,
  ): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (!run.waitingForApproval) {
      throw new Error(`Run "${runId}" is not waiting for approval.`);
    }

    // SDK sends the approval event to the waiting workflow instance.
    await this.approveWorkflow(runId, {
      reason:   comment,
      metadata: { approvedBy: "user", comment: comment ?? null },
    });

    const approvalActionAt = new Date().toISOString();
    return this.wfPatchRun(runId, {
      status:             "running",
      waitingForApproval: false,
      approvalAction:     "approved",
      approvalComment:    comment ?? null,
      approvalActionAt,
    });
  }

  async rejectWorkflowRun(
    runId:    string,
    comment?: string,
  ): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (!run.waitingForApproval) {
      throw new Error(`Run "${runId}" is not waiting for approval.`);
    }

    // SDK sends the rejection event — causes waitForApproval() to throw WorkflowRejectedError.
    await this.rejectWorkflow(runId, { reason: comment });

    const completedAt      = new Date().toISOString();
    const approvalActionAt = completedAt;
    const errorMessage     = `Rejected${comment ? `: ${comment}` : "."}`;
    return this.wfPatchRun(runId, {
      status:             "errored",
      waitingForApproval: false,
      completedAt,
      errorMessage,
      approvalAction:     "rejected",
      approvalComment:    comment ?? null,
      approvalActionAt,
    });
  }

  // Renamed from sendWorkflowEvent to avoid collision with Think base-class method.
  async sendWorkflowRunEvent(
    runId:     string,
    eventType: string,
    payload?:  Record<string, unknown>,
  ): Promise<PersistedWorkflowRun> {
    this.wfEnsureTables();

    const run = await this.getWorkflowRun(runId);
    if (!run) throw new Error(`Run "${runId}" not found.`);
    if (!isActiveRunStatus(run.status)) {
      throw new Error(
        `Run "${runId}" is not active (status: ${run.status}). Cannot send event.`,
      );
    }

    const def = await this.getWorkflowDefinition(run.workflowDefinitionId);
    if (def) {
      await this.sendWorkflowEvent(def.entrypoint, runId, { type: eventType, payload });
    }

    return this.wfPatchRun(runId, {});
  }

  // ── Workflow SDK callbacks → chat notifications ───────────────────────────
  //
  // The AgentWorkflow base class calls these three hooks via RPC whenever the
  // running workflow emits a progress report, finishes, or errors out.
  // We use Think's saveMessages() to inject a user-role prompt so the model
  // produces a natural assistant reply in the chat — giving the user real-time
  // visibility without needing to watch the Runs tab.

  override async onWorkflowProgress(
    _workflowName: string,
    workflowId:    string,
    progress:      Record<string, unknown>,
  ): Promise<void> {
    // Only surface the approval checkpoint — step-level progress would be too noisy.
    if (progress.step !== "awaiting-approval" || progress.status !== "running") return;

    try {
      const run = this.getWorkflowRunByInstanceId(workflowId);

      // ── DB update: show Approve/Reject buttons in the UI immediately ────────
      // The CF Workflows status API lags behind the progress callback, so we
      // set waitingForApproval locally to avoid a race where polling would
      // overwrite the flag before the CF API catches up.
      if (run && !run.waitingForApproval) {
        try { this.wfPatchRun(run.id, { waitingForApproval: true, status: "waiting" }); } catch { /* best-effort */ }
      }

      // ── No saveMessages call here ────────────────────────────────────────────
      // Calling saveMessages() inside onWorkflowProgress triggers a new model
      // turn that fires concurrently with the still-in-progress turn that
      // launched the workflow.  That second turn sees the same original user
      // message and calls run_workflow again — creating a duplicate run.
      //
      // The approval status is already visible in Workflows → Runs.  The model's
      // response to the workflow launch ("I'll pause at the checkpoint…") also
      // communicates this.  No separate chat notification is needed.
    } catch (err) {
      console.error(`[onWorkflowProgress] failed to update approval state: ${err}`);
    }
  }

  override async onWorkflowComplete(
    workflowName: string,
    workflowId:   string,
    result:       unknown,
  ): Promise<void> {
    console.log(`[onWorkflowComplete] called: workflowName=${workflowName} workflowId=${workflowId}`);
    try {
      const run     = this.getWorkflowRunByInstanceId(workflowId);
      const label   = run?.workflowName ?? workflowName;
      const shortId = workflowId.slice(0, 8);
      const prompt  = buildWorkflowCompletePrompt(label, shortId, result);

      // ── Durable fallback: write to DB first ───────────────────────────────
      // If the DO is evicted before the saveMessages model turn completes,
      // pending_notification stays in the DB and beforeTurn delivers it on the
      // next user interaction instead.  beforeTurn clears it once consumed.
      if (run) {
        try {
          this.wfEnsureTables();
          this.sql`UPDATE wf_runs SET pending_notification = ${prompt} WHERE id = ${run.id}`;
          console.log(`[onWorkflowComplete] Stored pending_notification for run ${shortId}`);
        } catch (dbErr) {
          console.error(`[onWorkflowComplete] Failed to store pending_notification: ${dbErr}`);
        }
      }

      // ── Best-effort immediate delivery via saveMessages ───────────────────
      // Works reliably when a WebSocket client is connected; the model turn
      // triggered here will call beforeTurn which clears pending_notification.
      console.log(`[onWorkflowComplete] Attempting saveMessages for immediate delivery`);
      await this.saveMessages((current) => [
        ...current,
        {
          id:    crypto.randomUUID(),
          role:  "user" as const,
          parts: [{ type: "text" as const, text: prompt }],
        },
      ]);
      console.log(`[onWorkflowComplete] saveMessages returned successfully`);
    } catch (err) {
      console.error(`[onWorkflowComplete] failed to send chat notification: ${err}`);
    }
  }

  override async onWorkflowError(
    workflowName: string,
    workflowId:   string,
    error:        string,
  ): Promise<void> {
    // Log first so the error is always recorded even if saveMessages throws.
    console.error(`Workflow error [${workflowName}/${workflowId}]: ${error}`);

    try {
      const run   = this.getWorkflowRunByInstanceId(workflowId);
      const label = run?.workflowName ?? workflowName;

      await this.saveMessages((current) => [
        ...current,
        {
          id:    crypto.randomUUID(),
          role:  "user" as const,
          parts: [{
            type: "text" as const,
            text: [
              `[Workflow notification] The workflow "${label}" (run ID: ${workflowId.slice(0, 8)}…)`,
              `encountered an error and stopped: ${error}`,
              `Please let the user know, note whether it looks transient (e.g. a reset after deploy),`,
              `and suggest they check Workflows → Runs to restart if needed.`,
            ].join(" "),
          }],
        },
      ]);
    } catch (err) {
      console.error(`[onWorkflowError] failed to send chat notification: ${err}`);
    }
  }

  /**
   * Look up a wf_runs row by the CF Workflow instance ID.
   * Synchronous — uses the tagged-template SQL API which is always sync.
   */
  private getWorkflowRunByInstanceId(instanceId: string): PersistedWorkflowRun | null {
    try {
      this.wfEnsureTables();
      const rows = this.sql<WfRunRow>`SELECT * FROM wf_runs WHERE id = ${instanceId}`;
      return rows[0] ? rowToRun(rows[0]) : null;
    } catch {
      return null;
    }
  }

  // ── Workflow private helpers ───────────────────────────────────────────────

  /**
   * Merge delta fields onto the existing wf_runs row and write all mutable
   * columns back in a single fixed UPDATE statement (avoids dynamic SQL).
   */
  private wfPatchRun(
    runId: string,
    delta: Partial<PersistedWorkflowRun>,
  ): PersistedWorkflowRun {
    const rows = this.sql<WfRunRow>`SELECT * FROM wf_runs WHERE id = ${runId}`;
    const existing = rowToRun(rows[0]);

    const now               = new Date().toISOString();
    const status            = delta.status             ?? existing.status;
    const progressPercent   = delta.progressPercent    !== undefined ? (delta.progressPercent ?? null)  : (existing.progressPercent   ?? null);
    const currentStep       = delta.currentStep        !== undefined ? (delta.currentStep     ?? null)  : (existing.currentStep       ?? null);
    const completedAt       = delta.completedAt        !== undefined ? (delta.completedAt     ?? null)  : (existing.completedAt       ?? null);
    const wfApproval        = delta.waitingForApproval !== undefined ? delta.waitingForApproval         : existing.waitingForApproval;
    const waitingInt        = wfApproval ? 1 : 0;
    const resultSummary     = delta.resultSummary      !== undefined ? (delta.resultSummary   ?? null)  : (existing.resultSummary     ?? null);
    const errorMessage      = delta.errorMessage       !== undefined ? (delta.errorMessage    ?? null)  : (existing.errorMessage      ?? null);
    const errorCode         = delta.errorCode          !== undefined ? (delta.errorCode       ?? null)  : (existing.errorCode         ?? null);
    const errorDetailsJson  = delta.errorDetails       !== undefined
      ? (delta.errorDetails ? JSON.stringify(delta.errorDetails) : null)
      : (existing.errorDetails ? JSON.stringify(existing.errorDetails) : null);
    const outputJson        = delta.output             !== undefined
      ? (delta.output ? JSON.stringify(delta.output) : null)
      : (existing.output ? JSON.stringify(existing.output) : null);

    // Approval audit fields — only written if the delta explicitly supplies them.
    const approvalAction   = delta.approvalAction   !== undefined ? (delta.approvalAction   ?? null) : (existing.approvalAction   ?? null);
    const approvalComment  = delta.approvalComment  !== undefined ? (delta.approvalComment  ?? null) : (existing.approvalComment  ?? null);
    const approvedBy       = delta.approvedBy       !== undefined ? (delta.approvedBy       ?? null) : (existing.approvedBy       ?? null);
    const approvalActionAt = delta.approvalActionAt !== undefined ? (delta.approvalActionAt ?? null) : (existing.approvalActionAt ?? null);

    this.sql`
      UPDATE wf_runs SET
        status               = ${status},
        progress_percent     = ${progressPercent},
        current_step         = ${currentStep},
        completed_at         = ${completedAt},
        waiting_for_approval = ${waitingInt},
        result_summary       = ${resultSummary},
        error_message        = ${errorMessage},
        error_code           = ${errorCode},
        error_details        = ${errorDetailsJson},
        output               = ${outputJson},
        approval_action      = ${approvalAction},
        approval_comment     = ${approvalComment},
        approved_by          = ${approvedBy},
        approval_action_at   = ${approvalActionAt},
        updated_at           = ${now}
      WHERE id = ${runId}
    `;

    return rowToRun(
      this.sql<WfRunRow>`SELECT * FROM wf_runs WHERE id = ${runId}`[0],
    );
  }

  /**
   * For active runs, pull a live status update from the CF Workflows API and
   * persist any changes.  Falls back silently to the stored record on any error
   * or when the binding is not configured.
   */
  private async wfRefreshRunStatus(
    run: PersistedWorkflowRun,
  ): Promise<PersistedWorkflowRun> {
    if (!isActiveRunStatus(run.status)) return run;

    try {
      const def = await this.getWorkflowDefinition(run.workflowDefinitionId);
      if (!def) return run;

      // SDK resolves the binding internally and returns the live CF Workflow status.
      const cfStatus = await this.getWorkflowStatus(def.entrypoint, run.id);

      // Map CF status strings to our WorkflowRunStatus union.
      // "queued" and "waitingForPause" have no direct equivalent — treat as "running".
      const cfToOur: Record<string, WorkflowRunStatus> = {
        queued:          "running",
        running:         "running",
        waitingForPause: "running",
        paused:          "paused",
        complete:        "complete",
        errored:         "errored",
        terminated:      "terminated",
        waiting:         "waiting",
        unknown:         "unknown",
      };
      const newStatus: WorkflowRunStatus = cfToOur[cfStatus.status] ?? "unknown";
      const isTerminal = isTerminalRunStatus(newStatus);

      // If the progress callback already set waitingForApproval=true but CF
      // is still reporting "running" (it lags the progress event by a few
      // seconds), don't override our locally-set waiting state.  The CF API
      // will catch up on the next poll and report "waiting" at that point.
      if (run.waitingForApproval && newStatus === "running") return run;

      // Also re-patch if CF says "waiting" but our flag isn't set yet.
      const approvalFlagMismatch = newStatus === "waiting" && !run.waitingForApproval;
      if (newStatus === run.status && !isTerminal && !approvalFlagMismatch) return run;

      // cfStatus.error is { name: string; message: string } when present.
      const errorMsg = cfStatus.error
        ? `${cfStatus.error.name}: ${cfStatus.error.message}`
        : undefined;

      return this.wfPatchRun(run.id, {
        status:             newStatus,
        // Set the flag when CF (or the progress callback) indicates a
        // waitForApproval() checkpoint.  Only clear it on terminal states —
        // approveWorkflowRun / rejectWorkflowRun handle the non-terminal clear.
        waitingForApproval: newStatus === "waiting"
                              ? true
                              : (isTerminal ? false : undefined),
        completedAt:        isTerminal ? new Date().toISOString() : undefined,
        errorMessage:       errorMsg,
        output:             (cfStatus.output && typeof cfStatus.output === "object" && !Array.isArray(cfStatus.output))
                              ? (cfStatus.output as Record<string, unknown>)
                              : undefined,
      });
    } catch {
      return run;
    }
  }

  /**
   * Rebuild `WorkersAITTS` when the client picks a different @cf/deepgram/aura-1
   * speaker.  @see https://developers.cloudflare.com/workers-ai/models/aura-1/
   */
  private reconfigureAuraTtsIfNeeded(speaker: AuraTtsSpeaker): void {
    if (!this.env.AI) {
      console.info("[EdgeClaw][tts-debug] TTS reconfigure skipped: env.AI is missing (Workers AI TTS unavailable)");
      return;
    }
    if (speaker === this._auraTtsSpeaker) {
      return;
    }
    const prev = this._auraTtsSpeaker;
    this._auraTtsSpeaker = speaker;
    this.tts = new WorkersAITTS(this.env.AI, {
      model: "@cf/deepgram/aura-1",
      speaker,
    });
    console.info(
      `[EdgeClaw][tts-debug] TTS: WorkersAITTS rebuilt @cf/deepgram/aura-1 — speaker ${prev} → ${speaker} ` +
        "(wrangler tail / worker logs; browser DevTools for client)"
    );
    this._persistAuraTtsSpeakerToStorage(speaker);
  }

  private getFluxSttOptions(): WorkersAIFluxSTTOptions {
    const o: WorkersAIFluxSTTOptions = {
      eotThreshold: this._voiceFluxEotThreshold,
      eotTimeoutMs: this._voiceFluxEotTimeoutMs,
    };
    const e = this._voiceFluxEagerEotThreshold;
    if (e !== undefined) {
      o.eagerEotThreshold = Math.min(e, this._voiceFluxEotThreshold);
    }
    return o;
  }

  /**
   * Pass @cf/deepgram/flux `eot_*` options into each new transcriber session so
   * voice calls pick up the latest values from settings / HTTP.
   */
  override createTranscriber(_connection: Connection): Transcriber | null {
    void _connection;
    if (!this.env.AI) return null;
    return new WorkersAIFluxSTT(this.env.AI, this.getFluxSttOptions());
  }

  /**
   * @param eagerEot - `null` clears eager; `undefined` leaves the current eager value unchanged.
   */
  private applyVoiceFluxSttState(
    eotIn: number,
    timeoutIn: number,
    eagerEot: number | null | undefined
  ): void {
    if (!this.env.AI) {
      return;
    }
    this._voiceFluxEotThreshold = clampVoiceFluxEot(eotIn);
    this._voiceFluxEotTimeoutMs = clampVoiceFluxEotTimeoutMs(timeoutIn);
    if (eagerEot === undefined) {
      /* keep */
    } else if (eagerEot == null) {
      this._voiceFluxEagerEotThreshold = undefined;
    } else {
      this._voiceFluxEagerEotThreshold = Math.min(
        clampVoiceFluxEager(eagerEot),
        this._voiceFluxEotThreshold
      );
    }
    this.transcriber = new WorkersAIFluxSTT(this.env.AI, this.getFluxSttOptions());
  }

  /**
   * `POST /voice/flux-stt` and `beforeTurn` (chat `settings`) update Flux
   * end-of-turn behavior for the next voice `start_call` / transcriber session.
   */
  applyVoiceFluxStt(input: VoiceFluxSttRequestBody): { ok: boolean; error?: string } {
    if (!this.env.AI) {
      return { ok: false, error: "AI binding or STT unavailable" };
    }
    try {
      this.applyVoiceFluxSttState(
        input.eotThreshold,
        input.eotTimeoutMs,
        input.eagerEotThreshold
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Invoked from `POST /api/voice/tts-speaker` and for tests; also driven by
   * `settings.ttsSpeaker` in `beforeTurn` on each chat request.
   */
  applyAuraTtsSpeaker(speaker: string): { ok: boolean; error?: string } {
    const p = parseAuraTtsSpeaker(speaker);
    if (!p) {
      console.info(
        `[EdgeClaw][tts-debug] applyAuraTtsSpeaker: invalid id ${JSON.stringify(speaker)} (not in aura-1 list)`
      );
      return { ok: false, error: "Invalid speaker id" };
    }
    if (!this.env.AI) {
      console.info("[EdgeClaw][tts-debug] applyAuraTtsSpeaker: env.AI missing");
      return { ok: false, error: "AI binding or TTS unavailable" };
    }
    console.info(
      `[EdgeClaw][tts-debug] applyAuraTtsSpeaker: got POST /api/voice/tts-speaker → ${p} (reconfigure may no-op if unchanged)`
    );
    this.reconfigureAuraTtsIfNeeded(p);
    this._persistAuraTtsSpeakerToStorage(p);
    return { ok: true };
  }

  private static readonly TTS_PREVIEW_MAX_CHARS = 400;

  /**
   * `POST /voice/tts-preview` — short MP3 sample for Settings “Test voice”.
   * Does not change the active `WorkersAITTS` instance (separate from live voice).
   */
  async previewTts(speakerRaw: string, text?: string): Promise<Response> {
    const errJson = (message: string, status: number) =>
      new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const p = parseAuraTtsSpeaker(speakerRaw.trim().toLowerCase());
    if (!p) {
      return errJson("Invalid speaker id", 400);
    }
    if (!this.env.AI) {
      return errJson("AI binding or TTS unavailable", 500);
    }

    const line = (text?.trim() || "Hi! This is a quick voice test for EdgeClaw.").slice(
      0,
      MainAgent.TTS_PREVIEW_MAX_CHARS
    );
    if (!line) {
      return errJson("Text is empty", 400);
    }

    try {
      const runResult = await this.env.AI.run(
        "@cf/deepgram/aura-1",
        { text: line, speaker: p, encoding: "mp3" },
        { returnRawResponse: true }
      );
      const res = runResult as Response;
      const data = await res.arrayBuffer();
      if (data.byteLength === 0) {
        return errJson("Empty audio from TTS", 500);
      }
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errJson(`TTS failed: ${msg}`, 500);
    }
  }

  // ── HTTP request handler ──────────────────────────────────────────────────

  /**
   * Override Think's onRequest to intercept /memory/* REST calls.
   *
   * Think itself wraps this during onStart to pre-handle /get-messages,
   * so this method is called for everything else (including our /memory routes).
   */
  async onRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (/\/voice(\/|$)/.test(pathname)) {
      return await handleVoiceRoute(request, this as unknown as VoiceRouteAdapter);
    }

    if (/\/memory(\/|$)/.test(pathname)) {
      return handleMemoryRoute(request, this as unknown as MemoryRouteAdapter);
    }

    if (/\/mcp(\/|$)/.test(pathname)) {
      return handleMcpRoute(request, this as unknown as McpRouteAdapter);
    }

    if (/\/tasks(\/|$)/.test(pathname)) {
      return handleTaskRoute(request, this as unknown as TaskRouteAdapter);
    }

    if (/\/skills(\/|$)/.test(pathname)) {
      return handleSkillRoute(request, this as unknown as SkillRouteAdapter);
    }

    if (/\/workflows(\/|$)/.test(pathname)) {
      return handleWorkflowRoute(request, this as unknown as WorkflowRouteAdapter);
    }

    if (/\/debug\/orchestrate(\/|$)/.test(pathname)) {
      return handleDebugOrchestrateDoRequest(request, this);
    }

    if (/\/debug\/project-autonomy(\/|$)/.test(pathname)) {
      return handleProjectAutonomyDoRequest(request, this);
    }

    if (/\/debug\/delegated-ping(\/|$)/.test(pathname)) {
      return handleDebugDelegatedPingDoRequest(request, {
        env: this.env,
        delegateToDebugPingChildTransportProbe: () => this.delegateToDebugPingChildTransportProbe(),
      });
    }

    if (/\/debug\/coordinator-chain(\/|$)/.test(pathname)) {
      return handleDebugCoordinatorChainDoRequest(request, this.env);
    }

    // Nothing else handled at the DO level — return 404.
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

