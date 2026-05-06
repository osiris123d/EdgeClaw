import { useEffect, useMemo, useState } from "react";
import { DEFAULT_AURA_TTS_SPEAKER } from "./lib/auraTts";
import { isEdgeclawTtsDebugEnabled } from "./lib/ttsDebug";
import type { FeatureSettings, NavItem } from "./types";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { TasksPage }     from "./pages/TasksPage";
import { SkillsPage }    from "./pages/SkillsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { SubAgentsPage } from "./pages/SubAgentsPage";
import { AgentBrowsingPage } from "./pages/AgentBrowsingPage";

const NAV_ITEMS: NavItem[] = [
  "Chat",
  "Sub-Agents",
  "Agent Browsing",
  "Memory",
  "Workflows",
  "Tasks",
  "Skills",
  "Channels",
  "Settings",
];

const DEFAULT_SETTINGS: FeatureSettings = {
  enableBrowserTools: false,
  enableCodeExecution: false,
  enableMcp: false,
  enableVoice: false,
  observabilityLevel: "info",
  voiceMode: "disabled",
  ttsSpeaker: DEFAULT_AURA_TTS_SPEAKER,
  browserStepExecutor: "cdp",
  browsingInferenceBackend: "workers-ai",
  /** Deepgram Flux defaults — see Settings → Voice. */
  voiceFluxEotThreshold: 0.7,
  voiceFluxEotTimeoutMs: 5000,
  voiceFluxEagerEotThreshold: undefined,
};

const SETTINGS_STORAGE_KEY = "cf-truth-settings";

/**
 * Load persisted settings from localStorage, merging with DEFAULT_SETTINGS so
 * any keys added after the initial save always have a defined value.
 */
function loadPersistedSettings(): FeatureSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<FeatureSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="page-shell">
      <header className="page-header">
        <h2>{title}</h2>
      </header>
      <p className="muted">This panel is scaffolded and ready for project-specific data wiring.</p>
    </section>
  );
}

function getDefaultEndpoint(): string {
  const fromEnv = import.meta.env.VITE_AGENT_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  const authority = isLocalHost ? "127.0.0.1:8788" : window.location.host;
  return `${protocol}//${authority}/agents/main-agent/default`;
}

function buildEndpoint(sessionId: string): string {
  const base = getDefaultEndpoint();
  // Replace the last path segment (session name) with the given sessionId.
  return base.replace(/\/[^\/]+$/, `/${sessionId}`);
}

export default function App() {
  const [activeNav, setActiveNav] = useState<NavItem>("Chat");
  // Initialize from localStorage so toggles like "Enable MCP" survive page reloads.
  const [settings, setSettings] = useState<FeatureSettings>(loadPersistedSettings);
  const [sessionId, setSessionId] = useState<string>("default");

  const handleSettingsChange = (next: FeatureSettings) => {
    setSettings(next);
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next)); } catch { /* quota or private-mode */ }
  };

  // Push the chosen @cf/deepgram/aura-1 speaker to the Durable Object for this session
  // whenever it changes — even when "Enable voice" is off — so voice `onTurn` (which does not
  // send real browser `settings` on saveMessages) and typed chat never race a cold DO default
  // against the user's Settings choice.
  useEffect(() => {
    if (!settings.ttsSpeaker) return;

    const url = `/api/voice/tts-speaker?session=${encodeURIComponent(sessionId)}`;
    const body = { speaker: settings.ttsSpeaker };
    if (isEdgeclawTtsDebugEnabled()) {
      console.info("[EdgeClaw][tts-debug] HTTP tts-speaker POST", { url, body, sessionId });
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? (JSON.parse(text) as unknown) : null;
        } catch {
          /* not JSON */
        }
        if (isEdgeclawTtsDebugEnabled()) {
          if (!res.ok) {
            console.warn(
              "[EdgeClaw][tts-debug] HTTP tts-speaker failed",
              { status: res.status, body: parsed }
            );
          } else {
            console.info("[EdgeClaw][tts-debug] HTTP tts-speaker ok", { status: res.status, body: parsed });
          }
        }
      })
      .catch((err) => {
        if (isEdgeclawTtsDebugEnabled()) {
          console.warn("[EdgeClaw][tts-debug] HTTP tts-speaker network error", err);
        }
      });
  }, [sessionId, settings.ttsSpeaker]);

  // Keep Flux STT end-of-turn preferences on the DO (matches chat `settings` on send).
  useEffect(() => {
    if (!settings.enableVoice) return;
    void fetch(
      `/api/voice/flux-stt?session=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eotThreshold: settings.voiceFluxEotThreshold,
          eotTimeoutMs: settings.voiceFluxEotTimeoutMs,
          eagerEotThreshold: settings.voiceFluxEagerEotThreshold ?? null,
        }),
      }
    ).catch(() => { /* offline */ });
  }, [
    sessionId,
    settings.enableVoice,
    settings.voiceFluxEotThreshold,
    settings.voiceFluxEotTimeoutMs,
    settings.voiceFluxEagerEotThreshold,
  ]);

  const endpoint = useMemo(() => buildEndpoint(sessionId), [sessionId]);

  const startNewChat = () => {
    setSessionId(crypto.randomUUID());
    setActiveNav("Chat");
  };

  return (
    <main className="app-layout">
      <aside className="left-nav">
        <h1>EdgeClaw</h1>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item}
              className={item === activeNav ? "nav-item active" : "nav-item"}
              onClick={() => setActiveNav(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <section className="content-area">
        {activeNav === "Chat" && (
          <ChatPage
            endpoint={endpoint}
            onNewChat={startNewChat}
            settings={settings}
            onOpenMcpSettings={() => setActiveNav("Settings")}
          />
        )}
        {activeNav === "Sub-Agents" && (
          <SubAgentsPage wsEndpoint={endpoint} sessionId={sessionId} />
        )}
        {activeNav === "Agent Browsing" && (
          <AgentBrowsingPage
            browsingSessionId={sessionId}
            browsingInferenceBackend={settings.browsingInferenceBackend}
          />
        )}
        {activeNav === "Settings" && (
          <SettingsPage settings={settings} onChange={handleSettingsChange} sessionId={sessionId} />
        )}
        {activeNav === "Memory" && <MemoryPage endpoint={endpoint} />}
        {activeNav === "Tasks" && <TasksPage />}
        {activeNav === "Workflows" && <WorkflowsPage />}
        {/* loadedKeys: derive from chat timeline context events once session state
             is lifted to App level.  See lib/loadedSkillKeys.ts for the helper
             and SkillsPage.tsx for the wiring guide in its loadedKeys prop JSDoc.
             onLoadIntoSession / onUnloadFromSession: wire once backend @callable()
             methods exist on MainAgent — see TODO near loadSkillIntoSession in
             MainAgent.ts.  Until then both are undefined and the session action
             buttons remain hidden in the SkillDrawer preview pane. */}
        {activeNav === "Skills" && <SkillsPage loadedKeys={new Set<string>()} />}
        {activeNav === "Channels" && <PlaceholderPage title="Channels" />}
      </section>
    </main>
  );
}
