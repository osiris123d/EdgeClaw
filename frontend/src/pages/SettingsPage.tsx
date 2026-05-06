import { useCallback, useEffect, useRef, useState } from "react";
import { AURA_TTS_SPEAKERS } from "../lib/auraTts";
import type { FeatureSettings } from "../types";
import type {
  McpDiscoverySnapshot,
  DiscoveredMcpServer,
  DiscoveredMcpTool,
  DiscoveredMcpPrompt,
  DiscoveredMcpResource,
  McpTransport,
  McpServerLifecycleState,
  McpServerCapabilities,
} from "../types/mcp";
import {
  MCP_STATE_LABELS,
  MCP_LIVE_STATES,
  MCP_TRANSPORT_LABELS,
  MCP_TRANSPORT_ADVISORY,
} from "../types/mcp";
import {
  getMcpState,
  addMcpServer,
  removeMcpServer,
  reconnectMcpServer,
  updateMcpServer,
} from "../lib/mcpApi";
import { openOAuthPopup, type OAuthPopupAbort } from "../lib/mcpOAuth";

interface SettingsPageProps {
  settings: FeatureSettings;
  onChange: (next: FeatureSettings) => void;
  /** Chat / agent session id — routes TTS preview to the same Durable Object as the WebSocket. */
  sessionId: string;
}

// ── Debug log ─────────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

const MAX_LOG_ENTRIES = 300;

function fmtLogTs(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRANSITIONAL_STATES: McpServerLifecycleState[] = [
  "connecting",
  "initializing",
  "discovering",
];

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function validateMcpUrl(raw: string): string | null {
  if (!raw.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return "Enter a valid URL (e.g. https://mcp.example.com/mcp).";
  }
  if (parsed.protocol !== "https:") {
    return "Must use https:// — plain http:// is not allowed.";
  }
  return null;
}

// ── State badge ───────────────────────────────────────────────────────────────

function McpStateBadge({ state }: { state: McpServerLifecycleState }) {
  return (
    <span className={`mcp-state-badge mcp-state-${state}`}>
      {TRANSITIONAL_STATES.includes(state) && (
        <span className="mcp-pulse-dot" aria-hidden="true" />
      )}
      {MCP_STATE_LABELS[state] ?? state}
    </span>
  );
}

// ── Transport badge ───────────────────────────────────────────────────────────

function TransportBadge({ transport }: { transport: McpTransport }) {
  // "streamable-http" is the expected common case — suppress to reduce noise.
  if (transport === "streamable-http") return null;
  const label = MCP_TRANSPORT_LABELS[transport] ?? transport;
  const isLegacy = transport === "sse";
  return (
    <span
      className={`mcp-transport-badge${isLegacy ? " mcp-transport-badge-legacy" : ""}`}
      title={isLegacy ? "Legacy SSE transport — deprecated by the MCP spec" : ""}
    >
      {label}
    </span>
  );
}

// ── Capability chips ──────────────────────────────────────────────────────────

function CapabilityChips({ caps }: { caps: McpServerCapabilities }) {
  const items = [
    caps.supportsTools && "tools",
    caps.supportsPrompts && "prompts",
    caps.supportsResources && "resources",
    caps.supportsLogging && "logging",
  ].filter(Boolean) as string[];
  if (items.length === 0) return null;
  return (
    <div className="mcp-cap-chips">
      {items.map((c) => <span key={c} className="mcp-cap-chip">{c}</span>)}
    </div>
  );
}

// ── Tool / Prompt / Resource rows ─────────────────────────────────────────────

function ToolRow({ tool }: { tool: DiscoveredMcpTool }) {
  const [open, setOpen] = useState(false);
  const props =
    tool.inputSchema !== null && typeof tool.inputSchema?.properties === "object"
      ? Object.entries(tool.inputSchema.properties as Record<string, { description?: string }>)
      : [];
  return (
    <div className="mcp-item-row">
      <div
        className="mcp-item-header"
        onClick={() => props.length > 0 && setOpen((v) => !v)}
        role={props.length > 0 ? "button" : undefined}
        tabIndex={props.length > 0 ? 0 : undefined}
        onKeyDown={(e) => e.key === "Enter" && props.length > 0 && setOpen((v) => !v)}
      >
        <span className="mcp-item-name">{tool.name}</span>
        {tool.annotations?.readOnlyHint === true && (
          <span className="mcp-item-badge mcp-badge-read-only">read-only</span>
        )}
        {props.length > 0 && <span className="mcp-item-expand">{open ? "▾" : "▸"}</span>}
      </div>
      {tool.description && <div className="mcp-item-desc">{tool.description}</div>}
      {open && props.length > 0 && (
        <div className="mcp-schema-props">
          {props.map(([p, m]) => (
            <span key={p} className="mcp-schema-prop" title={(m as { description?: string })?.description}>{p}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptRow({ prompt }: { prompt: DiscoveredMcpPrompt }) {
  const [open, setOpen] = useState(false);
  const hasArgs = prompt.args.length > 0;
  return (
    <div className="mcp-item-row">
      <div
        className="mcp-item-header"
        onClick={() => hasArgs && setOpen((v) => !v)}
        role={hasArgs ? "button" : undefined}
        tabIndex={hasArgs ? 0 : undefined}
        onKeyDown={(e) => e.key === "Enter" && hasArgs && setOpen((v) => !v)}
      >
        <span className="mcp-item-name">{prompt.name}</span>
        {hasArgs && <span className="mcp-item-badge">{prompt.args.length} arg{prompt.args.length !== 1 ? "s" : ""}</span>}
        {hasArgs && <span className="mcp-item-expand">{open ? "▾" : "▸"}</span>}
      </div>
      {prompt.description && <div className="mcp-item-desc">{prompt.description}</div>}
      {open && hasArgs && (
        <div className="mcp-schema-props">
          {prompt.args.map((a) => (
            <span key={a.name} className="mcp-schema-prop">
              {a.name}{a.required ? <sup title="required">*</sup> : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceRow({ resource }: { resource: DiscoveredMcpResource }) {
  return (
    <div className="mcp-item-row">
      <div className="mcp-item-header">
        <span className="mcp-item-name">{resource.name}</span>
        {resource.mimeType && <span className="mcp-item-badge mcp-badge-mime">{resource.mimeType}</span>}
        {resource.uriTemplate && <span className="mcp-item-badge mcp-badge-template">template</span>}
      </div>
      {resource.description && <div className="mcp-item-desc">{resource.description}</div>}
      {resource.uri && <div className="mcp-item-uri muted">{resource.uri}</div>}
    </div>
  );
}

// ── Discovery panel ───────────────────────────────────────────────────────────

function DiscoveryPanel({ server, snapshot }: { server: DiscoveredMcpServer; snapshot: McpDiscoverySnapshot }) {
  const tools = snapshot.tools.filter((t) => t.serverId === server.sdkServerId);
  const prompts = snapshot.prompts.filter((p) => p.serverId === server.sdkServerId);
  const resources = snapshot.resources.filter((r) => r.serverId === server.sdkServerId);
  const hasAny = tools.length > 0 || prompts.length > 0 || resources.length > 0;

  const defTab = tools.length > 0 ? "tools" : prompts.length > 0 ? "prompts" : "resources";
  const [tab, setTab] = useState<"tools" | "prompts" | "resources">(defTab);

  if (!hasAny) {
    return (
      <p className="muted mcp-discovery-empty">
        {server.state === "degraded"
          ? "Server connected but returned no tools, prompts, or resources."
          : "Nothing discovered yet — server may still be connecting."}
      </p>
    );
  }
  return (
    <div className="mcp-discovery-panel">
      <div className="mcp-discovery-tabs">
        {tools.length > 0 && (
          <button className={`mcp-discovery-tab${tab === "tools" ? " active" : ""}`} onClick={() => setTab("tools")}>
            Tools ({tools.length})
          </button>
        )}
        {prompts.length > 0 && (
          <button className={`mcp-discovery-tab${tab === "prompts" ? " active" : ""}`} onClick={() => setTab("prompts")}>
            Prompts ({prompts.length})
          </button>
        )}
        {resources.length > 0 && (
          <button className={`mcp-discovery-tab${tab === "resources" ? " active" : ""}`} onClick={() => setTab("resources")}>
            Resources ({resources.length})
          </button>
        )}
      </div>
      <div className="mcp-discovery-list">
        {tab === "tools" && tools.map((t) => <ToolRow key={t.name} tool={t} />)}
        {tab === "prompts" && prompts.map((p) => <PromptRow key={p.name} prompt={p} />)}
        {tab === "resources" && resources.map((r) => <ResourceRow key={r.name} resource={r} />)}
      </div>
    </div>
  );
}

// ── Inspect panel ─────────────────────────────────────────────────────────────
//
// Unified per-server inspection surface for developers and power users.
// Consolidates connection status, capabilities, instructions, discovered items,
// error details, and a raw-JSON view into one collapsible panel.
//
// Security: The frontend DiscoveredMcpServer object never contains auth headers
// or tokens — they are stripped server-side before the snapshot is built.
// The raw JSON section therefore contains no secrets.

interface McpInspectPanelProps {
  server: DiscoveredMcpServer;
  snapshot: McpDiscoverySnapshot;
}

function McpInspectPanel({ server, snapshot }: McpInspectPanelProps) {
  const tools     = snapshot.tools.filter((t) => t.serverId === server.sdkServerId);
  const prompts   = snapshot.prompts.filter((p) => p.serverId === server.sdkServerId);
  const resources = snapshot.resources.filter((r) => r.serverId === server.sdkServerId);
  const hasDiscovery = tools.length > 0 || prompts.length > 0 || resources.length > 0;

  // Raw JSON: drop rawCapabilities (large, already shown in Capabilities section).
  // No tokens or auth headers ever reach the frontend — nothing to redact here.
  const rawDisplay = {
    ...server,
    _debug: {
      rawSdkState:  server._debug.rawSdkState,
      rawServerUrl: server._debug.rawServerUrl,
      // rawCapabilities intentionally omitted — shown above in structured form
    },
  };

  return (
    <div className="mcp-inspect-panel">

      {/* ── Connection status ── */}
      <div className="mcp-inspect-section">
        <h4 className="mcp-inspect-heading">Connection</h4>
        <dl className="mcp-inspect-dl">
          <dt>Status</dt>
          <dd><McpStateBadge state={server.state} /></dd>
          <dt>Transport</dt>
          <dd className="mcp-inspect-mono">{server.transport}</dd>
          {server.sdkServerId && <>
            <dt>SDK ID</dt>
            <dd className="mcp-inspect-mono">{server.sdkServerId}</dd>
          </>}
          <dt>Last refreshed</dt>
          <dd>{fmtTs(snapshot.snapshotAt)}</dd>
          <dt>Connected at</dt>
          <dd>{fmtTs(server.connectedAt)}</dd>
          <dt>Discovered at</dt>
          <dd>{fmtTs(server.discoveredAt)}</dd>
          <dt>Created</dt>
          <dd>{fmtTs(server.createdAt)}</dd>
          <dt>Config updated</dt>
          <dd>{fmtTs(server.updatedAt)}</dd>
          <dt>Server ID</dt>
          <dd className="mcp-inspect-mono muted">{server.id}</dd>
        </dl>
      </div>

      {/* ── Last error ── */}
      {server.error && (
        <div className="mcp-inspect-section">
          <h4 className="mcp-inspect-heading mcp-inspect-heading-error">Last error</h4>
          <div className="mcp-inspect-error-msg">{server.error}</div>
          {server.firstErrorAt && (
            <div className="mcp-inspect-error-ts muted">
              First seen: {fmtTs(server.firstErrorAt)}
            </div>
          )}
        </div>
      )}

      {/* ── Capabilities ── */}
      {server.capabilities && (
        <div className="mcp-inspect-section">
          <h4 className="mcp-inspect-heading">Capabilities</h4>
          <div className="mcp-inspect-caps">
            {(
              [
                ["Tools",     server.capabilities.supportsTools,
                  server.capabilities.toolsListChanged ? ["list-changed"] : []],
                ["Prompts",   server.capabilities.supportsPrompts,
                  server.capabilities.promptsListChanged ? ["list-changed"] : []],
                ["Resources", server.capabilities.supportsResources,
                  [
                    server.capabilities.resourcesSubscribe && "subscribe",
                    server.capabilities.resourcesListChanged && "list-changed",
                  ].filter(Boolean) as string[]],
                ["Logging",   server.capabilities.supportsLogging, []],
              ] as [string, boolean, string[]][]
            ).map(([label, supported, flags]) => (
              <div
                key={label}
                className={`mcp-inspect-cap-row${supported ? " mcp-cap-yes" : " mcp-cap-no"}`}
              >
                <span className="mcp-inspect-cap-icon" aria-hidden="true">
                  {supported ? "✓" : "✗"}
                </span>
                <span className="mcp-inspect-cap-name">{label}</span>
                {flags.map((f) => (
                  <span key={f} className="mcp-inspect-cap-flag">{f}</span>
                ))}
              </div>
            ))}
          </div>
          {Object.keys(server.capabilities.experimental).length > 0 && (
            <div className="mcp-inspect-experimental muted">
              Experimental: {Object.keys(server.capabilities.experimental).join(", ")}
            </div>
          )}
        </div>
      )}

      {/* ── Instructions ── */}
      {server.instructions && (
        <div className="mcp-inspect-section">
          <h4 className="mcp-inspect-heading">Instructions from server</h4>
          <pre className="mcp-inspect-instructions">{server.instructions}</pre>
        </div>
      )}

      {/* ── Discovery: tools / prompts / resources ── */}
      {hasDiscovery ? (
        <div className="mcp-inspect-section">
          <h4 className="mcp-inspect-heading">
            Discovered items
            <span className="mcp-inspect-heading-meta muted">
              {[
                tools.length > 0     && `${tools.length} tool${tools.length !== 1 ? "s" : ""}`,
                prompts.length > 0   && `${prompts.length} prompt${prompts.length !== 1 ? "s" : ""}`,
                resources.length > 0 && `${resources.length} resource${resources.length !== 1 ? "s" : ""}`,
              ].filter(Boolean).join(" · ")}
            </span>
          </h4>
          <DiscoveryPanel server={server} snapshot={snapshot} />
        </div>
      ) : server.enabled && (
        <div className="mcp-inspect-section">
          <h4 className="mcp-inspect-heading">Discovered items</h4>
          <p className="mcp-inspect-empty muted">
            {server.state === "disconnected"
              ? "Server is disabled — enable it to discover items."
              : server.state === "authenticating"
              ? "Awaiting authorization — items will appear after the OAuth flow completes."
              : ["connecting", "initializing", "discovering"].includes(server.state)
              ? "Discovery in progress…"
              : "No tools, prompts, or resources discovered from this server."}
          </p>
        </div>
      )}

      {/* ── Raw normalized JSON ── */}
      <details className="mcp-inspect-raw">
        <summary className="mcp-inspect-raw-summary">
          Raw normalized JSON
          <span className="mcp-inspect-raw-note muted">
            auth headers and tokens are server-side only — not present here
          </span>
        </summary>
        <div className="mcp-inspect-raw-body">
          <pre>{JSON.stringify(rawDisplay, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}

// ── Server card ───────────────────────────────────────────────────────────────

interface ServerCardProps {
  server: DiscoveredMcpServer;
  snapshot: McpDiscoverySnapshot;
  onRemove: (name: string) => Promise<void>;
  onReconnect: (name: string) => Promise<void>;
  onToggleEnabled: (name: string, enabled: boolean) => Promise<void>;
  onOpenAuth: (name: string, authUrl: string) => void;
  authPendingServer: string | null;
  busy: boolean;
  /** True while post-OAuth discovery is in progress for this server. */
  isFinalizingAuth: boolean;
}

function ServerCard({ server, snapshot, onRemove, onReconnect, onToggleEnabled, onOpenAuth, authPendingServer, busy, isFinalizingAuth }: ServerCardProps) {
  const [inspectOpen, setInspectOpen] = useState(false);
  const isLive = MCP_LIVE_STATES.includes(server.state);
  const counts = [
    server.toolCount > 0     && `${server.toolCount} tool${server.toolCount !== 1 ? "s" : ""}`,
    server.promptCount > 0   && `${server.promptCount} prompt${server.promptCount !== 1 ? "s" : ""}`,
    server.resourceCount > 0 && `${server.resourceCount} resource${server.resourceCount !== 1 ? "s" : ""}`,
  ].filter(Boolean) as string[];

  return (
    <div className={`mcp-server-card${isLive ? " mcp-server-card-live" : ""}${!server.enabled ? " mcp-server-card-disabled" : ""}`}>

      {/* ── Header: name + state + capability chips + actions ── */}
      <div className="mcp-server-card-head">
        <div className="mcp-server-identity">
          <span className="mcp-server-name">{server.name}</span>
          <McpStateBadge state={server.state} />
          {server.capabilities && <CapabilityChips caps={server.capabilities} />}
        </div>
        <div className="mcp-server-card-actions">
          <button
            className={`mcp-enabled-toggle${server.enabled ? " mcp-enabled-on" : " mcp-enabled-off"}`}
            onClick={() => onToggleEnabled(server.name, !server.enabled)}
            disabled={busy}
            title={server.enabled ? "Disable server (keeps config)" : "Enable server (reconnect)"}
          >
            {server.enabled ? "Enabled" : "Disabled"}
          </button>
          {server.enabled && (
            <button
              className="btn-header-secondary"
              onClick={() => onReconnect(server.name)}
              disabled={busy}
              title="Disconnect and reconnect"
            >
              Reconnect
            </button>
          )}
          <button
            className="btn-danger"
            onClick={() => onRemove(server.name)}
            disabled={busy}
            title="Remove server permanently"
          >
            Remove
          </button>
        </div>
      </div>

      {/* ── URL + transport ── */}
      <div className="mcp-server-url-row">
        <span className="mcp-server-url">{server.url}</span>
        <TransportBadge transport={server.transport} />
      </div>

      {/* ── OAuth needed ── */}
      {server.state === "authenticating" && server.auth.authUrl && (
        <div className="mcp-server-auth">
          {authPendingServer === server.name ? (
            <span className="mcp-auth-waiting">
              <span className="mcp-auth-spinner" aria-hidden="true" />
              Waiting for authorization…
              <button
                className="mcp-auth-cancel-link"
                onClick={() => onOpenAuth(server.name, server.auth.authUrl!)}
              >
                Reopen popup
              </button>
            </span>
          ) : (
            <button
              className="mcp-auth-link"
              onClick={() => onOpenAuth(server.name, server.auth.authUrl!)}
              disabled={busy}
            >
              {server.auth.providerHint
                ? `Authorize with ${server.auth.providerHint} →`
                : "Authorize →"}
            </button>
          )}
        </div>
      )}

      {/* ── Runtime error ── */}
      {server.error && <div className="mcp-server-error">{server.error}</div>}

      {/* ── Degraded hint ── */}
      {server.state === "degraded" && !server.error && (
        <div className="mcp-server-hint muted">
          Connected — server returned no tools, prompts, or resources.
        </div>
      )}

      {/* ── Finalizing authorization hint ── */}
      {isFinalizingAuth && TRANSITIONAL_STATES.includes(server.state) && (
        <div className="mcp-server-hint mcp-finalizing-hint">
          <span className="mcp-auth-spinner" aria-hidden="true" />
          Finalizing authorization…
        </div>
      )}

      {/* ── Summary row: counts + Inspect toggle ── */}
      <div className="mcp-server-meta-row">
        <span className="mcp-server-counts muted">
          {counts.length > 0
            ? counts.join(" · ")
            : !server.enabled
            ? "Disabled"
            : ["connecting", "initializing", "discovering"].includes(server.state)
            ? "Discovering…"
            : "No items discovered"}
        </span>
        <button
          className={`mcp-inspect-toggle${inspectOpen ? " mcp-inspect-toggle-open" : ""}`}
          onClick={() => setInspectOpen((v) => !v)}
          aria-expanded={inspectOpen}
          title={inspectOpen ? "Close inspection panel" : "Inspect connection, capabilities, and discovered items"}
        >
          {inspectOpen ? "Inspect ▾" : "Inspect ▸"}
        </button>
      </div>

      {/* ── Inspection panel (collapsed by default) ── */}
      {inspectOpen && <McpInspectPanel server={server} snapshot={snapshot} />}
    </div>
  );
}

// ── Add Server bar (Playground-inspired compact form) ─────────────────────────

/** One row of a custom header: key, value (with show/hide), delete. */
interface HeaderRow {
  key: string;
  value: string;
  visible: boolean;
}

interface AddServerBarProps {
  onAdd: (
    name: string,
    url: string,
    transport: McpTransport,
    headers: Record<string, string>
  ) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function AddServerBar({ onAdd, onCancel, saving }: AddServerBarProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<McpTransport>("streamable-http");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const validateUrl = (v: string) => setUrlError(v.length > 8 ? validateMcpUrl(v) : null);
  const handleUrlBlur = () => setUrlError(validateMcpUrl(url));

  const addHeader = () =>
    setHeaders((prev) => [...prev, { key: "", value: "", visible: false }]);

  const addAuthHeader = () => {
    setHeaders((prev) => {
      if (prev.some((h) => h.key.toLowerCase() === "authorization")) return prev;
      return [...prev, { key: "Authorization", value: "Bearer ", visible: false }];
    });
    setShowHeaders(true);
  };

  const updateHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));

  const removeHeader = (i: number) =>
    setHeaders((prev) => prev.filter((_, idx) => idx !== i));

  const buildHeadersMap = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const { key, value } of headers) {
      if (key.trim()) out[key.trim()] = value;
    }
    return out;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateMcpUrl(url);
    if (err) { setUrlError(err); return; }
    if (!name.trim()) return;
    await onAdd(name.trim(), url.trim(), transport, buildHeadersMap());
    setName(""); setUrl(""); setTransport("streamable-http"); setHeaders([]); setUrlError(null);
  };

  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !urlError && !saving;

  const hasHeaderContent = headers.some((h) => h.key.trim() || h.value.trim());

  return (
    <div className="mcp-add-bar">
      <form onSubmit={handleSubmit} noValidate>
        {/* ── Primary row ── */}
        <div className="mcp-add-primary">
          <input
            ref={nameRef}
            className="mcp-input mcp-input-name"
            type="text"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            autoComplete="off"
            title="Short identifier for this server (e.g. github, notion)"
          />
          <div className="mcp-url-wrap">
            <input
              className={`mcp-input mcp-input-url${urlError ? " mcp-input-error" : ""}`}
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(e) => { setUrl(e.target.value); validateUrl(e.target.value); }}
              onBlur={handleUrlBlur}
              disabled={saving}
              autoComplete="off"
            />
            {urlError && <span className="mcp-url-error">{urlError}</span>}
          </div>

          {/* Headers toggle — key icon like the Playground */}
          <button
            type="button"
            className={`mcp-headers-btn${showHeaders || hasHeaderContent ? " mcp-headers-btn-active" : ""}`}
            onClick={() => {
              if (!showHeaders && headers.length === 0) addAuthHeader();
              setShowHeaders((v) => !v);
            }}
            title={showHeaders ? "Hide custom headers" : "Add custom headers (Authorization, CF-Access, etc.)"}
            aria-label="Toggle custom headers"
          >
            {/* Key icon */}
            <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z"/>
            </svg>
            {hasHeaderContent && <span className="mcp-headers-count">{headers.filter((h) => h.key.trim()).length}</span>}
          </button>

          <select
            className="mcp-select mcp-select-compact"
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpTransport)}
            disabled={saving}
            title={
              transport === "streamable-http"
                ? "Streamable HTTP — recommended for all remote servers."
                : transport === "sse"
                ? "Legacy SSE — deprecated by the MCP spec. Use only when the server does not support Streamable HTTP."
                : "Auto-detect — tries Streamable HTTP then falls back to SSE. May produce non-specific errors."
            }
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">Legacy SSE</option>
            <option value="auto">Auto-detect</option>
          </select>

          <button
            className="btn-primary mcp-add-submit"
            type="submit"
            disabled={!canSubmit}
          >
            {saving ? "Connecting…" : "Connect"}
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
        </div>

        {/* ── Transport advisory — shown for non-default selections ── */}
        {MCP_TRANSPORT_ADVISORY[transport] && (
          <div className="mcp-transport-advisory" role="note">
            <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"/>
            </svg>
            {MCP_TRANSPORT_ADVISORY[transport]}
          </div>
        )}

        {/* ── Headers panel (slides in) ── */}
        {showHeaders && (
          <div className="mcp-headers-panel">
            <div className="mcp-headers-panel-label">
              <span>Custom headers</span>
              <span className="mcp-headers-panel-hint muted">Stored server-side — never returned to the browser</span>
            </div>
            {headers.map((h, i) => (
              <div key={i} className="mcp-header-row">
                <input
                  className="mcp-input mcp-header-key"
                  type="text"
                  placeholder="Header name"
                  value={h.key}
                  onChange={(e) => updateHeader(i, { key: e.target.value })}
                  disabled={saving}
                  autoComplete="off"
                />
                <input
                  className="mcp-input mcp-header-value"
                  type={h.visible ? "text" : "password"}
                  placeholder="Value"
                  value={h.value}
                  onChange={(e) => updateHeader(i, { value: e.target.value })}
                  disabled={saving}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="mcp-header-eye"
                  onClick={() => updateHeader(i, { visible: !h.visible })}
                  title={h.visible ? "Hide value" : "Show value"}
                  aria-label={h.visible ? "Hide value" : "Show value"}
                >
                  {h.visible ? (
                    <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                      <path d="M53.92,34.62a8,8,0,1,0-11.84,10.76L61.32,64.5C36.67,81.18,18.5,106.17,9.28,128a8,8,0,0,0,0,6.31C26.17,173.32,72,224,128,224a122.55,122.55,0,0,0,53.56-12.29l21.6,23.67a8,8,0,1,0,11.84-10.76Zm47.56,55.46,62.44,68.48A48,48,0,0,1,101.48,90.08ZM128,208c-51.47,0-93-43.61-109.32-80C26.64,106.73,45,85.67,67,71.73l15.56,17.07A64,64,0,0,0,172.82,178.6L190.52,198A107.2,107.2,0,0,1,128,208Zm120.72-73.69C231.83,175,185.82,224,128,224a124.48,124.48,0,0,1-24-2.34,8,8,0,0,1,3.08-15.68A109,109,0,0,0,128,208c51.68,0,93.35-43.82,109.32-80-5.18-11.41-13.86-24.73-25.72-37.05a8,8,0,0,1,11.61-11c13.83,14.4,23.51,29.72,29.39,42.63A8,8,0,0,1,248.72,134.31Z"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                      <path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"/>
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  className="mcp-header-del"
                  onClick={() => removeHeader(i)}
                  title="Remove header"
                  aria-label="Remove header"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mcp-headers-add-link"
              onClick={addHeader}
            >
              + Add header
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

// ── Debug log panel ───────────────────────────────────────────────────────────

interface DebugLogPanelProps {
  entries: LogEntry[];
  onClear: () => void;
}

function DebugLogPanel({ entries, onClear }: DebugLogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries.length]);

  return (
    <details className="mcp-log-accordion">
      <summary className="mcp-log-summary">
        Debug log
        {entries.length > 0 && (
          <span className="mcp-log-count">{entries.length}</span>
        )}
      </summary>
      <div className="mcp-log-panel">
        <div className="mcp-log-header">
          <button
            type="button"
            className="mcp-log-clear"
            onClick={onClear}
            disabled={entries.length === 0}
          >
            Clear
          </button>
        </div>
        <div className="mcp-log-body">
          {entries.length === 0 ? (
            <span className="mcp-log-empty">No events yet.</span>
          ) : (
            entries.map((e, i) => (
              <div key={i} className={`mcp-log-line mcp-log-${e.level}`}>
                <span className="mcp-log-ts">{fmtLogTs(e.ts)}</span>
                <span className="mcp-log-level">{e.level.toUpperCase()}</span>
                <span className="mcp-log-msg">{e.msg}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </details>
  );
}

// ── MCP Servers section ───────────────────────────────────────────────────────

function McpServersSection({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<McpDiscoverySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [authPendingServer, setAuthPendingServer] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  /**
   * Set of server names currently in post-OAuth discovery.
   * Shows "Finalizing authorization…" hint in the ServerCard.
   * Cleared when the server reaches a stable state or after the last retry.
   */
  const [finalizingAuth, setFinalizingAuth] = useState<Set<string>>(new Set());

  const popupAbortRef = useRef<OAuthPopupAbort | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Timers for the post-OAuth retry schedule (+750ms, +2000ms). */
  const postOAuthTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /**
   * Timers for general transient-state background retries (initial load / manual refresh).
   * Separate from postOAuthTimers so OAuth and non-OAuth retries don't interfere.
   */
  const transientTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Mirrors snapshot for stable access inside refs-based effects. */
  const snapshotRef = useRef<McpDiscoverySnapshot | null>(null);
  /** True while any server is in post-OAuth discovery (for visibility handler). */
  const hasFinalizingRef = useRef(false);
  /** Stable ref to loadState so effects with [] deps never go stale. */
  const loadStateRef = useRef<(silent?: boolean) => Promise<McpDiscoverySnapshot | null>>(
    () => Promise.resolve(null)
  );
  /** Stable ref to scheduleTransientRetries for the same reason. */
  const scheduleTransientRef = useRef<(snap: McpDiscoverySnapshot | null) => void>(() => {});

  const clearMessages = () => { setError(null); setSuccess(null); };

  const log = (msg: string, level: LogEntry["level"] = "info") => {
    setLogEntries((prev) => {
      const next = [...prev, { ts: Date.now(), level, msg }];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
  };

  // ── State loading ──────────────────────────────────────────────────────────
  //
  // Returns the fetched snapshot so callers can inspect it synchronously
  // after the await.  Returns null when the request was aborted or failed.

  const loadState = async (silent = false): Promise<McpDiscoverySnapshot | null> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const s = await getMcpState(ctrl.signal);
      if (!ctrl.signal.aborted) {
        setSnapshot(s);
        snapshotRef.current = s;
        return s;
      }
      return null;
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const msg = err instanceof Error ? err.message : "Failed to load MCP state.";
        setError(msg);
        log(msg, "error");
      }
      return null;
    } finally {
      if (!ctrl.signal.aborted) { setLoading(false); setRefreshing(false); }
    }
  };

  // Keep loadStateRef pointing at the latest loadState closure so effects with
  // [] deps can always call the current version without re-registering.
  useEffect(() => { loadStateRef.current = loadState; });

  // Keep hasFinalizingRef in sync with finalizingAuth size.
  useEffect(() => { hasFinalizingRef.current = finalizingAuth.size > 0; }, [finalizingAuth]);

  // ── Transient-state auto-retry ─────────────────────────────────────────────
  //
  // After any loadState() that returns a snapshot with one or more servers in
  // TRANSITIONAL_STATES (connecting / initializing / discovering), schedule up
  // to three silent background refreshes so the user doesn't have to click
  // Refresh manually while the DO's SDK finishes reconnecting.
  //
  // This covers the common startup race: the DO logs "state=ready" for MCP but
  // the SDK's internal connect is async, so the first GET /api/mcp still returns
  // "connecting".  The retries at +1.5 s / +4 s / +8 s catch it once ready.

  const scheduleTransientRetries = (snap: McpDiscoverySnapshot | null) => {
    // Always cancel any outstanding transient timers before re-evaluating.
    transientTimers.current.forEach(clearTimeout);
    transientTimers.current = [];

    if (!snap) return;
    const transientServers = snap.servers.filter((s) =>
      (TRANSITIONAL_STATES as string[]).includes(s.state)
    );
    if (transientServers.length === 0) return;

    const names = transientServers.map((s) => s.name).join(", ");
    console.log(`[MCP-DIAG] Transient state on [${names}] — scheduling background retries`);
    log(`MCP servers still connecting [${names}] — checking again shortly…`);

    // Each retry cancels the remaining ones as soon as all servers are stable.
    let cancelled = false;

    const doRetry = async (attempt: number) => {
      if (cancelled) return;
      console.log(`[MCP-DIAG] Background transient retry #${attempt}`);
      const s = await loadStateRef.current(true);
      if (!s || cancelled) return;
      const stillTransient = s.servers.some((x) =>
        (TRANSITIONAL_STATES as string[]).includes(x.state)
      );
      if (!stillTransient) {
        console.log(`[MCP-DIAG] All servers stable after background retry #${attempt}`);
        cancelled = true;
        transientTimers.current.forEach(clearTimeout);
        transientTimers.current = [];
      }
    };

    // Retry schedule: 500ms catches fast DO reconnects; 2s and 5s are safety nets.
    transientTimers.current.push(setTimeout(() => doRetry(1),   500));
    transientTimers.current.push(setTimeout(() => doRetry(2), 2_000));
    transientTimers.current.push(setTimeout(() => doRetry(3), 5_000));
  };

  // Keep scheduleTransientRef pointing at the latest closure.
  useEffect(() => { scheduleTransientRef.current = scheduleTransientRetries; });

  // Initial load + cleanup.
  useEffect(() => {
    if (!enabled) return;
    // Reset retry timers so switching from disabled→enabled always gets a
    // fresh retry schedule regardless of previous component lifetime.
    transientTimers.current.forEach(clearTimeout);
    transientTimers.current = [];
    loadState().then((s) => scheduleTransientRef.current(s));
    return () => {
      abortRef.current?.abort();
      popupAbortRef.current?.();
      postOAuthTimers.current.forEach(clearTimeout);
      postOAuthTimers.current = [];
      transientTimers.current.forEach(clearTimeout);
      transientTimers.current = [];
    };
  }, [enabled]);

  // Refresh when the tab regains focus and any server is in a transient state.
  // Uses refs so this effect never re-registers (no stale closure risk).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const snap = snapshotRef.current;
      const hasTransient = snap?.servers.some((s) =>
        (["connecting", "initializing", "discovering", "authenticating"] as McpServerLifecycleState[])
          .includes(s.state)
      ) ?? false;
      if (hasTransient || hasFinalizingRef.current) {
        console.log("[MCP-DIAG] Tab visible with transient MCP state — silent refresh");
        loadStateRef.current(true).then((s) => scheduleTransientRef.current(s));
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ── OAuth popup ──────────────────────────────────────────────────────────────

  const handleOpenAuth = (serverName: string, authUrl: string) => {
    popupAbortRef.current?.();
    popupAbortRef.current = null;

    // Cancel any in-progress post-OAuth retries from a previous flow.
    postOAuthTimers.current.forEach(clearTimeout);
    postOAuthTimers.current = [];

    setAuthPendingServer(serverName);
    clearMessages();
    log(`Opened OAuth popup for "${serverName}"`);

    const abort = openOAuthPopup(authUrl, (result) => {
      popupAbortRef.current = null;
      setAuthPendingServer(null);

      // ── Blocked ────────────────────────────────────────────────────────────
      if (result.reason === "blocked") {
        const msg = `Popup blocked for "${serverName}". Allow popups for this site, then click Authorize again.`;
        setError(msg);
        log(msg, "warn");
        return;
      }

      // ── Timeout ────────────────────────────────────────────────────────────
      if (result.reason === "timeout") {
        setError(`Authorization timed out for "${serverName}". Click Authorize to try again.`);
        log(`[MCP-DIAG] OAuth popup timed out for "${serverName}"`, "warn");
        loadState(true);
        return;
      }

      // ── Closed before success ──────────────────────────────────────────────
      if (result.reason === "closed" || result.reason === "cancelled") {
        log(`OAuth popup closed for "${serverName}" before completion (${result.reason})`);
        // Refresh anyway — server may have received the token if the callback
        // page closed before the postMessage arrived (rare but possible).
        loadState(true);
        return;
      }

      // ── Auth message received ──────────────────────────────────────────────
      if (result.reason === "message") {
        if (!result.success) {
          // Backend reported failure (rare — SDK sends authSuccess=false).
          log(`[MCP-DIAG] OAuth authorization failed for "${serverName}"`, "warn");
          setError(`Authorization failed for "${serverName}". Please try again.`);
          loadState(true);
          return;
        }

        // ── Success path: schedule multi-refresh to wait for discovery ───────
        log(`[MCP-DIAG] "${serverName}" authorized — scheduling post-OAuth refresh sequence`);

        // Mark as finalizing so ServerCard shows "Finalizing authorization…"
        setFinalizingAuth((prev) => { const n = new Set(prev); n.add(serverName); return n; });

        // States that are NOT yet stable (discovery still in progress).
        const TRANSIENT: ReadonlySet<McpServerLifecycleState> = new Set([
          "connecting", "initializing", "discovering", "authenticating",
        ] as McpServerLifecycleState[]);

        let retriesCancelled = false;

        const isStable = (snap: McpDiscoverySnapshot | null): boolean => {
          const srv = snap?.servers.find((x) => x.name === serverName);
          return !!srv && !TRANSIENT.has(srv.state);
        };

        const clearFinalizing = () => {
          setFinalizingAuth((prev) => {
            const n = new Set(prev);
            n.delete(serverName);
            return n;
          });
        };

        // Runs a single silent refresh and checks whether the server is now stable.
        // Returns true when stable so the caller can cancel remaining retries.
        const doRefresh = async (attempt: number): Promise<boolean> => {
          if (retriesCancelled) {
            log(`[MCP-DIAG] Silent refresh #${attempt} for "${serverName}" — skipped (already stable)`);
            return true;
          }
          log(`[MCP-DIAG] Silent refresh #${attempt} triggered for "${serverName}"`);
          const s = await loadState(true);
          if (s === null) {
            // Request was aborted (superseded by a newer call) — not our result to judge.
            log(`[MCP-DIAG] Refresh #${attempt} for "${serverName}" aborted (superseded)`);
            return false;
          }
          const srv = s.servers.find((x) => x.name === serverName);
          log(
            `[MCP-DIAG] Refresh #${attempt} result for "${serverName}": ` +
            `state=${srv?.state ?? "??"} ` +
            `tools=${srv?.toolCount ?? 0} prompts=${srv?.promptCount ?? 0} ` +
            `resources=${srv?.resourceCount ?? 0}`
          );
          if (isStable(s)) {
            log(`[MCP-DIAG] "${serverName}" stable after refresh #${attempt} — cancelling retries`);
            retriesCancelled = true;
            clearFinalizing();
            postOAuthTimers.current.forEach(clearTimeout);
            postOAuthTimers.current = [];
            return true;
          }
          return false;
        };

        // Refresh #1 — immediate (right after popup message fires).
        doRefresh(1);

        // Refresh #2 — +750 ms (gives the DO a moment to finish token exchange).
        postOAuthTimers.current.push(
          setTimeout(() => doRefresh(2), 750)
        );

        // Refresh #3 — +2000 ms (final safety net; also unconditionally clears
        // the "Finalizing authorization…" badge so it never lingers).
        postOAuthTimers.current.push(
          setTimeout(async () => {
            await doRefresh(3);
            // Always clear finalizingAuth after the last attempt, even if the
            // server is still transitioning (user can see real state in the card).
            clearFinalizing();
          }, 2000)
        );
      }
    });

    popupAbortRef.current = abort;
  };

  const maybeOpenAuth = (s: McpDiscoverySnapshot) => {
    const srv = s.servers.find((x) => x.state === "authenticating" && x.auth.authUrl);
    if (srv) handleOpenAuth(srv.name, srv.auth.authUrl!);
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  const handleAdd = async (
    name: string,
    url: string,
    transport: McpTransport,
    headers: Record<string, string>
  ) => {
    clearMessages();
    setSaving(true);
    log(`Connecting "${name}" (${transport}) → ${url}`);
    try {
      const s = await addMcpServer({
        name, url, transport,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      setSnapshot(s);
      setShowAddForm(false);

      const srv = s.servers.find((x) => x.name === name);
      if (srv?.state === "authenticating") {
        log(`"${name}" requires OAuth — opening popup`);
        maybeOpenAuth(s);
      } else {
        log(`"${name}" connected (state=${srv?.state ?? "unknown"}, ` +
          `${srv?.toolCount ?? 0} tools, ${srv?.promptCount ?? 0} prompts, ${srv?.resourceCount ?? 0} resources)`);
        setSuccess(`Server "${name}" connected.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect server.";
      setError(msg);
      log(`Connect "${name}" failed: ${msg}`, "error");
    } finally { setSaving(false); }
  };

  const handleRemove = async (name: string) => {
    if (!confirm(`Remove MCP server "${name}"? This will disconnect it immediately.`)) return;
    if (authPendingServer === name) {
      popupAbortRef.current?.(); popupAbortRef.current = null; setAuthPendingServer(null);
    }
    clearMessages();
    setSaving(true);
    log(`Removing "${name}"…`);
    try {
      const s = await removeMcpServer(name);
      setSnapshot(s);
      setSuccess(`Server "${name}" removed.`);
      log(`"${name}" removed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove server.";
      setError(msg);
      log(`Remove "${name}" failed: ${msg}`, "error");
    } finally { setSaving(false); }
  };

  const handleToggleEnabled = async (name: string, enabled: boolean) => {
    clearMessages();
    setSaving(true);
    log(`${enabled ? "Enabling" : "Disabling"} "${name}"…`);
    try {
      const s = await updateMcpServer(name, { enabled });
      setSnapshot(s);
      log(`"${name}" ${enabled ? "enabled and reconnecting" : "disabled"}`);
      if (enabled) {
        const srv = s.servers.find((x) => x.name === name);
        if (srv?.state === "authenticating") maybeOpenAuth(s);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update server.";
      setError(msg);
      log(msg, "error");
    } finally { setSaving(false); }
  };

  const handleReconnect = async (name: string) => {
    clearMessages();
    setSaving(true);
    log(`Reconnecting "${name}"…`);
    try {
      const s = await reconnectMcpServer(name);
      setSnapshot(s);
      const srv = s.servers.find((x) => x.name === name);
      if (srv?.state === "authenticating") {
        log(`"${name}" requires OAuth after reconnect — opening popup`);
        maybeOpenAuth(s);
      } else {
        log(`"${name}" reconnected (state=${srv?.state ?? "unknown"})`);
        setSuccess(`Server "${name}" reconnecting.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reconnect server.";
      setError(msg);
      log(`Reconnect "${name}" failed: ${msg}`, "error");
    } finally { setSaving(false); }
  };

  // ── Disabled ──────────────────────────────────────────────────────────────────

  if (!enabled) {
    return (
      <p className="muted mcp-disabled-hint">
        Enable MCP above to manage server connections.
      </p>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const serverCount = snapshot?.servers.length ?? 0;
  const totalItems = (snapshot?.totalTools ?? 0) + (snapshot?.totalPrompts ?? 0) + (snapshot?.totalResources ?? 0);

  return (
    <div className="mcp-servers-section">

      {/* ── Section header ── */}
      <div className="mcp-section-head">
        <span className="mcp-section-label">MCP SERVERS</span>
        <div className="mcp-section-summary-text">
          {snapshot && serverCount > 0 && (
            <span className="muted">
              {serverCount} server{serverCount !== 1 ? "s" : ""}
              {totalItems > 0 && (
                <> · {[
                  snapshot.totalTools > 0 && `${snapshot.totalTools} tool${snapshot.totalTools !== 1 ? "s" : ""}`,
                  snapshot.totalPrompts > 0 && `${snapshot.totalPrompts} prompt${snapshot.totalPrompts !== 1 ? "s" : ""}`,
                  snapshot.totalResources > 0 && `${snapshot.totalResources} resource${snapshot.totalResources !== 1 ? "s" : ""}`,
                ].filter(Boolean).join(", ")}</>
              )}
            </span>
          )}
        </div>
        <div className="mcp-section-btns">
          <button
            className="btn-header-secondary"
            onClick={() => {
              transientTimers.current.forEach(clearTimeout);
              transientTimers.current = [];
              loadState(true).then((s) => scheduleTransientRetries(s));
            }}
            disabled={loading || refreshing || saving}
            title="Refresh server state"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {!showAddForm && (
            <button
              className="btn-header-secondary mcp-add-toggle"
              onClick={() => { setShowAddForm(true); clearMessages(); }}
              disabled={saving}
            >
              + Add Server
            </button>
          )}
        </div>
      </div>

      {/* ── Banners ── */}
      {error && (
        <div className="mcp-banner mcp-banner-error" role="alert">
          {error}
          <button className="mcp-banner-close" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {success && (
        <div className="mcp-banner mcp-banner-success" role="status">
          {success}
          <button className="mcp-banner-close" onClick={() => setSuccess(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ── Add bar ── */}
      {showAddForm && (
        <AddServerBar
          onAdd={handleAdd}
          onCancel={() => setShowAddForm(false)}
          saving={saving}
        />
      )}

      {/* ── Loading ── */}
      {loading && <p className="muted mcp-loading">Loading…</p>}

      {/* ── Empty state ── */}
      {!loading && snapshot && serverCount === 0 && !showAddForm && (
        <div className="mcp-empty-state">
          <p className="mcp-empty-title">No servers connected</p>
          <p className="muted mcp-empty-desc">
            Connect an MCP server to give the agent access to external tools, data, and prompts.
          </p>
          <button className="btn-header-secondary" onClick={() => setShowAddForm(true)}>
            + Add Server
          </button>
        </div>
      )}

      {/* ── Server cards ── */}
      {!loading && snapshot && serverCount > 0 && (
        <div className="mcp-server-list">
          {snapshot.servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              snapshot={snapshot}
              onRemove={handleRemove}
              onReconnect={handleReconnect}
              onToggleEnabled={handleToggleEnabled}
              onOpenAuth={handleOpenAuth}
              authPendingServer={authPendingServer}
              busy={saving}
              isFinalizingAuth={finalizingAuth.has(server.name)}
            />
          ))}
        </div>
      )}

      {/* ── Debug log (always visible when MCP is enabled) ── */}
      <DebugLogPanel entries={logEntries} onClear={() => setLogEntries([])} />
    </div>
  );
}

// ── Main SettingsPage ─────────────────────────────────────────────────────────

export function SettingsPage({ settings, onChange, sessionId }: SettingsPageProps) {
  const set = <K extends keyof FeatureSettings>(key: K, value: FeatureSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const [ttsTestLoading, setTtsTestLoading] = useState(false);
  const [ttsTestError, setTtsTestError] = useState<string | null>(null);
  const ttsTestAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (ttsTestAudioRef.current) {
        ttsTestAudioRef.current.pause();
        ttsTestAudioRef.current = null;
      }
    };
  }, []);

  const playTtsTest = useCallback(async () => {
    if (ttsTestAudioRef.current) {
      ttsTestAudioRef.current.pause();
      ttsTestAudioRef.current = null;
    }
    setTtsTestError(null);
    setTtsTestLoading(true);
    try {
      const res = await fetch(
        `/api/voice/tts-preview?session=${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speaker: settings.ttsSpeaker }),
        }
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsTestAudioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        ttsTestAudioRef.current = null;
      };
      audio.addEventListener("ended", () => {
        cleanup();
        setTtsTestLoading(false);
      });
      audio.addEventListener("error", () => {
        cleanup();
        setTtsTestError("Could not play audio in this browser.");
        setTtsTestLoading(false);
      });
      try {
        await audio.play();
      } catch {
        cleanup();
        setTtsTestError("Playback was blocked. Click again or check browser autoplay settings.");
        setTtsTestLoading(false);
        return;
      }
    } catch (e) {
      setTtsTestError(e instanceof Error ? e.message : "Voice test failed.");
      setTtsTestLoading(false);
    }
  }, [sessionId, settings.ttsSpeaker]);

  return (
    <section className="page-shell settings-page">
      <header className="page-header">
        <h2>Settings</h2>
      </header>

      <div className="settings-scroll">

        <div className="settings-grid">
          <label>
            <span>Observability level</span>
            <select
              value={settings.observabilityLevel}
              onChange={(e) =>
                set("observabilityLevel", e.target.value as FeatureSettings["observabilityLevel"])
              }
            >
              <option value="off">off</option>
              <option value="error">error</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
          </label>
        </div>

        <div className="toggle-grid">
          <label>
            <input type="checkbox" checked={settings.enableBrowserTools}
              onChange={(e) => set("enableBrowserTools", e.target.checked)} />
            Enable browser tools (main chat)
          </label>
          <label>
            <input type="checkbox" checked={settings.enableCodeExecution}
              onChange={(e) => set("enableCodeExecution", e.target.checked)} />
            Enable code execution
          </label>
          <label>
            <input type="checkbox" checked={settings.enableMcp}
              onChange={(e) => set("enableMcp", e.target.checked)} />
            Enable MCP
          </label>
          <label>
            <input type="checkbox" checked={settings.enableVoice}
              onChange={(e) => set("enableVoice", e.target.checked)} />
            Enable voice
          </label>
        </div>

        {/* ── MCP Servers ── */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h3 className="settings-card-title">MCP Servers</h3>
              <p className="settings-card-desc muted">
                Connect external MCP servers so the agent can use their tools, prompts, and
                resources. OAuth and bearer tokens are handled server-side — credentials are
                never returned to the browser.
              </p>
            </div>
          </div>
          <McpServersSection enabled={settings.enableMcp} />
        </section>

        {/* ── Browser automation ── */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h3 className="settings-card-title">Browser automation</h3>
              <p className="settings-card-desc muted">
                <strong>Main Chat</strong> only: when off, browser_search / browser_execute / browser_session are
                hidden there (your worker keeps <code>ENABLE_BROWSER_TOOLS</code> bindings).{" "}
                <strong>Agent Browsing</strong> (dedicated page) always has browser tools regardless of this checkbox.
              </p>
            </div>
          </div>
          <label>
            <span>Executor backend</span>
            <select
              disabled={!settings.enableBrowserTools}
              value={settings.browserStepExecutor}
              onChange={(e) =>
                set("browserStepExecutor", e.target.value as FeatureSettings["browserStepExecutor"])
              }
            >
              <option value="cdp">CDP (default)</option>
              <option value="puppeteer">Puppeteer</option>
            </select>
          </label>
          {!settings.enableBrowserTools && (
            <p className="muted settings-card-disabled-note">Enable browser tools above to change this setting.</p>
          )}

          <label style={{ display: "block", marginTop: "14px" }}>
            <span>Agent Browsing — LLM inference</span>
            <select
              value={settings.browsingInferenceBackend}
              onChange={(e) =>
                set(
                  "browsingInferenceBackend",
                  e.target.value as FeatureSettings["browsingInferenceBackend"]
                )
              }
            >
              <option value="workers-ai">Workers AI (direct binding, default)</option>
              <option value="ai-gateway">AI Gateway (agent-router, metadata agent BrowserAgent)</option>
            </select>
          </label>
          <p className="muted settings-card-desc" style={{ marginTop: "8px" }}>
            AI Gateway mode uses <code>AI_GATEWAY_BASE_URL</code> (…/compat) and <code>AI_GATEWAY_TOKEN</code>.
            Route <code>dynamic/agent-router</code> must include a <code>BrowserAgent</code> branch — see{" "}
            <code>docs/ai-gateway-agent-router.json</code>.
          </p>
        </section>

        {/* ── Voice ── */}
        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h3 className="settings-card-title">Voice</h3>
              <p className="settings-card-desc muted">
                TTS uses Cloudflare Workers AI{" "}
                <a
                  href="https://developers.cloudflare.com/workers-ai/models/aura-1/"
                  target="_blank"
                  rel="noreferrer"
                >
                  @cf/deepgram/aura-1
                </a>
                . Spoken input uses{" "}
                <a
                  href="https://developers.cloudflare.com/workers-ai/models/flux/"
                  target="_blank"
                  rel="noreferrer"
                >
                  @cf/deepgram/flux
                </a>{" "}
                for end-of-turn detection. Options below apply to the next voice session (and sync to the
                server when changed).
              </p>
            </div>
          </div>
          <label>
            <span>Voice mode</span>
            <select
              disabled={!settings.enableVoice}
              value={settings.voiceMode}
              onChange={(e) => set("voiceMode", e.target.value as FeatureSettings["voiceMode"])}
            >
              <option value="disabled">disabled</option>
              <option value="push-to-talk">push-to-talk</option>
              <option value="hands-free">hands-free</option>
            </select>
          </label>
          <label>
            <span>Agent voice (TTS)</span>
            <div className="settings-tts-inline">
              <select
                disabled={!settings.enableVoice}
                value={settings.ttsSpeaker}
                onChange={(e) =>
                  set("ttsSpeaker", e.target.value as FeatureSettings["ttsSpeaker"])
                }
              >
                {AURA_TTS_SPEAKERS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-header-secondary"
                disabled={!settings.enableVoice || ttsTestLoading}
                onClick={playTtsTest}
                aria-busy={ttsTestLoading}
              >
                {ttsTestLoading ? "Playing…" : "Test voice"}
              </button>
            </div>
            {ttsTestError && (
              <p className="settings-voice-hint muted" role="alert" style={{ marginTop: 6 }}>
                {ttsTestError}
              </p>
            )}
            <p className="muted settings-voice-hint" style={{ marginTop: 6 }}>
              Plays a short sample in your browser (same @cf/deepgram/aura-1 speaker as the agent for this session).
            </p>
          </label>

          <h4 className="settings-voice-stt-title">When the assistant treats you as &quot;done speaking&quot; (Flux STT)</h4>
          <p className="settings-card-desc muted" style={{ marginTop: 6, marginBottom: 10 }}>
            The model decides when a pause means your turn is finished. These map to Cloudflare / Deepgram{" "}
            <code>eot_threshold</code>, <code>eot_timeout_ms</code>, and optional <code>eager_eot_threshold</code> on
            the Flux STT connection. They sync to the server when you change them (and on each chat message with your
            saved settings).
          </p>
          <label>
            <span>End-of-turn strictness (0.5 – 0.9)</span>
            <input
              type="number"
              min={0.5}
              max={0.9}
              step={0.05}
              disabled={!settings.enableVoice}
              value={settings.voiceFluxEotThreshold}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isFinite(v)) return;
                const eot = Math.min(0.9, Math.max(0.5, v));
                const next: FeatureSettings = { ...settings, voiceFluxEotThreshold: eot };
                if (settings.voiceFluxEagerEotThreshold != null) {
                  next.voiceFluxEagerEotThreshold = Math.min(settings.voiceFluxEagerEotThreshold, eot);
                }
                onChange(next);
              }}
            />
            <p className="muted settings-voice-hint" style={{ marginTop: 6 }}>
              <strong>Higher</strong> (e.g. 0.85–0.9): the model must be more confident you finished your thought before
              it finalizes the utterance — <strong>better if you pause mid-sentence</strong>, but the assistant may feel
              slightly slower to start. <strong>Lower</strong> (e.g. 0.5–0.65): finalizes sooner after a short silence —{" "}
              <strong>snappier replies</strong>, more risk the agent answers before you meant to stop.
            </p>
          </label>
          <label>
            <span>Max silence before a turn can close (ms, 500 – 10000)</span>
            <input
              type="number"
              min={500}
              max={10000}
              step={100}
              disabled={!settings.enableVoice}
              value={settings.voiceFluxEotTimeoutMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) return;
                set("voiceFluxEotTimeoutMs", Math.min(10000, Math.max(500, v)));
              }}
            />
            <p className="muted settings-voice-hint" style={{ marginTop: 6 }}>
              How long you can stay <strong>silent</strong> before the model may <strong>force</strong> an
              end-of-turn (even if confidence is not perfect). <strong>Larger</strong> (e.g. 7000–10000): tolerates
              <strong> long thinking pauses</strong> in the same turn. <strong>Smaller</strong> (e.g. 500–2000): ends
              the turn faster after a gap — good for back-and-forth, easier to split one idea across two turns by
              accident.
            </p>
          </label>
          <label>
            <span>Eager end-of-turn threshold (0.3 – 0.9, optional)</span>
            <input
              type="number"
              min={0.3}
              max={0.9}
              step={0.05}
              disabled={!settings.enableVoice}
              value={settings.voiceFluxEagerEotThreshold ?? ""}
              placeholder="Off"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === "") {
                  set("voiceFluxEagerEotThreshold", undefined);
                  return;
                }
                const v = parseFloat(raw);
                if (!Number.isFinite(v)) return;
                set(
                  "voiceFluxEagerEotThreshold",
                  Math.min(0.9, Math.max(0.3, Math.min(v, settings.voiceFluxEotThreshold)))
                );
              }}
            />
            <p className="muted settings-voice-hint" style={{ marginTop: 6 }}>
              Enables a <strong>second, looser</strong> “eager” end-of-turn signal in the Flux model. In this app the
              assistant still responds on the <strong>final</strong> end-of-turn; eager mainly affects <strong>earlier
              partial / speculative</strong> signals in the STT stream. <strong>Lower</strong> eager values fire those
              hints sooner (more aggressive). <strong>Leave empty</strong> to turn off. If set, it should stay{" "}
              <strong>≤</strong> end-of-turn strictness above (we cap it automatically).
            </p>
          </label>
        </section>

      </div>
    </section>
  );
}
