/**
 * Playwright + Workers AI browsing UI (ported from harshil1712/agent-browsing, MIT).
 * Connects to EdgeclawBrowsingAgent DO — separate from MainAgent / Chat.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat, getToolCallId } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Globe,
  PaperPlaneRight,
  Stop,
  Trash,
  Circle,
  ArrowClockwise,
  WarningCircle,
  Image as ImageIcon,
  List,
  Desktop,
  ArrowSquareOut,
  Bell,
  BellSlash,
  HandPointing,
  CheckCircle,
} from "@phosphor-icons/react";
import {
  type BrowserStatus,
  isBrowserEvent,
  isValidBase64,
} from "../lib/browsingWireTypes";
import type { FeatureSettings } from "../types";

type BrowsingInferenceBackend = FeatureSettings["browsingInferenceBackend"];

const TOOL_LABELS: Record<string, string> = {
  navigate: "Navigate",
  page_snapshot: "Page snapshot",
  click: "Click",
  fill: "Fill",
  press: "Press key",
  scroll: "Scroll",
  select_option: "Select option",
  check: "Check",
  get_text: "Extract text",
  ask_user: "Ask user",
};

const TOOL_IN_PROGRESS: Record<string, string> = {
  navigate: "Navigating...",
  page_snapshot: "Reading page...",
  click: "Clicking...",
  fill: "Typing...",
  press: "Pressing key...",
  scroll: "Scrolling...",
  select_option: "Selecting...",
  check: "Checking...",
  get_text: "Extracting text...",
};

function toolOutputSummary(toolName: string, output: unknown): string {
  try {
    const o = typeof output === "string" ? JSON.parse(output) : output;
    const rec = o as Record<string, unknown>;
    if (!rec?.success && rec?.error) return `Error: ${String(rec.error)}`;
    switch (toolName) {
      case "navigate":
        return rec?.title ? `Navigated to: ${String(rec.title)}` : "Navigated";
      case "page_snapshot":
        return "Captured page snapshot";
      case "click":
        return rec?.action ? String(rec.action) : "Clicked";
      case "fill":
        return rec?.action ? String(rec.action) : "Filled input";
      case "press":
        return rec?.action != null ? String(rec.action) : "Pressed key";
      case "scroll":
        return rec?.action != null ? String(rec.action) : "Scrolled";
      case "select_option":
        return rec?.action != null ? String(rec.action) : "Selected option";
      case "check":
        return rec?.action != null ? String(rec.action) : "Checked";
      case "get_text":
        return rec?.text ? `Extracted ${String(rec.text).length} chars` : "Extracted text";
      case "ask_user":
        return typeof output === "string" ? String(output).slice(0, 120) : "Asked user for help";
      default:
        return rec?.success ? "Done" : JSON.stringify(o).slice(0, 120);
    }
  } catch {
    return String(output).slice(0, 120);
  }
}

function ToolPartView({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const label = TOOL_LABELS[toolName] ?? toolName;

  if (part.state === "output-available") {
    return (
      <div className="ab-tool-wrap ab-tool-done">
        <div className="ab-tool-head">
          <span className="ab-tool-label">{label}</span>
          <span className="ab-badge ab-badge-muted">Done</span>
        </div>
        <pre className="ab-tool-pre">{toolOutputSummary(toolName, part.output)}</pre>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="ab-tool-wrap ab-tool-pending">
        <div className="ab-tool-head">
          <HandPointing size={14} weight="fill" className="ab-tool-warn-icon" />
          <span className="ab-muted">
            {toolName === "ask_user"
              ? "Waiting for your response..."
              : TOOL_IN_PROGRESS[toolName] ?? "Working..."}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function BrowserPanel({
  screenshot,
  actions,
  browserStatus,
  statusMessage,
  error,
  liveViewUrl,
}: {
  screenshot: string | null;
  actions: Array<{ action: string; step: number }>;
  browserStatus: BrowserStatus | "idle";
  statusMessage: string;
  error: string | null;
  liveViewUrl: string | null;
}) {
  const actionsEndRef = useRef<HTMLDivElement>(null);
  const [showActions, setShowActions] = useState(true);
  const [liveViewOpen, setLiveViewOpen] = useState(false);

  useEffect(() => {
    actionsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [actions]);

  // Auto-close Live View when the session ends (no URL means browser stopped)
  useEffect(() => {
    if (!liveViewUrl) setLiveViewOpen(false);
  }, [liveViewUrl]);

  const isActive = browserStatus !== "idle" && browserStatus !== "done";

  return (
    <div className="ab-browser-panel">
      <div className="ab-browser-header">
        <div className="ab-browser-title-row">
          <Globe size={18} className="ab-accent" />
          <span className="ab-browser-title">Browser View</span>
          <span className="ab-badge ab-badge-muted">{browserStatus === "idle" ? "Idle" : browserStatus}</span>
        </div>
        <div className="ab-browser-actions">
          {liveViewUrl && (
            <>
              <button
                type="button"
                className={`ab-icon-btn ${liveViewOpen ? "ab-icon-btn-active" : ""}`}
                onClick={() => setLiveViewOpen((v) => !v)}
                title={liveViewOpen ? "Switch to screencast" : "Switch to Live View — interactive DevTools session in-panel (Chrome). Use to help the agent with CAPTCHAs or blocked pages."}
              >
                <Desktop size={14} />
              </button>
              <button
                type="button"
                className="ab-icon-btn"
                onClick={() => window.open(liveViewUrl, "_blank", "noopener,noreferrer")}
                title="Open Live View in a new Chrome tab — best for CAPTCHA / interaction (no iframe sandbox limits)."
              >
                <ArrowSquareOut size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            className="ab-icon-btn"
            onClick={() => setShowActions(!showActions)}
            title={showActions ? "Hide action log" : "Show action log"}
          >
            {showActions ? <ImageIcon size={14} /> : <List size={14} />}
          </button>
        </div>
      </div>

      {statusMessage && isActive && (
        <div className="ab-status-bar">
          <ArrowClockwise size={12} className="ab-spin" />
          <span className="ab-muted">{statusMessage}</span>
        </div>
      )}

      {error && (
        <div className="ab-error-bar">
          <WarningCircle size={12} />
          <span className="ab-error-text">{error}</span>
        </div>
      )}

      <div className="ab-browser-body">
        <div className="ab-browser-viewport">
          {liveViewOpen && liveViewUrl ? (
            <iframe
              key={liveViewUrl}
              src={liveViewUrl}
              className="ab-live-iframe"
              title="Browser Live View"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-pointer-lock"
            />
          ) : (
            <div className="ab-screencast">
              {screenshot ? (
                <img
                  src={`data:image/jpeg;base64,${screenshot}`}
                  alt="Browser screencast"
                  className="ab-screenshot"
                />
              ) : (
                <div className="ab-empty-browser">
                  <Globe size={48} className="ab-empty-icon" />
                  <p className="ab-muted">No browser activity yet</p>
                  <p className="ab-muted ab-small">Ask the agent to browse and the view appears here.</p>
                </div>
              )}
            </div>
          )}
        </div>
        {showActions && actions.length > 0 && (
          <div className="ab-action-log ab-action-log-dock">
            <div className="ab-action-log-head">Action Log ({actions.length} steps)</div>
            <div className="ab-action-log-body">
              {actions.map((a) => (
                <div key={`${a.step}-${a.action.slice(0, 40)}`} className="ab-action-row">
                  <CheckCircle size={12} weight="fill" className="ab-action-check" />
                  <span className="ab-action-text">
                    <span className="ab-action-step">{a.step}.</span> {a.action}
                  </span>
                </div>
              ))}
              <div ref={actionsEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationToggle() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("edgeclaw.browsing.notifications") === "enabled");
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );

  const toggle = useCallback(async () => {
    if (!enabled && permission !== "granted") {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
    }
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem("edgeclaw.browsing.notifications", next ? "enabled" : "disabled");
  }, [enabled, permission]);

  return (
    <button
      type="button"
      className={`ab-icon-btn ${enabled && permission === "granted" ? "ab-icon-btn-active" : ""}`}
      onClick={toggle}
      title={enabled && permission === "granted" ? "Notifications on" : "Notifications off"}
    >
      {enabled && permission === "granted" ? <Bell size={16} weight="fill" /> : <BellSlash size={16} />}
    </button>
  );
}

function UserActionBanner({
  message,
  onContinue,
  onDismiss,
}: {
  message: string;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="ab-hitl-banner">
      <HandPointing size={20} weight="fill" className="ab-hitl-icon" />
      <div className="ab-hitl-body">
        <div className="ab-hitl-title">Action needed in browser</div>
        <p className="ab-muted">{message}</p>
        <div className="ab-hitl-actions">
          <button type="button" className="ab-btn ab-btn-primary" onClick={onContinue}>
            I&apos;ve taken action, continue
          </button>
          <button type="button" className="ab-btn ab-btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function useBrowsingAgentSocketOptions(
  browsingSessionId: string,
  browsingInferenceBackend: BrowsingInferenceBackend
) {
  return useMemo(() => {
    const query: Record<string, string> = {
      browsingInferenceBackend,
    };
    const fromEnv = import.meta.env.VITE_BROWSING_AGENT_WS_URL as string | undefined;
    if (fromEnv) {
      const wsUrl = fromEnv.replace(/\/[^/]+$/, `/${browsingSessionId}`);
      const httpish = wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
      const u = new URL(httpish);
      return {
        host: u.host,
        protocol: (wsUrl.startsWith("wss") ? "wss" : "ws") as "ws" | "wss",
        agent: "EdgeclawBrowsingAgent",
        name: browsingSessionId,
        query,
      };
    }
    const protocol = window.location.protocol === "https:" ? ("wss" as const) : ("ws" as const);
    const host =
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "127.0.0.1:8788"
        : window.location.host;
    return { host, protocol, agent: "EdgeclawBrowsingAgent", name: browsingSessionId, query };
  }, [browsingSessionId, browsingInferenceBackend]);
}

class BrowsingErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AgentBrowsing]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="page-shell ab-page">
          <div className="ab-error-fallback">
            <WarningCircle size={48} />
            <h2>Something went wrong</h2>
            <p className="ab-muted">{this.state.error.message}</p>
            <button type="button" className="ab-btn ab-btn-secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

type SyncBrowserUiPayload = {
  liveViewUrl: string | null;
  actions: Array<{ action: string; step: number }>;
  hasActivePage: boolean;
  inferenceBackend?: BrowsingInferenceBackend;
};

function AgentBrowsingInner({
  browsingSessionId,
  browsingInferenceBackend,
}: {
  browsingSessionId: string;
  browsingInferenceBackend: BrowsingInferenceBackend;
}) {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [browserScreenshot, setBrowserScreenshot] = useState<string | null>(null);
  const [browserActions, setBrowserActions] = useState<Array<{ action: string; step: number }>>([]);
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus | "idle">("idle");
  const [browserStatusMessage, setBrowserStatusMessage] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [userActionNeeded, setUserActionNeeded] = useState<{ message: string; toolCallId: string } | null>(null);
  const clearedRef = useRef(false);
  const [activeInferenceBackend, setActiveInferenceBackend] =
    useState<BrowsingInferenceBackend>(browsingInferenceBackend);

  useEffect(() => {
    setActiveInferenceBackend(browsingInferenceBackend);
  }, [browsingInferenceBackend]);

  const socketOpts = useBrowsingAgentSocketOptions(browsingSessionId, browsingInferenceBackend);

  const agent = useAgent({
    ...socketOpts,
    queryDeps: [browsingInferenceBackend],
    onOpen: useCallback(() => {
      setConnected(true);
    }, []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback((e: Event) => console.error("[AgentBrowsing] WebSocket error:", e), []),
    onMessage: useCallback((message: MessageEvent) => {
      try {
        const raw: unknown = JSON.parse(String(message.data));
        if (!isBrowserEvent(raw)) return;

        if (raw.type === "browser-screenshot") {
          if (clearedRef.current) return;
          if (isValidBase64(raw.data)) setBrowserScreenshot(raw.data);
        } else if (raw.type === "browser-action") {
          setBrowserActions((prev) => [...prev, { action: raw.action, step: raw.step }]);
        } else if (raw.type === "browser-status") {
          setBrowserStatus(raw.status);
          if (raw.message) setBrowserStatusMessage(raw.message);
          if (raw.status === "starting") {
            clearedRef.current = false;
            setBrowserActions([]);
            setBrowserScreenshot(null);
            setBrowserError(null);
            setLiveViewUrl(null);
            setUserActionNeeded(null);
          }
        } else if (raw.type === "browser-error") {
          setBrowserError(raw.error);
        } else if (raw.type === "browser-liveview-url") {
          setLiveViewUrl(raw.url);
        }
      } catch {
        /* ignore */
      }
    }, []),
  });

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void (async () => {
      try {
        await agent.ready;
        await agent.call("setBrowsingInferenceBackend", [browsingInferenceBackend]);
        const sync = (await agent.call("syncBrowserUiState")) as SyncBrowserUiPayload | null;
        if (cancelled || !sync) return;
        if (Array.isArray(sync.actions) && sync.actions.length > 0) {
          setBrowserActions(sync.actions);
        }
        if (typeof sync.liveViewUrl === "string" && sync.liveViewUrl) {
          setLiveViewUrl(sync.liveViewUrl);
        }
        if (sync.inferenceBackend === "ai-gateway" || sync.inferenceBackend === "workers-ai") {
          setActiveInferenceBackend(sync.inferenceBackend);
        }
      } catch (e) {
        console.error("[AgentBrowsing] sync / inference backend failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, browsingSessionId, browsingInferenceBackend, agent]);

  const { messages, sendMessage, clearHistory, stop, status, addToolOutput, isStreaming } = useAgentChat({
    agent,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName === "ask_user") {
        const inputObj = toolCall.input as { message: string };
        setUserActionNeeded({
          message: inputObj.message,
          toolCallId: toolCall.toolCallId,
        });
        const notificationsEnabled = localStorage.getItem("edgeclaw.browsing.notifications") === "enabled";
        if (notificationsEnabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const notification = new Notification("Agent needs your help", { body: inputObj.message });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }
      }
    },
  });

  const busy = isStreaming || status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!busy && textareaRef.current) textareaRef.current.focus();
  }, [busy]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, busy, sendMessage]);

  const handleClear = useCallback(async () => {
    clearedRef.current = true;
    if (userActionNeeded) {
      addToolOutput({
        toolCallId: userActionNeeded.toolCallId,
        state: "output-error",
        errorText: "User cleared the conversation.",
      });
    }
    clearHistory();
    setBrowserScreenshot(null);
    setBrowserActions([]);
    setBrowserStatus("idle");
    setBrowserStatusMessage("");
    setBrowserError(null);
    setLiveViewUrl(null);
    setUserActionNeeded(null);
    try {
      await agent.call("closeBrowserSession");
    } catch {
      /* best-effort */
    }
  }, [clearHistory, agent, userActionNeeded, addToolOutput]);

  const handleContinue = useCallback(() => {
    if (!userActionNeeded) return;
    const toolCallId = userActionNeeded.toolCallId;
    setUserActionNeeded(null);
    addToolOutput({
      toolCallId,
      output: "User has taken action. Please take a page_snapshot and continue.",
    });
  }, [userActionNeeded, addToolOutput]);

  const handleDismiss = useCallback(() => {
    if (!userActionNeeded) return;
    const toolCallId = userActionNeeded.toolCallId;
    setUserActionNeeded(null);
    addToolOutput({
      toolCallId,
      state: "output-error",
      errorText: "User dismissed the request.",
    });
  }, [userActionNeeded, addToolOutput]);

  return (
    <section className="page-shell ab-page">
      <header className="ab-page-header">
        <div className="ab-page-header-left">
          <Globe size={22} weight="bold" />
          <h2 className="page-header">Agent Browsing</h2>
          <span className="ab-badge ab-badge-muted">
            {activeInferenceBackend === "ai-gateway" ? "AI Gateway" : "Workers AI"}
          </span>
        </div>
        <div className="ab-page-header-right">
          <span className="ab-conn">
            <Circle size={8} weight="fill" className={connected ? "ab-dot-on" : "ab-dot-off"} />
            <span className="ab-muted">{connected ? "Connected" : "Disconnected"}</span>
          </span>
          <NotificationToggle />
          <button type="button" className="ab-btn ab-btn-secondary" onClick={handleClear}>
            <Trash size={16} /> Clear
          </button>
        </div>
      </header>

      <div className="ab-split">
        <div className="ab-chat-col">
          <div className="ab-messages">
            {messages.length === 0 && (
              <div className="ab-empty-chat">
                <p className="ab-muted">What should I browse?</p>
                <div className="ab-suggestions">
                  {[
                    "Search for news on Hacker News",
                    "Look up the weather in Seattle",
                    "Find top stories on a major news site",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="ab-chip"
                      disabled={busy}
                      onClick={() => sendMessage({ role: "user", parts: [{ type: "text", text: prompt }] })}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message: UIMessage, index: number) => {
              const isUser = message.role === "user";
              const isLastAssistant = message.role === "assistant" && index === messages.length - 1;
              return (
                <div key={message.id} className="ab-msg-block">
                  {message.parts.filter(isToolUIPart).map((part) => (
                    <ToolPartView key={getToolCallId(part)} part={part} />
                  ))}
                  {message.parts
                    .filter((part) => part.type === "text")
                    .map((part, i) => {
                      const text = (part as { type: "text"; text: string }).text;
                      if (!text) return null;
                      if (isUser) {
                        return (
                          <div key={i} className="ab-user-bubble-wrap">
                            <div className="ab-user-bubble">{text}</div>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="ab-asst-bubble-wrap">
                          <div className="ab-asst-bubble">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                          </div>
                          {isLastAssistant && busy && <span className="ab-typing">…</span>}
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="ab-composer-wrap">
            {userActionNeeded && (
              <UserActionBanner
                message={userActionNeeded.message}
                onContinue={handleContinue}
                onDismiss={handleDismiss}
              />
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <div className="composer-input-wrap">
                <textarea
                  ref={textareaRef}
                  className="composer-textarea"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  placeholder="Tell me what to browse…"
                  disabled={!connected || busy}
                  rows={1}
                  aria-label="Message to browsing agent"
                />
                {busy ? (
                  <button
                    type="button"
                    className="composer-stop-btn"
                    onClick={stop}
                    aria-label="Stop"
                    title="Stop"
                  >
                    <Stop size={18} weight="bold" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="composer-send-btn"
                    disabled={!input.trim() || !connected}
                    aria-label="Send message"
                    title="Send"
                  >
                    <PaperPlaneRight size={18} weight="bold" />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        <div className="ab-browser-col">
          <BrowserPanel
            screenshot={browserScreenshot}
            actions={browserActions}
            browserStatus={browserStatus}
            statusMessage={browserStatusMessage}
            error={browserError}
            liveViewUrl={liveViewUrl}
          />
        </div>
      </div>
    </section>
  );
}

export interface AgentBrowsingPageProps {
  /** DO instance name (default `default`). */
  browsingSessionId?: string;
  /** From Settings — synced to EdgeclawBrowsingAgent on connect. */
  browsingInferenceBackend?: BrowsingInferenceBackend;
}

export function AgentBrowsingPage({
  browsingSessionId = "default",
  browsingInferenceBackend = "workers-ai",
}: AgentBrowsingPageProps) {
  return (
    <BrowsingErrorBoundary>
      <AgentBrowsingInner
        browsingSessionId={browsingSessionId}
        browsingInferenceBackend={browsingInferenceBackend}
      />
    </BrowsingErrorBoundary>
  );
}
