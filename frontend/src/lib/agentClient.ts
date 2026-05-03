import type { BrowserToolResult, BrowserSessionResult, FeatureSettings, ToolApprovalRequest } from "../types";
import { isBrowserToolResult } from "./browserArtifacts";
import { isEdgeclawTtsDebugEnabled } from "./ttsDebug";
import { isBrowserSessionResult } from "../types";

type AgentSocketEvent = Record<string, unknown>;

interface ProtocolMessagePart {
  type: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  title?: string;
  /** User message image / file (data URL), when type is `file`. */
  mediaType?: string;
  url?: string;
}

export interface AgentActivityEvent {
  id: string;
  kind: "status" | "reasoning" | "tool";
  title: string;
  detail?: string;
  at: number;
  toolCallId?: string;
  output?: BrowserToolResult | BrowserSessionResult | unknown;
  /** Raw tool input arguments — populated for tool-kind events so callers can
   *  extract structured data such as the skill key for load_context/unload_context. */
  input?: Record<string, unknown>;
}

interface ProtocolMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: ProtocolMessagePart[];
}

interface StreamProtocolEvent {
  type?: string;
  id?: string;
  textDelta?: string;
  delta?: string;
  [key: string]: unknown;
}

export interface AgentClientOptions {
  url: string;
  onStatusChange?: (status: "connecting" | "connected" | "reconnecting" | "disconnected") => void;
  onMessagesReplaced?: (messages: ProtocolMessage[], source: "restore" | "broadcast") => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: () => void;
  onStepStatus?: (status: string | null) => void;
  onToolApprovalRequired?: (request: ToolApprovalRequest) => void;
  onError?: (message: string) => void;
  onActivity?: (event: AgentActivityEvent) => void;
  /**
   * AI SDK `toUIMessageStream()` reasoning stream (`reasoning-delta` chunks).
   * Distinct from `onActivity` so the UI can upsert one bubble per `partId`.
   */
  onReasoningStream?: (payload: { partId: string; text: string }) => void;
}

export interface SendUserMessageOptions {
  messageId?: string;
  retry?: boolean;
  /** Current feature settings — forwarded in the request body so the agent
   *  can apply per-turn preferences (e.g. browserStepExecutor). */
  settings?: FeatureSettings;
  /** Optional image/file parts (data URLs). Appended after the text part. */
  fileParts?: ReadonlyArray<{ mediaType: string; url: string }>;
}

export interface SendUserMessageResult {
  accepted: boolean;
  messageId: string;
  status: "new" | "retried" | "duplicate" | "not-connected" | "empty";
}

export class AgentClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manuallyClosed = false;
  // True once the socket has opened at least once; used to distinguish connecting vs reconnecting.
  private hasConnectedBefore = false;
  private readonly options: AgentClientOptions;
  private readonly history: ProtocolMessage[] = [];
  private readonly textBuffers = new Map<string, string>();
  private readonly reasoningBuffers = new Map<string, string>();
  private readonly sentMessageIds = new Set<string>();
  private readonly seenStreamEvents = new Set<string>();
  private responseFinished = false;
  private readonly rpcPending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private resetStreamingState(): void {
    this.responseFinished = false;
    this.textBuffers.clear();
    this.reasoningBuffers.clear();
    this.seenStreamEvents.clear();
  }

  private finalizeStreamingState(): void {
    this.responseFinished = true;
    this.textBuffers.clear();
    this.reasoningBuffers.clear();
    this.seenStreamEvents.clear();
  }

  constructor(options: AgentClientOptions) {
    this.options = options;
  }

  private summarizeToolCompletion(part: ProtocolMessagePart): string {
    if (isBrowserSessionResult(part.output)) {
      const s = part.output;
      if (s.status === "awaiting_human") {
        return `Browser session paused for human input. ${s.summary ?? ""}`.trim();
      }
      if (s.status === "completed") {
        return s.summary ?? `Browser session ${s.sessionId} completed.`;
      }
      if (s.status === "disconnected") {
        return `Browser session disconnected. Will reconnect on next turn.`;
      }
      if (s._screenshotDataUrl) {
        return s.currentUrl
          ? `Screenshot captured for ${s.currentUrl}`
          : "Screenshot captured.";
      }
      return s.summary ?? `Browser session ${s.status}.`;
    }

    if (isBrowserToolResult(part.output)) {
      if (part.output.artifact?.url || part.output.artifact?.binaryRef) {
        return part.output.pageUrl
          ? `Screenshot artifact captured for ${part.output.pageUrl}`
          : "Screenshot artifact captured.";
      }

      if (part.output.toolName === "browser_execute") {
        return "Browser run completed, but no screenshot artifact was returned.";
      }

      return part.output.rawOutputText?.trim() || part.output.description || "Tool execution completed.";
    }

    return part.text?.trim() || "Tool execution completed.";
  }

  connect(): void {
    this.manuallyClosed = false;
    // Use "connecting" only on the very first attempt; subsequent attempts are "reconnecting".
    if (!this.hasConnectedBefore && this.reconnectAttempts === 0) {
      this.options.onStatusChange?.("connecting");
    }

    this.socket = new WebSocket(this.options.url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.hasConnectedBefore = true;
      this.options.onStatusChange?.("connected");
      void this.restorePersistedMessages();
    };

    this.socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.socket.onerror = () => {
      this.options.onError?.("WebSocket error while communicating with the agent.");
    };

    this.socket.onclose = () => {
      this.options.onStatusChange?.("disconnected");
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.rpcPending) {
      pending.reject(new Error("Disconnected"));
    }
    this.rpcPending.clear();
    this.socket?.close();
    this.socket = null;
    this.options.onStatusChange?.("disconnected");
  }

  /**
   * Invoke a `@callable()` method on the connected agent over the Agents WebSocket RPC protocol.
   */
  callCallable(method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected. Wait for reconnect and try again."));
        return;
      }
      const id = crypto.randomUUID();
      this.rpcPending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ type: "rpc", id, method, args }));
    });
  }

  sendUserMessage(
    message: string,
    options: SendUserMessageOptions = {}
  ): SendUserMessageResult {
    const messageId = options.messageId ?? crypto.randomUUID();
    const isRetry = options.retry === true;

    if (this.sentMessageIds.has(messageId)) {
      console.info(
        `[EdgeClaw][chat] send clientMessageId=${messageId} status=ignored_duplicate`
      );
      return {
        accepted: false,
        messageId,
        status: "duplicate",
      };
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.options.onError?.("Not connected. Wait for reconnect and try again.");
      console.info(
        `[EdgeClaw][chat] send clientMessageId=${messageId} status=not_connected`
      );
      return {
        accepted: false,
        messageId,
        status: "not-connected",
      };
    }

    const trimmedText = message.trim();
    const files = options.fileParts ?? [];
    const parts: ProtocolMessagePart[] = [];
    if (trimmedText.length > 0) {
      parts.push({ type: "text", text: trimmedText });
    }
    for (const f of files) {
      if (f.url && f.mediaType) {
        parts.push({ type: "file", mediaType: f.mediaType, url: f.url });
      }
    }
    if (parts.length === 0) {
      this.options.onError?.("Add a message or at least one image attachment.");
      return {
        accepted: false,
        messageId,
        status: "empty",
      };
    }

    const userMessage: ProtocolMessage = {
      id: messageId,
      role: "user",
      parts,
    };

    this.history.push(userMessage);
    this.sentMessageIds.add(messageId);

    this.socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: crypto.randomUUID(),
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage],
            // Forward active feature settings so the agent can apply per-turn
            // preferences such as browserStepExecutor without redeployment.
            ...(options.settings ? { settings: options.settings } : {}),
          }),
        },
      })
    );

    if (isEdgeclawTtsDebugEnabled() && options.settings) {
      const tts = (options.settings as FeatureSettings).ttsSpeaker;
      console.info(
        `[EdgeClaw][tts-debug] chat send includes settings.ttsSpeaker=${String(tts ?? "(undefined)")} ` +
          "(agent beforeTurn reconfigures WorkersAITTS when this changes)"
      );
    }

    console.info(
      `[EdgeClaw][chat] send clientMessageId=${messageId} status=${isRetry ? "retried" : "new"}`
    );

    return {
      accepted: true,
      messageId,
      status: isRetry ? "retried" : "new",
    };
  }

  approveTool(toolCallId: string, approved: boolean): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.options.onError?.("Not connected. Cannot send approval right now.");
      return;
    }

    this.socket.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved,
        autoContinue: true,
      })
    );
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;

    let payload: AgentSocketEvent;
    try {
      payload = JSON.parse(raw) as AgentSocketEvent;
    } catch {
      return;
    }

    const eventType = typeof payload.type === "string" ? payload.type : "";

    if (eventType === "rpc") {
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) return;
      const pending = this.rpcPending.get(id);
      if (!pending) return;
      this.rpcPending.delete(id);
      if (payload.success === false) {
        const errText = typeof payload.error === "string" ? payload.error : "RPC error";
        pending.reject(new Error(errText));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (eventType === "cf_agent_chat_messages") {
      const next = this.parseProtocolMessages(payload.messages);
      // Only accept the broadcast if the server actually sent messages.
      // An empty list would wipe client-side optimistic / in-progress state.
      if (next.length > 0) {
        // Authoritative server history supersedes any optimistic streamed assistant text.
        this.finalizeStreamingState();
        this.replaceHistory(next, "broadcast");
      }
      return;
    }

    if (eventType === "cf_agent_use_chat_response") {
      const done = payload.done === true;

      this.consumeStreamCarrier(payload.delta);
      this.consumeStreamCarrier(payload.text);
      this.consumeStreamCarrier(payload.body);

      if (done && !this.responseFinished) {
        this.options.onStepStatus?.(null);
        this.options.onAssistantDone?.();
        this.finalizeStreamingState();
      }
      return;
    }

    if (eventType === "cf_agent_message_updated") {
      const message =
        payload.message && typeof payload.message === "object"
          ? (payload.message as { parts?: unknown[] })
          : undefined;
      const parts = Array.isArray(message?.parts)
        ? (message?.parts as ProtocolMessagePart[])
        : [];

      for (const part of parts) {
        // Emit concise reasoning updates when available.
        if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
          this.options.onActivity?.({
            id: crypto.randomUUID(),
            kind: "reasoning",
            title: "Reasoning step",
            detail: part.text.trim(),
            at: Date.now(),
          });
        }

        // Emit tool lifecycle events for inline activity timelines.
        if (part.toolName) {
          const toolState = (part.state ?? "").trim().toLowerCase();
          const toolTitle = part.toolName;

          if (
            toolState === "running" ||
            toolState === "started" ||
            toolState === "in-progress" ||
            toolState === "in_progress"
          ) {
            this.options.onActivity?.({
              id: crypto.randomUUID(),
              kind: "tool",
              title: toolTitle,
              detail: "Tool execution started.",
              at: Date.now(),
              toolCallId: part.toolCallId,
              input: part.input,
            });
          }

          if (
            toolState === "completed" ||
            toolState === "done" ||
            toolState === "succeeded" ||
            toolState === "success"
          ) {
            this.options.onActivity?.({
              id: crypto.randomUUID(),
              kind: "tool",
              title: `${toolTitle} completed`,
              detail: this.summarizeToolCompletion(part),
              at: Date.now(),
              toolCallId: part.toolCallId,
              output: part.output,
              input: part.input,
            });
          }

          if (toolState === "failed" || toolState === "error") {
            this.options.onActivity?.({
              id: crypto.randomUUID(),
              kind: "tool",
              title: `${toolTitle} failed`,
              detail: part.errorText?.trim() || part.text?.trim() || "Tool execution failed.",
              at: Date.now(),
              toolCallId: part.toolCallId,
              output: part.output,
              input: part.input,
            });
          }
        }

        if (part.state === "approval-requested" && part.toolCallId) {
          this.options.onToolApprovalRequired?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? "unknown_tool",
            reason: "Tool call requires approval.",
            args: part.input,
          });
            this.options.onActivity?.({
              id: crypto.randomUUID(),
              kind: "tool",
              title: `Approval required: ${part.toolName ?? "tool"}`,
              detail: "A tool call is waiting for your confirmation.",
              at: Date.now(),
              toolCallId: part.toolCallId,
            });
          break;
        }
      }
    }
  }

  private consumeStreamCarrier(value: unknown): void {
    if (typeof value === "string") {
      this.consumeStreamEventString(value);
      return;
    }

    if (value && typeof value === "object") {
      this.handleStreamProtocolEvent(value as StreamProtocolEvent);
    }
  }

  private consumeStreamEventString(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const lines = trimmed.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      const normalized = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!normalized || normalized === "[DONE]") continue;

      try {
        const event = JSON.parse(normalized) as StreamProtocolEvent;
        this.handleStreamProtocolEvent(event);
      } catch {
        // Ignore non-JSON protocol fragments so they are never rendered as chat text.
      }
    }
  }

  private handleStreamProtocolEvent(event: StreamProtocolEvent): void {
    const type = typeof event.type === "string" ? event.type : "";
    const eventId = typeof event.id === "string" && event.id ? event.id : "default";

    if (
      this.responseFinished &&
      type !== "start" &&
      type !== "start-step" &&
      type !== "reasoning-start" &&
      type !== "reasoning-delta" &&
      type !== "reasoning-end"
    ) {
      return;
    }

    const eventKey = JSON.stringify({
      type,
      eventId,
      delta: event.delta,
      textDelta: event.textDelta,
      event,
    });

    if (this.seenStreamEvents.has(eventKey)) {
      return;
    }
    this.seenStreamEvents.add(eventKey);

    switch (type) {
      case "start":
        this.resetStreamingState();
        this.options.onStepStatus?.("Thinking...");
        this.options.onActivity?.({
          id: crypto.randomUUID(),
          kind: "status",
          title: "Turn started",
          detail: "The assistant started processing your request.",
          at: Date.now(),
        });
        return;

      case "start-step":
        if (this.responseFinished) {
          this.resetStreamingState();
        }
        this.options.onStepStatus?.("Thinking...");
        this.options.onActivity?.({
          id: crypto.randomUUID(),
          kind: "reasoning",
          title: "Reasoning step",
          detail: "Working through the next step.",
          at: Date.now(),
        });
        return;

      case "text-start":
        this.textBuffers.set(eventId, "");
        return;

      case "reasoning-start":
        this.reasoningBuffers.set(eventId, "");
        return;

      case "reasoning-delta": {
        const rDelta =
          (typeof event.delta === "string" && event.delta) ||
          (typeof event.textDelta === "string" && event.textDelta) ||
          "";
        if (!rDelta) return;
        const priorR = this.reasoningBuffers.get(eventId) ?? "";
        const nextR = priorR + rDelta;
        this.reasoningBuffers.set(eventId, nextR);
        this.options.onReasoningStream?.({ partId: eventId, text: nextR });
        return;
      }

      case "reasoning-end":
        return;

      case "text-delta": {
        const delta =
          (typeof event.delta === "string" && event.delta) ||
          (typeof event.textDelta === "string" && event.textDelta) ||
          "";
        if (!delta) return;

        const prior = this.textBuffers.get(eventId) ?? "";
        this.textBuffers.set(eventId, prior + delta);
        this.options.onAssistantDelta?.(delta);
        return;
      }

      case "text-end":
        return;

      case "finish-step":
        this.options.onStepStatus?.(null);
        this.options.onActivity?.({
          id: crypto.randomUUID(),
          kind: "status",
          title: "Step finished",
          detail: "A reasoning step completed.",
          at: Date.now(),
        });
        return;

      case "finish":
        this.options.onStepStatus?.(null);
        this.options.onAssistantDone?.();
        this.options.onActivity?.({
          id: crypto.randomUUID(),
          kind: "status",
          title: "Response finished",
          detail: "The assistant completed this response.",
          at: Date.now(),
        });
        this.finalizeStreamingState();
        return;

      default:
        // Preserve non-text events for future UI without rendering them in message text.
        return;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 8000);
    // Signal reconnecting immediately so the UI does not stay on "disconnected" during the back-off window.
    this.options.onStatusChange?.("reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private replaceHistory(messages: ProtocolMessage[], source: "restore" | "broadcast"): void {
    this.history.length = 0;
    this.history.push(...messages);

    this.sentMessageIds.clear();
    for (const msg of messages) {
      if (msg.role === "user") this.sentMessageIds.add(msg.id);
    }

    this.options.onMessagesReplaced?.([...messages], source);
  }

  private parseProtocolMessages(value: unknown): ProtocolMessage[] {
    if (!Array.isArray(value)) return [];

    const parsed: ProtocolMessage[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as Record<string, unknown>;
      const id = typeof candidate.id === "string" && candidate.id ? candidate.id : crypto.randomUUID();
      const role =
        candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system"
          ? candidate.role
          : "assistant";
      const partsRaw = Array.isArray(candidate.parts) ? candidate.parts : [];
      const parts = partsRaw
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
        .map((p) => ({
          type: typeof p.type === "string" ? p.type : "unknown",
          text: typeof p.text === "string" ? p.text : undefined,
          state: typeof p.state === "string" ? p.state : undefined,
          toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : undefined,
          toolName: typeof p.toolName === "string" ? p.toolName : undefined,
          input: p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : undefined,
          output: p.output,
          errorText: typeof p.errorText === "string" ? p.errorText : undefined,
          title: typeof p.title === "string" ? p.title : undefined,
        }));

      parsed.push({ id, role, parts });
    }

    return parsed;
  }

  private getPersistedMessagesUrl(): string | null {
    try {
      const wsUrl = new URL(this.options.url);
      const httpProtocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
      const basePath = wsUrl.pathname.replace(/\/+$/, "");
      return `${httpProtocol}//${wsUrl.host}${basePath}/get-messages`;
    } catch {
      return null;
    }
  }

  private async restorePersistedMessages(): Promise<void> {
    const url = this.getPersistedMessagesUrl();
    if (!url) return;

    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) return;
      const raw = (await res.json()) as unknown;
      const restored = this.parseProtocolMessages(raw);
      // Guard: never wipe existing client UI state with an empty history.
      // An empty restore means the server has no persisted messages yet;
      // the client may have in-progress optimistic state worth preserving.
      if (restored.length === 0) {
        console.info(
          `[EdgeClaw][chat] restored_messages source=server count=0 skipped (no-op) endpoint=${url}`
        );
        return;
      }
      this.replaceHistory(restored, "restore");
      console.info(
        `[EdgeClaw][chat] restored_messages source=server count=${restored.length} endpoint=${url}`
      );
    } catch {
      // Best-effort hydration only; live chat still works without restore.
    }
  }
}
