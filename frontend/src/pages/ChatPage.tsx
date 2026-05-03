import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AgentClient, type AgentActivityEvent } from "../lib/agentClient";
import { isBrowserToolResult } from "../lib/browserArtifacts";
import type {
  AssistantTurn,
  AssistantTurnEvent,
  AssistantTurnStatus,
  ActivityStep,
  ActivityStepStatus,
  BrowserToolResult,
  BrowserSessionResult,
  FeatureSettings,
  ReasoningItem,
  TimelineItem,
  TimelineMessageItem,
  ContextEventItem,
  ContextEventAction,
} from "../types";
import { isBrowserSessionResult } from "../types";
import { AssistantTurnCard } from "../components/chat/AssistantTurnCard";
import { ContextEventRow } from "../components/chat/ContextEventRow";
import {
  getVoiceUiState,
  useEdgeClawVoice,
  type VoiceUiStateOrOff,
} from "../voice/VoiceService";
import { VOICE_CLIENT_DBG } from "../voice/voiceDebugTransport";
import { VoiceMicButton } from "../components/chat/VoiceMicButton";
import { IconPaperclip, IconPaperPlaneRight } from "../components/chat/ChatComposerIcons";
import { getMcpState } from "../lib/mcpApi";
import { computeMcpHeaderPill } from "../lib/mcpHeaderHealth";
import type { McpDiscoverySnapshot } from "../types/mcp";

/** TEMP: one-line typed-TTS / in-call probe — remove with `useEffect` below. */
const TYPED_TTS_INCALL_DBG = true;

interface ChatPageProps {
  endpoint: string;
  onNewChat: () => void;
  settings: FeatureSettings;
  /** Open Settings (e.g. MCP) from inline re-auth callouts. */
  onOpenMcpSettings?: () => void;
}

const AUTO_COLLAPSE_DELAY_MS = 1800;

/** User mic mute preference (upstream silence); survives refresh and navigation. */
const EDGECLAW_VOICE_MIC_MUTED_KEY = "edgeclaw.voice.muted";

/**
 * Read persisted mic mute. Missing/invalid key → muted (safe default: not "listening").
 */
function readPersistedVoiceMicMuted(): boolean {
  try {
    const v = localStorage.getItem(EDGECLAW_VOICE_MIC_MUTED_KEY);
    if (v === null) return true;
    if (v === "false" || v === "0") return false;
    return true;
  } catch {
    return true;
  }
}

function writePersistedVoiceMicMuted(muted: boolean): void {
  try {
    localStorage.setItem(EDGECLAW_VOICE_MIC_MUTED_KEY, muted ? "true" : "false");
  } catch {
    // private mode / quota — voice still works for the session
  }
}

function nextId(): string {
  return crypto.randomUUID();
}

interface ChatComposerAttachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

function createComposerAttachment(file: File): ChatComposerAttachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "image/png",
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getMessageText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("");
}

function getMessagePreviewLabel(parts: Array<{ type: string; text?: string; mediaType?: string }>): string {
  const text = getMessageText(parts);
  const fileCount = parts.filter((p) => p.type === "file").length;
  if (text.trim()) return text;
  if (fileCount > 0) return fileCount === 1 ? "[Image attachment]" : `[${fileCount} image attachments]`;
  return "";
}

function uniqueDetailLines(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function toBrowserToolResult(output: unknown): BrowserToolResult | undefined {
  return isBrowserToolResult(output) ? output : undefined;
}

function toBrowserSessionResult(output: unknown): BrowserSessionResult | undefined {
  return isBrowserSessionResult(output) ? output : undefined;
}

function activityStatusFromToolState(state?: string): ActivityStepStatus {
  switch ((state ?? "").trim().toLowerCase()) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return "running";
    case "output-available":
      return "completed";
    case "output-error":
    case "output-denied":
      return "failed";
    default:
      return "queued";
  }
}

function buildDetailLinesFromToolPart(part: ProtocolMessageLike["parts"][number]): string[] | undefined {
  const browserResult = toBrowserToolResult(part.output);
  const sessionResult = toBrowserSessionResult(part.output);
  const lines: string[] = [];

  if (browserResult?.pageUrl) {
    lines.push(`URL: ${browserResult.pageUrl}`);
  }
  if (browserResult?.description) {
    lines.push(browserResult.description);
  }
  if (browserResult?.rawOutputText) {
    lines.push(browserResult.rawOutputText);
  }
  if (sessionResult?.currentUrl) {
    lines.push(`URL: ${sessionResult.currentUrl}`);
  }
  if (sessionResult?.summary) {
    lines.push(sessionResult.summary);
  }
  if (part.errorText) {
    lines.push(part.errorText);
  }
  if (part.text) {
    lines.push(part.text);
  }

  const deduped = uniqueDetailLines(lines);
  return deduped.length > 0 ? deduped : undefined;
}

function toAuthoritativeActivitySteps(message: ProtocolMessageLike): ActivityStep[] {
  return message.parts
    .filter((part) => part.toolName)
    .map((part, index) => ({
      id: part.toolCallId ?? `${part.toolName ?? "tool"}-${index}`,
      label: part.title ?? part.toolName ?? "tool",
      status: activityStatusFromToolState(part.state),
      detailLines: buildDetailLinesFromToolPart(part),
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      toolResult: toBrowserToolResult(part.output),
      sessionResult: toBrowserSessionResult(part.output),
    }));
}

function parseAgentIdentity(endpoint: string): { agentIdentifier: string; sessionIdentifier: string } {
  try {
    const url = new URL(endpoint);
    const segments = url.pathname.split("/").filter(Boolean);
    const agentIndex = segments.indexOf("agents");
    const className = agentIndex >= 0 ? segments[agentIndex + 1] : undefined;
    const agentName = agentIndex >= 0 ? segments[agentIndex + 2] : undefined;
    const agentIdentifier = className && agentName ? `${className}/${agentName}` : url.pathname;
    const sessionIdentifier = agentName ?? "default";
    return { agentIdentifier, sessionIdentifier };
  } catch {
    return { agentIdentifier: endpoint, sessionIdentifier: "unknown" };
  }
}

interface ProtocolMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<{
    type: string;
    text?: string;
    state?: string;
    toolCallId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    errorText?: string;
    title?: string;
  }>;
}

function toTimelineMessage(message: ProtocolMessageLike): TimelineMessageItem | null {
  if (message.role === "assistant") {
    return null;
  }

  const text = getMessagePreviewLabel(message.parts);
  if (!text && message.role !== "system") {
    return null;
  }

  // Workflow completion notifications are injected as role:"user" to trigger a
  // model turn (the only reliable way to generate a streaming response from an
  // external callback).  They are not real user input and should not appear as
  // "You" bubbles in the chat.  The model still sees them in the message history.
  if (message.role === "user" && text.trimStart().startsWith("[Workflow notification]")) {
    return null;
  }
  // Same for scheduled tasks (see MainAgent `triggerTurn` with a label like
  // "Scheduled task: {title}"); hide the synthetic "You" bubble, keep history
  // and assistant turn visible.
  if (message.role === "user" && text.trimStart().startsWith("[Scheduled task:")) {
    return null;
  }

  return {
    kind: "message",
    id: message.id,
    role: message.role,
    text,
    source: "authoritative",
  };
}

function reasoningSummaryFromAssistantParts(
  messageId: string,
  parts: ProtocolMessageLike["parts"]
): ReasoningItem[] {
  const out: ReasoningItem[] = [];
  let idx = 0;
  for (const part of parts) {
    if (part.type !== "reasoning") continue;
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (!text) continue;
    out.push({
      id: `${messageId}-reasoning-${idx++}`,
      text,
      status: "complete",
      at: Date.now(),
    });
  }
  return out;
}

function toAuthoritativeAssistantTurn(message: ProtocolMessageLike): AssistantTurn | null {
  if (message.role !== "assistant") {
    return null;
  }

  const activitySteps = toAuthoritativeActivitySteps(message);
  const toolsUsed = [...new Set(activitySteps.map((step) => step.toolName).filter(Boolean) as string[])];
  const reasoningSummary = reasoningSummaryFromAssistantParts(message.id, message.parts);

  return {
    kind: "assistant-turn",
    id: message.id,
    role: "assistant",
    status: "done",
    reasoningSummary,
    activitySteps,
    content: getMessageText(message.parts),
    toolsUsed,
    isStreaming: false,
    ui: {
      reasoningExpanded: reasoningSummary.length > 0 || activitySteps.length > 0,
      activityExpanded: activitySteps.length > 0,
      userToggledReasoning: false,
      userToggledActivity: false,
    },
  };
}

function buildUserTimelineMessage(id: string, text: string): TimelineMessageItem {
  return {
    kind: "message",
    id,
    role: "user",
    text,
    source: "optimistic",
  };
}

function isAssistantTurn(item: TimelineItem): item is AssistantTurn {
  return item.kind === "assistant-turn";
}

function createAssistantTurn(id: string, at = Date.now()): AssistantTurn {
  return {
    kind: "assistant-turn",
    id,
    role: "assistant",
    status: "thinking",
    reasoningSummary: [],
    activitySteps: [],
    content: "",
    toolsUsed: [],
    startedAt: at,
    isStreaming: true,
    ui: {
      reasoningExpanded: true,
      activityExpanded: true,
      userToggledReasoning: false,
      userToggledActivity: false,
    },
  };
}

function upsertReasoningItem(items: ReasoningItem[], next: ReasoningItem, mode: "append" | "replace-last"): ReasoningItem[] {
  if (mode === "replace-last" && items.length > 0) {
    const cloned = [...items];
    cloned[cloned.length - 1] = next;
    return cloned;
  }

  if (items.some((item) => item.text === next.text && item.status === next.status)) {
    return items;
  }

  return [...items, next];
}

function upsertActivityStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  if (index === -1) {
    return [...steps, step];
  }

  const next = [...steps];
  next[index] = {
    ...next[index],
    ...step,
    detailLines: step.detailLines ?? next[index].detailLines,
    toolResult: step.toolResult ?? next[index].toolResult,
    sessionResult: step.sessionResult ?? next[index].sessionResult,
  };
  return next;
}

function updateActivityStep(
  steps: ActivityStep[],
  stepId: string,
  updater: (step: ActivityStep) => ActivityStep
): ActivityStep[] {
  return steps.map((step) => (step.id === stepId ? updater(step) : step));
}

function statusFromStepState(stepStatus: ActivityStepStatus): AssistantTurnStatus {
  if (stepStatus === "failed") return "failed";
  if (stepStatus === "running" || stepStatus === "queued") return "using_tools";
  return "thinking";
}

function applyAssistantTurnEvent(items: TimelineItem[], event: AssistantTurnEvent): TimelineItem[] {
  if (event.type === "turn.started") {
    if (items.some((item) => isAssistantTurn(item) && item.id === event.turnId)) {
      return items;
    }
    return [...items, createAssistantTurn(event.turnId, event.at)];
  }

  return items.map((item) => {
    if (!isAssistantTurn(item) || item.id !== event.turnId) {
      return item;
    }

    switch (event.type) {
      case "reasoning.updated": {
        const mode = event.mode ?? "append";
        if (mode === "replace-by-id") {
          const idx = item.reasoningSummary.findIndex((r) => r.id === event.item.id);
          const nextSummary =
            idx >= 0
              ? item.reasoningSummary.map((r, i) => (i === idx ? { ...event.item } : r))
              : [...item.reasoningSummary, event.item];
          return {
            ...item,
            reasoningSummary: nextSummary,
          };
        }
        return {
          ...item,
          reasoningSummary: upsertReasoningItem(
            item.reasoningSummary,
            event.item,
            mode === "replace-last" ? "replace-last" : "append"
          ),
        };
      }

      case "tool.selected":
      case "tool.started":
        return {
          ...item,
          status: statusFromStepState(event.step.status),
          activitySteps: upsertActivityStep(item.activitySteps, event.step),
        };

      case "tool.progress":
        return {
          ...item,
          status: "using_tools",
          activitySteps: updateActivityStep(item.activitySteps, event.stepId, (step) => ({
            ...step,
            status: step.status === "completed" ? "completed" : "running",
            detailLines: uniqueDetailLines([...(step.detailLines ?? []), event.detailLine]),
          })),
        };

      case "tool.completed": {
        const toolName = event.toolName;
        return {
          ...item,
          status: "finalizing",
          toolsUsed: toolName && !item.toolsUsed.includes(toolName) ? [...item.toolsUsed, toolName] : item.toolsUsed,
          activitySteps: updateActivityStep(item.activitySteps, event.stepId, (step) => ({
            ...step,
            status: "completed",
            completedAt: event.at,
            durationMs:
              step.durationMs ?? (step.startedAt ? Math.max(0, event.at - step.startedAt) : undefined),
            detailLines: event.detailLine
              ? uniqueDetailLines([...(step.detailLines ?? []), event.detailLine])
              : step.detailLines,
            toolResult: event.result ?? step.toolResult,
            sessionResult: event.sessionResult ?? step.sessionResult,
          })),
        };
      }

      case "tool.failed": {
        const mcpHint = event.mcpAuthHint === true;
        return {
          ...item,
          status: "failed",
          error: event.error,
          toolsUsed:
            event.toolName && !item.toolsUsed.includes(event.toolName)
              ? [...item.toolsUsed, event.toolName]
              : item.toolsUsed,
          activitySteps: updateActivityStep(item.activitySteps, event.stepId, (step) => ({
            ...step,
            status: "failed",
            completedAt: event.at,
            durationMs:
              step.durationMs ?? (step.startedAt ? Math.max(0, event.at - step.startedAt) : undefined),
            detailLines: uniqueDetailLines([...(step.detailLines ?? []), event.error]),
            mcpReauth: mcpHint
              ? { toolName: event.toolName, errorText: event.error }
              : undefined,
          })),
          isStreaming: false,
          ui: mcpHint ? { ...item.ui, activityExpanded: true } : item.ui,
        };
      }

      case "content.delta":
        return {
          ...item,
          isStreaming: true,
          content: item.content + event.delta,
        };

      case "approval.requested": {
        const approvalStep: ActivityStep = {
          id: `approval-${event.request.toolCallId}`,
          label: `Approval required: ${event.request.toolName}`,
          status: "running",
          startedAt: Date.now(),
          detailLines: ["Waiting for your confirmation before continuing."],
          toolName: event.request.toolName,
        };
        return {
          ...item,
          status: "awaiting_approval",
          approvalRequest: event.request,
          activitySteps: upsertActivityStep(item.activitySteps, approvalStep),
          ui: {
            ...item.ui,
            reasoningExpanded: true,
            activityExpanded: true,
          },
        };
      }

      case "turn.finalizing":
        return {
          ...item,
          status: item.status === "failed" ? "failed" : "finalizing",
        };

      case "turn.completed":
        return {
          ...item,
          status: item.status === "failed" ? "failed" : "done",
          completedAt: event.at,
          isStreaming: false,
          approvalRequest: null,
          reasoningSummary: item.reasoningSummary.map((entry) => ({ ...entry, status: "complete" })),
          activitySteps: item.activitySteps.map((step) =>
            step.status === "running" || step.status === "queued"
              ? {
                  ...step,
                  status: "completed",
                  completedAt: event.at,
                  durationMs:
                    step.durationMs ??
                    (step.startedAt ? Math.max(0, event.at - step.startedAt) : undefined),
                }
              : step
          ),
        };

      case "turn.failed":
        return {
          ...item,
          status: "failed",
          isStreaming: false,
          completedAt: event.at,
          error: event.error,
        };

      case "turn.ui.updated":
        return {
          ...item,
          ui: {
            ...item.ui,
            ...event.ui,
            ...event.touched,
          },
        };

      default:
        return item;
    }
  });
}

function inferToolName(title: string): string {
  const withoutFailed = title.replace(/\s+failed$/i, "").trim();

  const approvalMatch = withoutFailed.match(/^Approval required:\s*(.+)$/i);
  if (approvalMatch?.[1]) {
    return approvalMatch[1].trim();
  }

  const quotedMatch = withoutFailed.match(/"([^"]+)"/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  if (withoutFailed && withoutFailed !== "tool") {
    return withoutFailed;
  }

  return "tool";
}

const MCP_REAUTH_ERR_RE =
  /401|403|unauthor|oauth|token|expir|forbidden|permission|credential|re-?auth|sign in|authenticat|mcp/i;

/** Context/skill tools — not MCP surfaces; do not show MCP re-auth on their failures. */
const MCP_REAUTH_EXCLUDED_TOOLS = new Set([
  "load_context",
  "unload_context",
  "update_context",
  "save_context",
  "create_skill",
  "update_skill",
  "delete_skill",
]);

function isLikelyMcpReauthCase(
  enableMcp: boolean,
  toolName: string,
  err: string,
  activityTitle: string
): boolean {
  if (!enableMcp) return false;
  if (toolName.startsWith("browser_") || toolName === "execute") return false;
  if (MCP_REAUTH_EXCLUDED_TOOLS.has(toolName)) return false;
  if (/^mcp|mcp_|_mcp/i.test(toolName) || toolName.includes("mcp")) return true;
  if (MCP_REAUTH_ERR_RE.test(err) || MCP_REAUTH_ERR_RE.test(activityTitle)) return true;
  return false;
}

function toReasoningText(event: AgentActivityEvent): string {
  // Full model reasoning from persisted `cf_agent_message_updated` parts — match agents-starter.
  if (event.kind === "reasoning" && event.title === "Reasoning step") {
    const raw = (event.detail ?? "").trim();
    if (raw) return raw;
  }

  const raw = (event.detail?.trim() || event.title.trim() || "").replace(/\s+/g, " ");
  const lower = raw.toLowerCase();

  // Never surface verbose internal traces; present concise product-facing summaries.
  if (lower.includes("approval") || lower.includes("confirm")) {
    return "Waiting for your approval to continue.";
  }
  if (lower.includes("browser_search") || lower.includes("search")) {
    return "Checking available browser tool options.";
  }
  if (lower.includes("browser_execute") || lower.includes("navigate") || lower.includes("dom")) {
    return "Inspecting page content with browser execution.";
  }
  if (lower.includes("title") || lower.includes("h1") || lower.includes("heading")) {
    return "Extracting requested page details.";
  }
  if (lower.includes("final") || lower.includes("response") || lower.includes("answer")) {
    return "Preparing the final response.";
  }
  if (lower.includes("error") || lower.includes("failed")) {
    return "Handling an execution issue.";
  }

  const cleaned = raw
    .replace(/`[^`]*`/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "Understanding your request and planning the next action.";
  }

  const limited = cleaned.slice(0, 96);
  return limited.length < cleaned.length ? `${limited.trimEnd()}...` : limited;
}

function getOrCreateStepId(title: string, prefix: string, toolCallId?: string): string {
  if (toolCallId) {
    return `${prefix}-${toolCallId}`;
  }
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return `${prefix}-${normalized || "step"}`;
}

function toAssistantTurnEventsFromActivity(
  event: AgentActivityEvent,
  turnId: string,
  enableMcp: boolean
): AssistantTurnEvent[] {
  const normalizedTitle = event.title.trim().toLowerCase();
  const normalizedDetail = event.detail?.trim().toLowerCase() ?? "";

  if (event.kind === "reasoning") {
    return [
      {
        type: "reasoning.updated",
        turnId,
        item: {
          id: event.id,
          text: toReasoningText(event),
          status: "active",
          at: event.at,
        },
      },
    ];
  }

  if (event.kind === "tool") {
    const isFailure = /\bfailed\b/.test(event.title) || normalizedTitle.includes(" failed");
    if (isFailure) {
      const toolName = inferToolName(event.title);
      const stepId = getOrCreateStepId(toolName, "tool", event.toolCallId);
      const err = event.detail?.trim() || "This step could not complete.";
      const mcpAuthHint = isLikelyMcpReauthCase(
        enableMcp,
        toolName,
        err,
        event.title
      );
      return [
        {
          type: "tool.failed",
          turnId,
          stepId,
          at: event.at,
          error: err,
          toolName,
          mcpAuthHint,
        },
      ];
    }

    const toolName = inferToolName(event.title);
    const isApproval = normalizedTitle.startsWith("approval required:");
    const looksLikeResult =
      normalizedTitle.includes("result") ||
      normalizedTitle.includes("finished") ||
      normalizedTitle.includes("completed") ||
      normalizedDetail.includes("result");

    const stepId = getOrCreateStepId(toolName, "tool", event.toolCallId);

    if (isApproval) {
      return [
        {
          type: "tool.selected",
          turnId,
          step: {
            id: stepId,
            label: `Approval required: ${toolName}`,
            status: "running",
            startedAt: event.at,
            detailLines: [event.detail ?? "Waiting for approval."],
            toolName,
            toolCallId: event.toolCallId,
          },
        },
      ];
    }

    if (looksLikeResult) {
      return [
        {
          type: "tool.completed",
          turnId,
          stepId,
          at: event.at,
          toolName,
          toolCallId: event.toolCallId,
          detailLine:
            event.detail ??
            (toolName === "browser_search"
              ? "Search results ready for browser command selection."
              : toolName === "browser_execute"
                ? "Browser execution completed with extracted output."
                : toolName === "browser_session"
                  ? "Browser session step completed."
                  : event.title),
          result: isBrowserToolResult(event.output) ? event.output : undefined,
          sessionResult: isBrowserSessionResult(event.output) ? event.output : undefined,
        },
      ];
    }

    return [
      {
        type: "tool.started",
        turnId,
        step: {
          id: stepId,
          label: toolName,
          status: "running",
          startedAt: event.at,
          detailLines:
            event.detail
              ? [event.detail]
              : toolName === "browser_search"
                ? ["Searching for browser command patterns."]
                : toolName === "browser_execute"
                  ? ["Executing browser navigation and DOM extraction."]
                  : undefined,
          toolName,
          toolCallId: event.toolCallId,
        },
      },
    ];
  }

  if (normalizedTitle === "turn started") {
    return [{ type: "turn.started", turnId, at: event.at }];
  }

  if (normalizedTitle === "step finished" || normalizedDetail.includes("reasoning step completed")) {
    return [
      {
        type: "tool.completed",
        turnId,
        stepId: getOrCreateStepId("thinking", "step", event.toolCallId),
        at: event.at,
        detailLine: event.detail ?? event.title,
      },
    ];
  }

  if (normalizedTitle === "response finished") {
    return [{ type: "turn.completed", turnId, at: event.at }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Context / skill event helpers
// ---------------------------------------------------------------------------

const CONTEXT_TOOL_BASE_NAMES = new Set([
  "load_context",
  "unload_context",
  "update_context",
  "save_context",
  "create_skill",
  "update_skill",
  "delete_skill",
]);

function isContextToolName(title: string): boolean {
  const base = title.trim().toLowerCase().replace(/\s*(completed|started|failed|done)$/, "").trim();
  return CONTEXT_TOOL_BASE_NAMES.has(base);
}

function slugToDisplayName(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

/** Returns the raw storage key (e.g. "code-reviewer") or undefined. */
function extractRawSkillKey(input?: Record<string, unknown>, detail?: string): string | undefined {
  if (input) {
    for (const prop of ["key", "skillKey", "contextKey", "name", "skillName", "context_key", "skill_key"]) {
      const val = input[prop];
      if (typeof val === "string" && val) return val;
    }
  }
  if (detail) {
    const match = /(?:skill|key|context)[:\s]+([a-z0-9][a-z0-9\-_]*)/i.exec(detail);
    if (match?.[1]) return match[1];
  }
  return undefined;
}


function getContextAction(toolBaseName: string): ContextEventAction {
  if (toolBaseName.startsWith("unload")) return "unload";
  if (toolBaseName.startsWith("update") || toolBaseName.startsWith("save")) return "update";
  if (toolBaseName.startsWith("delete")) return "delete";
  if (toolBaseName.startsWith("create")) return "create";
  return "load";
}

function tryBuildContextEvent(event: AgentActivityEvent): ContextEventItem | null {
  if (event.kind !== "tool") return null;

  const normalizedTitle = event.title.trim().toLowerCase();
  const isCompleted =
    normalizedTitle.endsWith(" completed") ||
    normalizedTitle.endsWith(" done") ||
    normalizedTitle.endsWith(" finished");

  if (!isCompleted) return null;

  const baseName = normalizedTitle.replace(/\s*(completed|done|finished)$/, "").trim();
  if (!CONTEXT_TOOL_BASE_NAMES.has(baseName)) return null;

  const action = getContextAction(baseName);
  const rawKey = extractRawSkillKey(event.input, event.detail);
  const skillName = rawKey ? slugToDisplayName(rawKey) : "skill";

  const detail = event.detail?.trim();
  const genericDetail = "Tool execution completed.";
  const description =
    detail && detail !== genericDetail && detail.length <= 140 ? detail : undefined;

  return {
    kind: "context-event",
    id: event.id,
    at: event.at,
    action,
    skillName,
    skillKey: rawKey,
    description,
  };
}

/** Inserts a context event just before the last assistant turn (so it renders
 *  between the user's message and the agent's final reply). Falls back to
 *  appending at the end if no assistant turn is found. */
function insertBeforeLastTurn(prev: TimelineItem[], event: ContextEventItem): TimelineItem[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].kind === "assistant-turn") {
      return [...prev.slice(0, i), event, ...prev.slice(i)];
    }
  }
  return [...prev, event];
}

// ---------------------------------------------------------------------------

function renderTimelineItem(item: TimelineItem) {
  if (item.kind === "message") {
    return (
      <article key={item.id} className={`chat-message role-${item.role}`}>
        <header>
          <strong>{item.role === "user" ? "You" : "System"}</strong>
        </header>
        <div className="message-content">{item.text}</div>
      </article>
    );
  }

  if (item.kind === "context-event") {
    return <ContextEventRow key={item.id} item={item} />;
  }

  return null;
}

function buildDemoBrowserTimelineSeed(): TimelineItem[] {
  const now = Date.now();

  const userMessage: TimelineMessageItem = {
    kind: "message",
    id: nextId(),
    role: "user",
    text: "Inspect example.com and tell me the page title plus the first H1.",
    source: "optimistic",
  };

  const assistantTurn: AssistantTurn = {
    kind: "assistant-turn",
    id: nextId(),
    role: "assistant",
    status: "done",
    startedAt: now - 3200,
    completedAt: now,
    isStreaming: false,
    reasoningSummary: [
      { id: nextId(), text: "Understanding your request", status: "complete", at: now - 3100 },
      { id: nextId(), text: "Determining browser tools are required", status: "complete", at: now - 2900 },
      { id: nextId(), text: "Inspecting page content and extracting key fields", status: "complete", at: now - 2300 },
      { id: nextId(), text: "Preparing concise final response", status: "complete", at: now - 700 },
    ],
    activitySteps: [
      {
        id: "demo-thinking",
        label: "Thinking",
        status: "completed",
        startedAt: now - 3200,
        completedAt: now - 2800,
        detailLines: ["Mapped request to browser inspection workflow."],
      },
      {
        id: "demo-browser-search",
        label: "browser_search",
        status: "completed",
        toolName: "browser_search",
        startedAt: now - 2700,
        completedAt: now - 2100,
        detailLines: [
          "Found command pattern for opening a page and running evaluation.",
          "URL: https://example.com",
        ],
      },
      {
        id: "demo-browser-execute",
        label: "browser_execute",
        status: "completed",
        toolName: "browser_execute",
        toolCallId: "demo-browser-execute-call",
        startedAt: now - 2000,
        completedAt: now - 1300,
        detailLines: [
          "Navigated URL: https://example.com",
          "Title: Example Domain",
          "First H1: Example Domain",
        ],
        toolResult: {
          schema: "edgeclaw.browser-tool-result",
          schemaVersion: 1,
          toolName: "browser_execute",
          pageUrl: "https://example.com",
          description: "Captured page preview after DOM inspection.",
          artifact: {
            kind: "image",
            url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
            mimeType: "image/gif",
            width: 1,
            height: 1,
          },
          metadata: {
            title: "Example Domain",
            firstH1: "Example Domain",
          },
        },
      },
      {
        id: "demo-title",
        label: "Extracted title",
        status: "completed",
        startedAt: now - 1250,
        completedAt: now - 900,
        detailLines: ["Title: Example Domain"],
      },
      {
        id: "demo-h1",
        label: "Extracted first H1",
        status: "completed",
        startedAt: now - 880,
        completedAt: now - 520,
        detailLines: ["First H1: Example Domain"],
      },
      {
        id: "demo-final",
        label: "Final answer",
        status: "completed",
        startedAt: now - 500,
        completedAt: now,
        detailLines: ["Response assembled and delivered in chat."],
      },
    ],
    toolsUsed: ["browser_search", "browser_execute"],
    content:
      "I inspected https://example.com. The page title is \"Example Domain\" and the first H1 is \"Example Domain\".",
    ui: {
      reasoningExpanded: true,
      activityExpanded: true,
      userToggledReasoning: false,
      userToggledActivity: false,
    },
  };

  return [userMessage, assistantTurn];
}

/** Header badge copy — keys match `getVoiceUiState` (`VoiceUiStateOrOff`). */
const VOICE_UI_LABELS: Record<VoiceUiStateOrOff, string> = {
  off:       "Voice off",
  ready:     "Ready",
  muted:     "Muted",
  listening: "Listening…",
  thinking:  "Thinking…",
  speaking:  "Speaking",
};

export function ChatPage({ endpoint, onNewChat, settings, onOpenMcpSettings }: ChatPageProps) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [composerText, setComposerText] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ChatComposerAttachment[]>([]);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  const [errorText, setErrorText] = useState<string | null>(null);
  const pendingAssistantIdRef = useRef<string | null>(null);
  const autoCollapseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastSubmittedRef = useRef<{ text: string; at: number } | null>(null);
  /** Last user message text for “Retry last step” after MCP re-authentication. */
  const lastUserMessageTextRef = useRef<string | null>(null);
  const chatFeedRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  // true  → scroll to bottom on next message update
  // false → user has scrolled up; don't interrupt them
  const shouldFollowRef = useRef(true);
  // Force a scroll-to-bottom on the very first content render (initial load / new session).
  const isInitialRenderRef = useRef(true);
  const identity = useMemo(() => parseAgentIdentity(endpoint), [endpoint]);

  const [mcpSnapshot, setMcpSnapshot] = useState<McpDiscoverySnapshot | null>(null);
  const [mcpLoad, setMcpLoad] = useState<"loading" | "ok" | "error">(() =>
    settings.enableMcp ? "loading" : "ok"
  );

  const mcpPill = useMemo(
    () => computeMcpHeaderPill(settings.enableMcp, mcpSnapshot, mcpLoad),
    [settings.enableMcp, mcpSnapshot, mcpLoad]
  );

  // ── Voice integration (gated behind settings.enableVoice) ───────────────
  // All voice state is co-located here so the diff is self-contained and easy
  // to revert if needed without touching any existing logic.
  const voiceEnabled = settings.enableVoice === true;

  // ── "Agent speaks" preference ─────────────────────────────────────────────
  //
  // Controls whether the agent's text replies are also played back as TTS audio.
  // This is a client-side UX preference: the toggle in VoiceControls lets the
  // user flip it at any time during a session.
  //
  // Initialized from settings.voiceMode so the first render matches the user's
  // stated intent:
  //
  //   "disabled"     → The voice UI may still render when enableVoice is true
  //                    (e.g. settings panel shows the section), but the user
  //                    has not opted into audio output.  Default to false so
  //                    no TTS-related affordances are highlighted.
  //
  //   "push-to-talk" → The user will speak to the agent manually.  They chose
  //                    a voice interaction mode, so TTS response is likely
  //                    desired.  Default to true.
  //
  //   "hands-free"   → Continuous mic + TTS reply — fully bidirectional voice.
  //                    Default to true.
  //
  //   undefined      → settings not yet loaded or voice not configured.
  //                    Default to true (most expressive; user can toggle off).
  //
  // `agentShouldSpeak` is sent on each `cf_agent_use_chat_request` as
  // `settings.agentShouldSpeak` so MainAgent can skip TTS for typed turns when
  // the user turns "Agent speaks" off (saves TTS if the call is only for input).
  const [agentShouldSpeak, setAgentShouldSpeak] = useState<boolean>(
    // Lazy initializer: runs once on mount, reads the prop synchronously.
    // "disabled" is the only mode that should suppress TTS by default;
    // every other mode (including undefined) keeps it on.
    () => settings.voiceMode !== "disabled"
  );

  // Derive voice agent coordinates from the existing session URL so we don't
  // hardcode a separate agent name.  The path segment after /agents/ is the
  // Durable Object binding name (e.g. "main-agent").
  const voiceAgentName = identity.agentIdentifier.split("/")[0];
  const voice = useEdgeClawVoice({
    agent:   voiceAgentName,
    name:    identity.sessionIdentifier,
    enabled: voiceEnabled,
  });

  // One UI model for badge + mic (see `getVoiceUiState` in VoiceService.ts).
  const hasActiveSpeech = (voice.interimTranscript?.trim().length ?? 0) > 0;
  const voiceUiState: VoiceUiStateOrOff | null = voiceEnabled
    ? getVoiceUiState({
        connected: voice.connected,
        isMuted: voice.isMuted,
        status: voice.status,
        hasActiveSpeech,
      })
    : null;

  /** Mic mute: update SDK + persist immediately so refresh/navigation stay in sync. */
  const handleVoiceMicMuteToggle = useCallback(() => {
    if (!voiceEnabled) return;
    const wantMuted = !voice.isMuted;
    voice.setMuted(wantMuted);
    writePersistedVoiceMicMuted(wantMuted);
  }, [voiceEnabled, voice.isMuted, voice.setMuted]);

  // ── Auto-connect: start call, then apply persisted mic mute ────────────────
  //
  // Mic mute is a user preference in localStorage (`edgeclaw.voice.muted`),
  // not derived from Settings → Voice Mode, so refresh/navigation keep the last
  // choice. Default when unset: muted (does not imply active listening).
  //
  // Guard ref prevents double-connecting if this effect re-runs (e.g. React
  // StrictMode double-invoke, or `voice.connected` briefly flickering).
  const hasAutoConnectedRef = useRef(false);
  const startVoiceInFlightRef = useRef(false);
  const onCallLatchedThisSessionRef = useRef(false);
  const [ttsIncallDbg, setTtsIncallDbg] = useState(0);
  const bumpTtsIncallDbg = useCallback(() => {
    setTtsIncallDbg((n) => n + 1);
  }, []);

  // TEMP: [voice-dbg-client] time-correlate `speaking` with a recent text chat send
  const lastTextChatSendAtRef = useRef(0);
  const voiceStatusPrevForDbg = useRef<string>(voice.status);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !voiceEnabled) return;
    if (voiceStatusPrevForDbg.current === voice.status) return;
    if (voiceStatusPrevForDbg.current !== "speaking" && voice.status === "speaking") {
      const t = lastTextChatSendAtRef.current;
      const d = t > 0 ? Date.now() - t : -1;
      console.info(
        `[voice-dbg-client] status_to_speaking ms_since_text_send=${d >= 0 ? d : "n/a"} ` +
          `likely_typed_tts_from_server=${d >= 0 && d < 25_000} (heuristic: chat WS + TTS on voice WS)`
      );
    }
    voiceStatusPrevForDbg.current = voice.status;
  }, [voiceEnabled, voice.status]);
  // -- end TEMP

  // Run before the auto `startCall` effect below. Clears the guard on voice
  // toggle or on agent/session change so a new in-call (server) can be
  // established; a stale `true` blocks re-`startVoice` and typed TTS
  // (MainAgent `_voiceInCallConnectionIds`) has nothing to target.
  useEffect(() => {
    hasAutoConnectedRef.current = false;
    startVoiceInFlightRef.current = false;
    onCallLatchedThisSessionRef.current = false;
    bumpTtsIncallDbg();
  }, [bumpTtsIncallDbg, voiceEnabled, identity.agentIdentifier, identity.sessionIdentifier]);

  useEffect(() => {
    if (!voiceEnabled) return;
    if (!voice.connected) return;        // wait until WS handshake completes
    if (voice.status !== "idle") return; // already started
    if (hasAutoConnectedRef.current) return;

    hasAutoConnectedRef.current = true;
    startVoiceInFlightRef.current = true;
    onCallLatchedThisSessionRef.current = false;
    bumpTtsIncallDbg();

    // startVoice never rejects — errors surface through voice.error.
    const p = voice.startVoice();
    p.then(() => {
      onCallLatchedThisSessionRef.current = true;
      bumpTtsIncallDbg();
      voice.setMuted(readPersistedVoiceMicMuted());
    }).finally(() => {
      startVoiceInFlightRef.current = false;
      bumpTtsIncallDbg();
    });
  }, [
    bumpTtsIncallDbg,
    voiceEnabled,
    voice.connected,
    voice.status,
    voice.startVoice,
    voice.setMuted,
  ]);

  // TEMP: single probe for server `onCallStart` (latched when startVoice() settles).
  useEffect(() => {
    if (!TYPED_TTS_INCALL_DBG) return;
    if (!voiceEnabled) return;
    // eslint-disable-next-line no-console -- temp typed-TTS investigation
    console.info(
      `[typed-tts-investigate] session=${identity.sessionIdentifier} ` +
        `startVoiceInFlight=${startVoiceInFlightRef.current} onCallLatchedThisSession=${onCallLatchedThisSessionRef.current}`
    );
  }, [identity.sessionIdentifier, voiceEnabled, ttsIncallDbg]);

  // End the call cleanly when the component unmounts (navigate away).
  useEffect(() => {
    return () => {
      if (voiceEnabled) {
        voice.stopVoice();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — cleanup only on unmount

  // Voice: finalized user utterances and assistant replies for a voice turn
  // are already persisted and broadcast by the Durable Object (`onTurn` →
  // `saveMessages` / chat sync). Do not re-send the transcript on the text
  // WebSocket (that was duplicating the user line and running a second turn).
  // Interim transcript is shown only in the live bar; it is not in the timeline.

  const isNearBottom = (el: HTMLDivElement, threshold = 80): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  };

  const scrollToBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
  };

  const queueAutoCollapse = (turnId: string) => {
    const existing = autoCollapseTimersRef.current.get(turnId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      setTimeline((prev) =>
        applyAssistantTurnEvent(prev, {
          type: "turn.ui.updated",
          turnId,
          ui: {},
          touched: {},
        }).map((item) => {
          if (!isAssistantTurn(item) || item.id !== turnId) {
            return item;
          }

          const shouldCollapseReasoning = !item.ui.userToggledReasoning;
          const shouldCollapseActivity = !item.ui.userToggledActivity;

          if (!shouldCollapseReasoning && !shouldCollapseActivity) {
            return item;
          }

          return {
            ...item,
            ui: {
              ...item.ui,
              reasoningExpanded: shouldCollapseReasoning ? false : item.ui.reasoningExpanded,
              activityExpanded: shouldCollapseActivity ? false : item.ui.activityExpanded,
            },
          };
        })
      );
      autoCollapseTimersRef.current.delete(turnId);
    }, AUTO_COLLAPSE_DELAY_MS);

    autoCollapseTimersRef.current.set(turnId, timeout);
  };

  const dispatchTurnEvent = (event: AssistantTurnEvent) => {
    setTimeline((prev) => applyAssistantTurnEvent(prev, event));
  };

  const dispatchTurnEvents = (events: AssistantTurnEvent[]) => {
    if (events.length === 0) return;
    setTimeline((prev) => events.reduce((acc, event) => applyAssistantTurnEvent(acc, event), prev));
  };

  const client = useMemo(
    () =>
      new AgentClient({
        url: endpoint,
        onStatusChange: (nextStatus) => {
          setStatus(nextStatus);
          if (nextStatus === "connected") {
            // Clear any stale transient socket error once the session recovers.
            setErrorText(null);
          }
        },
        onMessagesReplaced: (serverMessages, source) => {
          // Guard: never replace a live timeline with an empty server payload.
          // This protects against transient recovery responses that arrive before
          // the DO has finished persisting the last turn.
          if (serverMessages.length === 0) {
            console.info(
              `[EdgeClaw][chat] persisted_restore source=${source} count=0 skipped (guard: empty) ` +
                `agent=${identity.agentIdentifier} session=${identity.sessionIdentifier}`
            );
            return;
          }

          const hydrated = serverMessages.flatMap((msg) => {
            const protocolLike = {
              id: msg.id,
              role: msg.role,
              parts: msg.parts,
            } as ProtocolMessageLike;

            const assistantTurn = toAuthoritativeAssistantTurn(protocolLike);
            if (assistantTurn) {
              return [assistantTurn as TimelineItem];
            }

            const message = toTimelineMessage(protocolLike);
            return message ? [message as TimelineItem] : [];
          });

          // Merge hydrated server messages with existing timeline.
          // Rule: server content is authoritative for completed turns.
          //       Client UI state (expanded/collapsed) is preserved where possible.
          //       In-progress turns that the server doesn't know about yet are appended.
          pendingAssistantIdRef.current = null;
          shouldFollowRef.current = true;
          isInitialRenderRef.current = true;

          setTimeline((prev) => {
            // Index existing items by ID for O(1) lookup.
            const existingById = new Map<string, TimelineItem>(prev.map((item) => [item.id, item]));
            const serverIds = new Set(hydrated.map((item) => item.id));

            // For each hydrated item, preserve UI toggles from existing if present.
            const merged = hydrated.map((serverItem) => {
              const existing = existingById.get(serverItem.id);
              if (!existing || !isAssistantTurn(serverItem) || !isAssistantTurn(existing)) {
                return serverItem;
              }
              // Server history often omits `reasoning` parts (e.g. Workers AI / Kimi) even when
              // the live stream emitted reasoning-* chunks — keep streamed reasoning on merge.
              const mergedReasoning =
                serverItem.reasoningSummary.length > 0
                  ? serverItem.reasoningSummary
                  : existing.reasoningSummary.length > 0
                    ? existing.reasoningSummary.map((r) => ({ ...r, status: "complete" as const }))
                    : serverItem.reasoningSummary;
              const mergedActivity =
                serverItem.activitySteps.length > 0
                  ? serverItem.activitySteps
                  : existing.activitySteps.length > 0
                    ? existing.activitySteps
                    : serverItem.activitySteps;
              // Preserve manual UI state the user may have set, but take server content.
              return {
                ...serverItem,
                reasoningSummary: mergedReasoning,
                activitySteps: mergedActivity,
                ui: {
                  ...serverItem.ui,
                  reasoningExpanded: existing.ui.userToggledReasoning
                    ? existing.ui.reasoningExpanded
                    : mergedReasoning.length > 0 || mergedActivity.length > 0
                      ? true
                      : serverItem.ui.reasoningExpanded,
                  activityExpanded: existing.ui.userToggledActivity
                    ? existing.ui.activityExpanded
                    : mergedActivity.length > 0
                      ? true
                      : serverItem.ui.activityExpanded,
                  userToggledReasoning: existing.ui.userToggledReasoning,
                  userToggledActivity: existing.ui.userToggledActivity,
                },
              } as TimelineItem;
            });

            // Append any in-progress client-side turns the server doesn't have yet
            // (e.g. a streaming turn that began after the last persist checkpoint).
            const inProgress = prev.filter(
              (item) => !serverIds.has(item.id) && isAssistantTurn(item) && item.status !== "done" && item.status !== "failed"
            );

            return [...merged, ...inProgress];
          });

          console.info(
            `[EdgeClaw][chat] persisted_restore source=${source} restored=yes ` +
              `count=${hydrated.length} agent=${identity.agentIdentifier} session=${identity.sessionIdentifier}`
          );
        },
        onAssistantDelta: (delta) => {
          const existingId = pendingAssistantIdRef.current ?? nextId();
          if (!pendingAssistantIdRef.current) {
            pendingAssistantIdRef.current = existingId;
            dispatchTurnEvent({ type: "turn.started", turnId: existingId, at: Date.now() });
          }

          dispatchTurnEvent({ type: "content.delta", turnId: existingId, delta });
        },
        onReasoningStream: ({ partId, text }) => {
          let turnId = pendingAssistantIdRef.current;
          if (!turnId) {
            turnId = nextId();
            pendingAssistantIdRef.current = turnId;
            dispatchTurnEvent({ type: "turn.started", turnId, at: Date.now() });
          }
          const trimmed = text.trim();
          if (!trimmed) return;
          dispatchTurnEvent({
            type: "reasoning.updated",
            turnId,
            mode: "replace-by-id",
            item: {
              id: partId,
              text: trimmed,
              status: "active",
              at: Date.now(),
            },
          });
        },
        onAssistantDone: () => {
          const pendingId = pendingAssistantIdRef.current;
          pendingAssistantIdRef.current = null;
          if (!pendingId) return;
          dispatchTurnEvent({ type: "turn.completed", turnId: pendingId, at: Date.now() });
          queueAutoCollapse(pendingId);
        },
        onStepStatus: (value) => {
          const pendingId = pendingAssistantIdRef.current;
          if (!pendingId || !value) return;
          dispatchTurnEvent({
            type: "reasoning.updated",
            turnId: pendingId,
            mode: "replace-last",
            item: {
              id: nextId(),
              text: value,
              status: "active",
              at: Date.now(),
            },
          });
        },
        onActivity: (event) => {
          const turnId = pendingAssistantIdRef.current ?? nextId();
          if (!pendingAssistantIdRef.current) {
            pendingAssistantIdRef.current = turnId;
            dispatchTurnEvent({ type: "turn.started", turnId, at: event.at });
          }

          // Skill / context operations produce compact inline timeline rows rather
          // than entries in the assistant-turn activity steps.  Suppress both
          // started and completed events from the activity timeline so there is
          // no duplication; the ContextEventRow carries the relevant information.
          if (isContextToolName(event.title)) {
            const ctxEvent = tryBuildContextEvent(event);
            if (ctxEvent) {
              setTimeline((prev) => insertBeforeLastTurn(prev, ctxEvent));
            }
            return;
          }

          dispatchTurnEvents(toAssistantTurnEventsFromActivity(event, turnId, settings.enableMcp));
        },
        onToolApprovalRequired: (request) => {
          const turnId = pendingAssistantIdRef.current ?? nextId();
          if (!pendingAssistantIdRef.current) {
            pendingAssistantIdRef.current = turnId;
            dispatchTurnEvent({ type: "turn.started", turnId, at: Date.now() });
          }

          dispatchTurnEvent({ type: "approval.requested", turnId, request });
        },
        onError: (message) => {
          const pendingId = pendingAssistantIdRef.current;
          if (pendingId) {
            dispatchTurnEvent({
              type: "turn.failed",
              turnId: pendingId,
              at: Date.now(),
              error: message,
            });
            pendingAssistantIdRef.current = null;
          }
          setErrorText(message);
        },
      }),
    [endpoint]
  );

  // When the session endpoint changes (New Chat), clear the local timeline immediately
  // so old messages don't bleed through while the new DO session loads.
  // This runs before the connect effect below, so the screen is blank by the time
  // the new WebSocket opens and /get-messages is fetched.
  useEffect(() => {
    setTimeline([]);
    pendingAssistantIdRef.current = null;
    shouldFollowRef.current = true;
    isInitialRenderRef.current = true;
  }, [endpoint]);

  // Poll MCP discovery for the same Durable Object session as the chat (header health pill).
  useEffect(() => {
    if (!settings.enableMcp) {
      setMcpLoad("ok");
      setMcpSnapshot(null);
      return;
    }

    let cancelled = false;
    let first = true;

    const run = () => {
      getMcpState(undefined, identity.sessionIdentifier)
        .then((s) => {
          if (cancelled) return;
          setMcpSnapshot(s);
          setMcpLoad("ok");
        })
        .catch(() => {
          if (cancelled) return;
          if (first) {
            setMcpSnapshot(null);
            setMcpLoad("error");
          }
        })
        .finally(() => {
          first = false;
        });
    };

    setMcpLoad("loading");
    setMcpSnapshot(null);
    run();

    const id = setInterval(run, 20000);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [settings.enableMcp, identity.sessionIdentifier]);

  useEffect(() => {
    console.info(
      `[EdgeClaw][chat] connect agent=${identity.agentIdentifier} session=${identity.sessionIdentifier}`
    );
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [client, identity.agentIdentifier, identity.sessionIdentifier]);

  useEffect(() => {
    return () => {
      autoCollapseTimersRef.current.forEach((timeout) => clearTimeout(timeout));
      autoCollapseTimersRef.current.clear();
    };
  }, []);

  const sendProgrammaticMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const clientMessageId = nextId();
    const result = client.sendUserMessage(trimmed, {
      messageId: clientMessageId,
      settings: { ...settings, agentShouldSpeak } as import("../types").FeatureSettings,
    });
    if (!result.accepted) {
      return;
    }
    lastTextChatSendAtRef.current = Date.now();

    shouldFollowRef.current = true;

    const pendingTurnId = nextId();
    pendingAssistantIdRef.current = pendingTurnId;

    setTimeline((prev) => [
      ...prev,
      buildUserTimelineMessage(result.messageId, trimmed),
      createAssistantTurn(pendingTurnId),
    ]);
    setErrorText(null);
  }, [client, settings, agentShouldSpeak]);

  const addComposerImages = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setComposerAttachments((prev) => [...prev, ...images.map(createComposerAttachment)]);
  }, []);

  const removeComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleRetryMcpLastUser = useCallback(() => {
    const t = lastUserMessageTextRef.current?.trim();
    if (t) {
      sendProgrammaticMessage(t);
    }
  }, [sendProgrammaticMessage]);

  const openMcpSettings = useCallback(() => {
    onOpenMcpSettings?.();
  }, [onOpenMcpSettings]);

  useEffect(() => {
    const el = chatFeedRef.current;
    if (!el) return;

    const forceScroll = isInitialRenderRef.current;
    isInitialRenderRef.current = false;

    // Evaluate near-bottom synchronously before yielding to paint, so the
    // decision is based on the scroll position the user actually sees.
    const shouldScroll = forceScroll || shouldFollowRef.current;
    if (!shouldScroll) return;

    // Defer one frame so the new DOM nodes are laid out before we measure.
    requestAnimationFrame(() => {
      if (!chatFeedRef.current) return;
      scrollToBottom(chatFeedRef.current);
    });
  }, [timeline]);

  const sendMessage = async () => {
    const text = composerText.trim();
    const attachSig = composerAttachments.map((a) => a.id).join("|");
    if (!text && composerAttachments.length === 0) return;

    const now = Date.now();
    const last = lastSubmittedRef.current;
    const dedupeKey = `${text}::${attachSig}`;
    if (last && last.text === dedupeKey && now - last.at < 1200) {
      console.info("[EdgeClaw][chat] send status=ignored_duplicate_ui");
      return;
    }

    const fileParts =
      composerAttachments.length > 0
        ? await Promise.all(
            composerAttachments.map(async (a) => ({
              mediaType: a.mediaType || "image/png",
              url: await fileToDataUri(a.file),
            }))
          )
        : undefined;

    const clientMessageId = nextId();
    const result = client.sendUserMessage(text, {
      messageId: clientMessageId,
      settings: { ...settings, agentShouldSpeak },
      fileParts,
    });
    if (!result.accepted) {
      return;
    }
    lastTextChatSendAtRef.current = Date.now();

    lastSubmittedRef.current = { text: dedupeKey, at: now };
    lastUserMessageTextRef.current = text || null;

    const bubbleText =
      text ||
      (composerAttachments.length > 0
        ? composerAttachments.length === 1
          ? "[Image attachment]"
          : `[${composerAttachments.length} image attachments]`
        : "");

    // User just sent — re-anchor scroll to bottom.
    shouldFollowRef.current = true;

    // Show an immediate "thinking" card so the user always sees the agent
    // responded to their message, even before the first WebSocket event arrives.
    const pendingTurnId = nextId();
    pendingAssistantIdRef.current = pendingTurnId;

    setTimeline((prev) => [
      ...prev,
      buildUserTimelineMessage(result.messageId, bubbleText),
      createAssistantTurn(pendingTurnId),
    ]);
    setComposerText("");
    for (const a of composerAttachments) {
      URL.revokeObjectURL(a.preview);
    }
    setComposerAttachments([]);
    setErrorText(null);
  };

  const handleResumeBrowserSession = (sessionId: string) => {
    sendProgrammaticMessage(
      `Use browser_session with operation "resume_browser_session" and sessionId "${sessionId}" to reconnect the existing browser session, then continue from the current live session state.`
    );
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  /** Auto-grow textarea (agents-starter–style); cap height for long pastes. */
  const syncComposerTextareaHeight = useCallback(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxPx = 160; /* matches CSS max-height ~10rem */
    const minPx = 44;
    const next = Math.min(Math.max(el.scrollHeight, minPx), maxPx);
    el.style.height = `${next}px`;
  }, []);

  useLayoutEffect(() => {
    syncComposerTextareaHeight();
  }, [composerText, composerAttachments, syncComposerTextareaHeight]);

  const isStreaming = timeline.some((item) => item.kind === "assistant-turn" && item.isStreaming);
  const isConnected = status === "connected";
  const canSend =
    isConnected && (composerText.trim().length > 0 || composerAttachments.length > 0) && !isStreaming;
  const headerStatus = status === "disconnected" ? "disconnected" : status === "connected" ? "connected" : "connecting";
  const headerStatusLabel =
    headerStatus === "connected"
      ? "Connected"
      : headerStatus === "disconnected"
        ? "Disconnected"
        : "Connecting";

  // Send is icon-only in the composer; header pill remains the primary connection status.

  const handleToggleReasoning = (turnId: string) => {
    dispatchTurnEvent({
      type: "turn.ui.updated",
      turnId,
      ui: {},
      touched: {},
    });
    setTimeline((prev) =>
      prev.map((item) => {
        if (!isAssistantTurn(item) || item.id !== turnId) return item;
        const isOpen = item.ui.reasoningExpanded || item.ui.activityExpanded;
        const next = !isOpen;
        return {
          ...item,
          ui: {
            ...item.ui,
            reasoningExpanded: next,
            activityExpanded: next,
            userToggledReasoning: true,
            userToggledActivity: true,
          },
        };
      })
    );
  };

  const withTurnApproval = (turnId: string, approved: boolean) => {
    const found = timeline.find(
      (item): item is AssistantTurn => isAssistantTurn(item) && item.id === turnId
    );
    if (!found || !found.approvalRequest) return;
    client.approveTool(found.approvalRequest.toolCallId, approved);
    setTimeline((prev) =>
      prev.map((item) => {
        if (!isAssistantTurn(item) || item.id !== turnId) return item;
        return {
          ...item,
          status: approved ? "using_tools" : "failed",
          error: approved ? item.error : "Tool approval was denied.",
          approvalRequest: null,
        };
      })
    );
  };

  const handleApprove = (turnId: string) => withTurnApproval(turnId, true);
  const handleDeny = (turnId: string) => withTurnApproval(turnId, false);

  const loadDemoSeed = () => {
    shouldFollowRef.current = true;
    isInitialRenderRef.current = true;
    setTimeline(buildDemoBrowserTimelineSeed());
    setErrorText(null);
  };

  return (
    <section className="page-shell">
      <div className="chat-inner">
        <header className="page-header">
          <div className="page-header-main">
            <h2>Chat</h2>
            <div className="chat-meta-row">
              <p className="muted subhead">Session {identity.sessionIdentifier}</p>
              <span className={`chat-status-badge chat-status-${headerStatus}`}>{headerStatusLabel}</span>
              {voiceUiState && (
                <span
                  className={`chat-status-badge voice-badge-${voiceUiState}`}
                  aria-label={`Voice: ${VOICE_UI_LABELS[voiceUiState]}`}
                >
                  {VOICE_UI_LABELS[voiceUiState]}
                </span>
              )}
              {onOpenMcpSettings ? (
                <button
                  type="button"
                  className={`chat-status-badge ${mcpPill.className} mcp-pill-cta`}
                  title={mcpPill.title}
                  onClick={onOpenMcpSettings}
                  aria-label={mcpPill.title}
                >
                  {mcpPill.label}
                </button>
              ) : (
                <span
                  className={`chat-status-badge ${mcpPill.className}`}
                  title={mcpPill.title}
                >
                  {mcpPill.label}
                </span>
              )}
            </div>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn-header-secondary" onClick={onNewChat}>
              New chat
            </button>
          </div>
        </header>

        {errorText && <div className="error-banner">{errorText}</div>}
        {/* Voice errors are surfaced inline in the VoiceControls toolbar
            (near the composer) rather than here so the chat feed is never
            displaced by a banner. See voice.error → VoiceControls error prop. */}

        <div
          className="chat-feed"
          aria-live="polite"
          ref={chatFeedRef}
          onScroll={(event) => {
            // Update follow-mode based on whether the user is near the bottom.
            // Reading this synchronously on scroll keeps the ref accurate without extra state.
            shouldFollowRef.current = isNearBottom(event.currentTarget);
          }}
        >
          {timeline.length === 0 && (
            <section className="welcome-card">
              <h3>Welcome to EdgeClaw</h3>
              <p>
                Ask a question, review code, or kick off a task. Conversation history is restored from
                your persistent Think session.
              </p>
              <p className="muted">Tip: Press Enter to send, Shift+Enter for a new line.</p>
              <div className="welcome-actions">
                <button type="button" className="btn-header-secondary" onClick={loadDemoSeed}>
                  Load browser task demo
                </button>
              </div>
            </section>
          )}
          {timeline.map((item) => {
            if (item.kind === "assistant-turn") {
              return (
                <AssistantTurnCard
                  key={item.id}
                  turn={item}
                  onToggleReasoning={handleToggleReasoning}
                  onApprove={handleApprove}
                  onDeny={handleDeny}
                  onResumeBrowserSession={handleResumeBrowserSession}
                  enableMcp={settings.enableMcp}
                  onOpenMcpSettings={openMcpSettings}
                  onRetryMcpLastUser={handleRetryMcpLastUser}
                />
              );
            }

            return renderTimelineItem(item);
          })}
        </div>

        {/*
          Interim transcript bar — appears just above the composer when the
          user is speaking.  Shows the STT's live partial result.  Final
          user/assistant content for a voice turn arrives via the same chat
          session sync as typed messages (not a second client send).
        */}
        {voiceEnabled && !voice.isMuted && voice.interimTranscript && (
          <div className="voice-interim-bar" aria-live="polite" aria-atomic="true">
            <span className="voice-interim-text">{voice.interimTranscript}</span>
            <span className="voice-interim-cursor" aria-hidden="true" />
          </div>
        )}

        {/*
          composer: paperclip + textarea + send inside one rounded shell; voice mic
          sits beside the bubble when voice is enabled.
        */}
        <input
          ref={composerFileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const list = e.target.files;
            if (list && list.length > 0) addComposerImages(list);
            e.target.value = "";
          }}
        />
        <div className={`composer${voiceEnabled ? " has-voice" : ""}`}>
          {composerAttachments.length > 0 ? (
            <div className="composer-attachments" aria-label="Attached images">
              {composerAttachments.map((a) => (
                <div key={a.id} className="composer-attachment-thumb-wrap">
                  <img src={a.preview} alt="" className="composer-attachment-thumb" />
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() => removeComposerAttachment(a.id)}
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="composer-input-wrap">
            <button
              type="button"
              className="composer-attach-btn"
              onClick={() => composerFileInputRef.current?.click()}
              disabled={!isConnected || isStreaming}
              aria-label="Attach image"
            >
              <IconPaperclip />
            </button>
            <textarea
              ref={composerTextareaRef}
              className="composer-textarea"
              placeholder="Send a message…"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              aria-label="Message to agent"
            />
            <button
              type="button"
              className="composer-send-btn"
              onClick={() => void sendMessage()}
              disabled={!canSend}
              aria-busy={isStreaming}
              aria-label={isStreaming ? "Agent is responding" : "Send message"}
              title={isStreaming ? "Streaming…" : "Send"}
            >
              <IconPaperPlaneRight />
            </button>
          </div>
          {voiceEnabled && voiceUiState != null ? (
            <div className="composer-actions">
              <VoiceMicButton
                voiceUiState={voiceUiState}
                audioLevel={voice.displayMeterLevel}
                agentShouldSpeak={agentShouldSpeak}
                error={voice.error}
                onToggleMute={handleVoiceMicMuteToggle}
                onToggleAgentSpeaks={() => setAgentShouldSpeak((v) => !v)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
