import type { AuraTtsSpeaker } from "./lib/auraTts";

export type { AuraTtsSpeaker } from "./lib/auraTts";

export type NavItem =
  | "Chat"
  | "Sub-Agents"
  | "Agent Browsing"
  | "Memory"
  | "Workflows"
  | "Tasks"
  | "Skills"
  | "Channels"
  | "Settings";

export interface FeatureSettings {
  modelProfile: "balanced" | "quality" | "speed";
  enableBrowserTools: boolean;
  enableCodeExecution: boolean;
  enableMcp: boolean;
  enableVoice: boolean;
  observabilityLevel: "off" | "error" | "info" | "debug";
  voiceMode: "disabled" | "push-to-talk" | "hands-free";
  /**
   * Workers AI TTS voice for @cf/deepgram/aura-1 (agent spoken replies). Kept
   * in localStorage; sent to the worker in `settings` and via POST
   * `/api/voice/tts-speaker`.
   */
  ttsSpeaker: AuraTtsSpeaker;
  /**
   * Sent on each chat request. When `true` and a voice call is active, the
   * worker may play TTS for **typed** assistant turns (the chat timeline
   * remains the single source of text). Omitted or `false` disables that path.
   */
  agentShouldSpeak?: boolean;
  /**
   * Which browser automation backend to use.
   * "cdp"       — raw CDP over WebSocket (default, production-tested)
   * "puppeteer" — @cloudflare/puppeteer (cleaner API, experimental)
   */
  browserStepExecutor: "cdp" | "puppeteer";
  /**
   * Agent Browsing page only: Workers AI binding vs Cloudflare AI Gateway (`dynamic/agent-router`).
   * Gateway path sends `cf-aig-metadata` with `agent: BrowserAgent` (see `docs/ai-gateway-agent-router.json`).
   */
  browsingInferenceBackend: "workers-ai" | "ai-gateway";
  /**
   * Deepgram Flux: confidence required before an utterance is considered
   * finished and sent to the agent (maps to `eotThreshold`). Range 0.5–0.9.
   * @default 0.7
   */
  voiceFluxEotThreshold: number;
  /**
   * Max silence (ms) before Flux may force an end-of-turn. Range 500–10000.
   * @default 5000
   */
  voiceFluxEotTimeoutMs: number;
  /**
   * Optional lower “eager” end-of-turn threshold; enables earlier speculative
   * model signals. Must be ≤ `voiceFluxEotThreshold` if set. Omitted / undefined
   * = disabled. Range 0.3–0.9 when set.
   */
  voiceFluxEagerEotThreshold?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
}

export type TimelineMessageRole = "user" | "system";
export type TimelineMessageSource = "authoritative" | "optimistic";

export interface TimelineMessageItem {
  kind: "message";
  id: string;
  role: TimelineMessageRole;
  text: string;
  source: TimelineMessageSource;
}

export type AssistantTurnStatus =
  | "thinking"
  | "using_tools"
  | "finalizing"
  | "done"
  | "failed"
  | "awaiting_approval";

export type ReasoningItemStatus = "active" | "complete";

export type ActivityStepStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface ReasoningItem {
  id: string;
  text: string;
  status?: ReasoningItemStatus;
  at?: number;
}

export interface BrowserImageArtifact {
  kind: "image";
  url?: string;
  binaryRef?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface BrowserToolResult {
  schema: "edgeclaw.browser-tool-result";
  schemaVersion: 1;
  toolName: string;
  pageUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  rawOutputText?: string;
  artifact?: BrowserImageArtifact | null;
  /** UI-only rendering hint: complete data URL for screenshot. Never displayed in visible text. */
  _screenshotDataUrl?: string;
}

// ---------------------------------------------------------------------------
// Browser Session
// ---------------------------------------------------------------------------

export type BrowserSessionStatus =
  | "pending"
  | "launching"
  | "active"
  | "awaiting_human"
  | "disconnected"
  | "completed"
  | "abandoned";

export interface BrowserSessionResult {
  schema: "edgeclaw.browser-session-result";
  schemaVersion: 1;
  sessionId: string;
  status: BrowserSessionStatus;
  recordingEnabled: boolean;
  browserRunSessionId?: string;
  reusableSessionId?: string;
  reusedSession?: boolean;
  devtoolsFrontendUrl?: string;
  liveViewUrl?: string;
  liveViewUrlFetchedAt?: number;
  currentUrl?: string;
  title?: string;
  currentTargetId?: string;
  sessionRecordingUrl?: string;
  recordingId?: string;
  recordingReady?: boolean;
  recordingUrl?: string;
  browserRunSessionIdPresent?: boolean;
  needsHumanIntervention?: boolean;
  humanInterventionReason?: string;
  resumableSession?: {
    sessionId: string;
    liveViewUrl?: string;
    expiresAt?: string;
  };
  summary?: string;
  logLines?: string[];
  _liveViewUrl?: string;
  _needsHumanIntervention?: boolean;
  _resumeBrowserAction?: {
    operation: "resume_browser_session";
    sessionId: string;
  };
  /** UI-only rendering hint: screenshot data URL captured at end of session step. */
  _screenshotDataUrl?: string;
}

export function isBrowserSessionResult(value: unknown): value is BrowserSessionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.schema === "edgeclaw.browser-session-result" &&
    r.schemaVersion === 1 &&
    typeof r.sessionId === "string"
  );
}

/** Shown inline under a failed tool step when MCP re-auth may fix the failure. */
export interface McpReauthCalloutData {
  toolName?: string;
  /** Raw error from the tool (classify 401 vs 403 heuristics for copy). */
  errorText: string;
}

export interface ActivityStep {
  id: string;
  label: string;
  status: ActivityStepStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  detailLines?: string[];
  toolName?: string;
  toolCallId?: string;
  toolResult?: BrowserToolResult;
  sessionResult?: BrowserSessionResult;
  /**
   * When set, the activity UI may render a reconnect / OAuth / retry strip
   * next to this step (MCP only — not browser tools).
   */
  mcpReauth?: McpReauthCalloutData;
}

export interface AssistantTurnUiState {
  reasoningExpanded: boolean;
  activityExpanded: boolean;
  userToggledReasoning?: boolean;
  userToggledActivity?: boolean;
}

export interface AssistantTurn {
  kind: "assistant-turn";
  id: string;
  role: "assistant";
  status: AssistantTurnStatus;
  reasoningSummary: ReasoningItem[];
  activitySteps: ActivityStep[];
  content: string;
  toolsUsed: string[];
  startedAt?: number;
  completedAt?: number;
  error?: string | null;
  isStreaming?: boolean;
  ui: AssistantTurnUiState;
  approvalRequest?: ToolApprovalRequest | null;
}

// ---------------------------------------------------------------------------
// Context / Skill activity events
// ---------------------------------------------------------------------------

export type ContextEventAction = "load" | "unload" | "update" | "create" | "delete";

/**
 * A lightweight inline timeline row emitted when the agent loads, unloads,
 * or modifies a session skill / context block.  These are client-only items
 * (never persisted on the server) and are intentionally excluded from the
 * `onMessagesReplaced` hydration path.
 */
export interface ContextEventItem {
  kind: "context-event";
  id: string;
  at: number;
  action: ContextEventAction;
  /** Display name derived from the skill key, e.g. "Code Reviewer". */
  skillName: string;
  /**
   * Raw storage key as passed to load_context / unload_context, e.g.
   * "code-reviewer".  Present whenever the key was recoverable from the
   * tool's input arguments; used to correlate events with SkillSummary.key.
   */
  skillKey?: string;
  /** Optional secondary detail, e.g. a one-line description. */
  description?: string;
}

/** A single entry in the unified conversation timeline. */
export type TimelineItem = TimelineMessageItem | AssistantTurn | ContextEventItem;

export type AssistantTurnEvent =
  | { type: "turn.started"; turnId: string; at: number }
  | {
      type: "reasoning.updated";
      turnId: string;
      item: ReasoningItem;
      /** `replace-by-id` upserts `item` keyed by `item.id` (used for streaming model reasoning). */
      mode?: "append" | "replace-last" | "replace-by-id";
    }
  | {
      type: "tool.selected" | "tool.started";
      turnId: string;
      step: ActivityStep;
    }
  | {
      type: "tool.progress";
      turnId: string;
      stepId: string;
      detailLine: string;
    }
  | {
      type: "tool.completed";
      turnId: string;
      stepId: string;
      at: number;
      toolName?: string;
      toolCallId?: string;
      detailLine?: string;
      result?: BrowserToolResult;
      sessionResult?: BrowserSessionResult;
    }
  | {
      type: "tool.failed";
      turnId: string;
      stepId: string;
      at: number;
      error: string;
      toolName?: string;
      /** When true, attach `mcpReauth` to the step for inline reconnect / OAuth UI. */
      mcpAuthHint?: boolean;
    }
  | {
      type: "content.delta";
      turnId: string;
      delta: string;
    }
  | {
      type: "approval.requested";
      turnId: string;
      request: ToolApprovalRequest;
    }
  | { type: "turn.finalizing"; turnId: string }
  | { type: "turn.completed"; turnId: string; at: number }
  | { type: "turn.failed"; turnId: string; at: number; error: string }
  | {
      type: "turn.ui.updated";
      turnId: string;
      ui: Partial<Pick<AssistantTurnUiState, "reasoningExpanded" | "activityExpanded">>;
      touched?: Partial<Pick<AssistantTurnUiState, "userToggledReasoning" | "userToggledActivity">>;
    };

export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  reason?: string;
  args?: Record<string, unknown>;
}
