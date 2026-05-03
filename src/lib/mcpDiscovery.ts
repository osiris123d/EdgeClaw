/**
 * mcpDiscovery.ts
 *
 * Normalized discovery model for MCP servers.
 *
 * Responsibilities:
 * - Define typed shapes for everything an MCP server can expose
 * - Provide resilient conversion helpers from raw SDK state to normalized form
 * - Produce a McpDiscoverySnapshot that merges persisted config with runtime state
 *
 * Separation of concerns:
 * - Runtime data (tools, capabilities, connection state) flows from the SDK and
 *   is rebuilt on every call to buildDiscoverySnapshot().
 * - Persisted data (server name, URL, transport, token, addedAt) comes from
 *   the DO's configure()/getConfig() store and is owned by MainAgent.
 * - Debug/raw data is preserved inside _debug fields on each server entry and
 *   is present in the HTTP response but excluded from all logging helpers.
 *
 * Adapted from the health snapshot, lifecycle state, and runtime-health patterns
 * in the CloudflareBot mcp-lifecycle.ts / mcp-runtime-health.ts modules.
 */

// ── Transport ─────────────────────────────────────────────────────────────────
//
// CF_Truth only supports URL-based MCP connections — that is, every MCP server
// lives behind an https:// endpoint and is reached via standard HTTP/SSE.
//
// Cloudflare's Agents SDK also defines a "binding" (RPC) transport used for
// direct worker-to-worker MCP connections configured in wrangler.jsonc.  CF_Truth
// intentionally does NOT expose that transport:
//
//   - No `McpBinding` is declared in wrangler.jsonc.
//   - No internal worker binds to an MCP server via the RPC path.
//   - Exposing "rpc" in this type union would allow the UI to select a transport
//     that cannot succeed, which would surface an opaque SDK error at runtime.
//
// If CF_Truth ever gains a worker-to-worker MCP binding, add "rpc" here AND add
// corresponding wrangler.jsonc configuration AND a dedicated API route for it.
//
// Transport values:
//
//   "streamable-http"  — Recommended for all remote servers.  Uses the MCP
//                        Streamable HTTP transport (HTTP/1.1 chunked + SSE
//                        upgrade).  Stateful, bidirectional, OAuth-capable.
//                        Default for all user-added servers.
//
//   "sse"              — Legacy.  Uses plain HTTP GET SSE without the stateful
//                        upgrade.  Supported by older MCP servers.  The MCP spec
//                        has deprecated this in favour of streamable-http.
//                        Shown as "Legacy SSE" in the UI.
//
//   "auto"             — SDK auto-detect: tries streamable-http first, then
//                        falls back to SSE if the server returns a 4xx.
//                        Accepted for backward compatibility with existing
//                        persisted configs but NOT the default for new servers.
//                        Transport negotiation failures in "auto" mode produce
//                        non-specific errors; prefer an explicit value.

export type McpTransport = "streamable-http" | "sse" | "auto";

// ── Raw SDK types ─────────────────────────────────────────────────────────────
//
// Minimal typed view of what getMcpServers() returns.
// Kept as narrow as possible so we don't break when the SDK adds fields.

export interface RawSdkServer {
  name: string;
  server_url: string;
  /** SDK connection state string (e.g. "ready", "authenticating", "connecting"). */
  state: string;
  error: string | null;
  auth_url: string | null;
  instructions: string | null;
  /** Raw MCP capabilities object reported by the server. May be null until discovery completes. */
  capabilities: Record<string, unknown> | null;
}

export interface RawSdkTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input parameters. Present for most servers, absent for legacy ones. */
  inputSchema?: unknown;
  serverId: string;
  /** Annotations defined by the MCP spec (e.g. read-only hints, audience). */
  annotations?: Record<string, unknown>;
}

export interface RawSdkPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface RawSdkPrompt {
  name: string;
  description?: string;
  arguments?: RawSdkPromptArg[];
  serverId: string;
}

export interface RawSdkResource {
  name: string;
  description?: string;
  uri?: string;
  mimeType?: string;
  serverId: string;
  /** Resource template URI pattern, if the resource is a template. */
  uriTemplate?: string;
}

export interface RawSdkMcpState {
  servers: Record<string, RawSdkServer>;
  tools: RawSdkTool[];
  prompts: RawSdkPrompt[];
  resources: RawSdkResource[];
}

export const EMPTY_RAW_SDK_STATE: RawSdkMcpState = {
  servers: {},
  tools: [],
  prompts: [],
  resources: [],
};

// ── Persisted server config ───────────────────────────────────────────────────
//
// What MainAgent stores in the DO's SQLite via configure()/getConfig().
// Persisted fields: identity + connection config + safe display metadata.
// Never persisted: runtime state, SDK-derived data, transient OAuth state.
//
// Sensitive fields (headers, token) are NEVER returned to clients.
// They are stripped by _mcpConfigForSnapshot() before reaching buildDiscoverySnapshot().
// The type PersistedMcpServerSafe encodes this guarantee at compile time.

export interface PersistedMcpServer {
  /**
   * Stable UUID generated once at creation time.
   * Never changes even if the server is renamed.
   * Used as the canonical key in the runtime cache and as React list keys.
   */
  id: string;

  /** User-assigned display name. Unique within this agent instance. */
  name: string;

  /** Full https:// endpoint URL. */
  url: string;

  /** Requested transport protocol (see McpTransport block comment above). */
  transport: McpTransport;

  /**
   * When false, the server is configured but intentionally disconnected.
   * Skipped during _mcpRestoreServers() on DO startup.
   * Appears in discovery snapshots as state="disconnected".
   * Defaults to true for all newly added servers.
   */
  enabled: boolean;

  /**
   * Arbitrary auth/custom headers forwarded on every SDK request.
   * Stored server-side only — stripped before any API response.
   * Common values: { Authorization: "Bearer <token>" }, CF-Access-Client-Id, etc.
   */
  headers?: Record<string, string>;

  /**
   * Legacy single bearer token.
   * @deprecated Use `headers: { Authorization: "Bearer <token>" }` instead.
   * Kept for backward compatibility with configs persisted before the headers field.
   */
  token?: string;

  /** ISO timestamp when this server config was first created. */
  createdAt: string;

  /**
   * ISO timestamp when this server config was last modified.
   * Updated on: enable/disable, transport change, header change.
   * NOT updated on reconnect (reconnect does not change the config).
   */
  updatedAt: string;
}

/**
 * Safe (credential-free) projection of PersistedMcpServer for use inside
 * buildDiscoverySnapshot().  Enforces at compile time that headers and token
 * never reach the snapshot builder or any API response.
 */
export type PersistedMcpServerSafe = Omit<PersistedMcpServer, "headers" | "token">;

/**
 * Migrate a raw stored object to the current PersistedMcpServer shape.
 *
 * Handles configs written before id/enabled/createdAt/updatedAt were added
 * (i.e. configs with only name/url/transport/addedAt).
 * The migrated shape is returned in memory; it is written back to storage on
 * the next _mcpWriteConfig() call (lazy migration, no one-time script needed).
 */
export function migratePersistedMcpServer(raw: unknown): PersistedMcpServer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[EdgeClaw] migratePersistedMcpServer: input is not an object");
  }
  const r = raw as Record<string, unknown>;

  const now = new Date().toISOString();
  // Support both old addedAt and new createdAt field names
  const createdAt =
    typeof r.createdAt === "string" ? r.createdAt :
    typeof r.addedAt  === "string" ? r.addedAt  : now;
  const updatedAt =
    typeof r.updatedAt === "string" ? r.updatedAt : createdAt;

  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new Error("[EdgeClaw] migratePersistedMcpServer: missing or invalid \"name\" field");
  }
  if (typeof r.url !== "string" || !r.url.trim()) {
    throw new Error("[EdgeClaw] migratePersistedMcpServer: missing or invalid \"url\" field");
  }

  return {
    id:        typeof r.id === "string" && r.id.trim() ? r.id : crypto.randomUUID(),
    name:      r.name.trim(),
    url:       r.url.trim(),
    transport: (["streamable-http", "sse", "auto"].includes(r.transport as string)
                  ? r.transport
                  : "streamable-http") as McpTransport,
    enabled:   r.enabled !== false,  // default true; false only if explicitly stored
    headers:   r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)
                 ? (r.headers as Record<string, string>)
                 : undefined,
    token:     typeof r.token === "string" ? r.token : undefined,
    createdAt,
    updatedAt,
  };
}

// ── Lifecycle state ───────────────────────────────────────────────────────────
//
// Richer than the raw SDK state string.  Adapted from CloudflareBot's
// McpLifecycleState + deriveMcpLifecycleState() in mcp-lifecycle.ts.

export type McpServerLifecycleState =
  /** Persisted config exists but no SDK connection has been established yet. */
  | "disconnected"
  /** SDK is establishing the TCP/HTTP connection. */
  | "connecting"
  /** SDK is negotiating capabilities with the server (pre-tool-discovery). */
  | "initializing"
  /** Server is waiting for the user to complete an OAuth flow. */
  | "authenticating"
  /** SDK is loading tool/prompt/resource lists from the server. */
  | "discovering"
  /** Connected and at least one tool, prompt, or resource is available. */
  | "ready"
  /** Connected but the server returned no tools, prompts, or resources. */
  | "degraded"
  /** SDK reported an unrecoverable error. */
  | "failed"
  /** Previously seen in the SDK but now absent — likely after DO hibernation. */
  | "offline";

// ── Capabilities ──────────────────────────────────────────────────────────────
//
// Structured view of the MCP ServerCapabilities object.
// https://spec.modelcontextprotocol.io/specification/basic/lifecycle/#capabilities

export interface McpServerCapabilities {
  /** Server implements the tools endpoint. */
  supportsTools: boolean;
  /** Server will push tool-list-changed notifications. */
  toolsListChanged: boolean;
  /** Server implements the prompts endpoint. */
  supportsPrompts: boolean;
  promptsListChanged: boolean;
  /** Server implements the resources endpoint. */
  supportsResources: boolean;
  /** Server will push resource-updated notifications. */
  resourcesSubscribe: boolean;
  resourcesListChanged: boolean;
  /** Server implements the logging endpoint. */
  supportsLogging: boolean;
  /** Experimental extensions declared by the server. */
  experimental: Record<string, Record<string, unknown>>;
  /**
   * Raw capabilities object preserved for debugging.
   * May contain fields not modelled above (spec evolves).
   */
  _raw: Record<string, unknown>;
}

// ── Auth metadata ─────────────────────────────────────────────────────────────

export interface McpAuthMeta {
  /** Whether the server currently requires OAuth authorization. */
  required: boolean;
  /** OAuth URL to open in a browser. Non-null when state === "authenticating". */
  authUrl: string | null;
  /**
   * Human-readable provider hint extracted from the auth URL.
   * Examples: "github", "google", "linear", "notion".
   * Null when authUrl is absent or unrecognized.
   */
  providerHint: string | null;
}

// ── Discovered items ──────────────────────────────────────────────────────────

export interface DiscoveredMcpTool {
  name: string;
  /** Empty string when the server did not provide a description. */
  description: string;
  /**
   * JSON Schema object for the tool's input parameters.
   * Null when the server does not provide a schema (legacy servers).
   */
  inputSchema: Record<string, unknown> | null;
  /**
   * MCP tool annotations (hints about read-only status, audience, etc.).
   * Null when absent.
   */
  annotations: Record<string, unknown> | null;
  serverId: string;
  serverName: string;
}

export interface DiscoveredMcpPromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface DiscoveredMcpPrompt {
  name: string;
  description: string;
  /** Arguments the caller can pass when invoking this prompt. Empty array when not provided. */
  args: DiscoveredMcpPromptArg[];
  serverId: string;
  serverName: string;
}

export interface DiscoveredMcpResource {
  name: string;
  description: string;
  /** Concrete resource URI, or empty string when only a template is available. */
  uri: string;
  /** URI template (RFC 6570 pattern) when the resource is parameterized. Null otherwise. */
  uriTemplate: string | null;
  mimeType: string | null;
  serverId: string;
  serverName: string;
}

// ── Per-server debug snapshot ─────────────────────────────────────────────────
//
// Preserved in the API response for observability.  Never used for inference.

export interface McpServerDebug {
  /** Verbatim state string returned by the SDK (e.g. "ready", "authenticating"). */
  rawSdkState: string | null;
  /** Raw capabilities object before normalization. */
  rawCapabilities: Record<string, unknown> | null;
  /** SDK's internal server_url field (may differ from persisted URL). */
  rawServerUrl: string | null;
}

// ── In-memory runtime cache ───────────────────────────────────────────────────
//
// Tracks state transition timestamps for each server within the lifetime of a
// single DO instance.  Stored in a Map<serverId, ServerRuntimeCache> on
// MainAgent; resets on hibernation (acceptable — these are observability
// timestamps, not durable data).
//
// buildDiscoverySnapshot() mutates the cache on each call so that connectedAt /
// discoveredAt / firstErrorAt record the first time a transition occurred,
// not the current wall-clock time.

export interface ServerRuntimeCache {
  /** Lifecycle state from the previous snapshot — used for transition detection. */
  prevState: McpServerLifecycleState | null;
  /** ISO timestamp when this server first entered a live state (ready/degraded). */
  connectedAt: string | null;
  /** ISO timestamp when this server first had at least one discovered item. */
  discoveredAt: string | null;
  /**
   * ISO timestamp when this server first entered a failed/error state.
   * Reset to null when the server re-enters connecting/initializing (new attempt).
   */
  firstErrorAt: string | null;
}

// ── Normalized server entry ───────────────────────────────────────────────────

export interface DiscoveredMcpServer {
  // ── Identity (from persisted config) ────────────────────────────────────
  /** Stable UUID, never changes even after rename. Safe React list key. */
  id: string;
  /** User-assigned display name. */
  name: string;
  /** Endpoint URL. */
  url: string;
  transport: McpTransport;
  /**
   * When false the server is configured but deliberately not connected.
   * The user can re-enable it from the Settings panel without re-entering the URL.
   */
  enabled: boolean;
  /** ISO timestamp when this server config was first created. */
  createdAt: string;
  /** ISO timestamp when this server config was last modified. */
  updatedAt: string;

  // ── Runtime connection state ─────────────────────────────────────────────
  state: McpServerLifecycleState;
  /**
   * Internal SDK server ID (the key in getMcpServers().servers).
   * Null when not currently represented in the SDK.
   */
  sdkServerId: string | null;

  // ── Runtime discovered metadata (rebuilt on every snapshot) ─────────────
  /** Usage instructions exposed by the server. Null until discovered. */
  instructions: string | null;
  /** Structured capabilities. Null until the discovery phase completes. */
  capabilities: McpServerCapabilities | null;
  /** Auth metadata — authUrl is transient OAuth handshake state from the SDK. */
  auth: McpAuthMeta;

  // ── Runtime discovery counts ─────────────────────────────────────────────
  toolCount: number;
  promptCount: number;
  resourceCount: number;

  // ── Runtime error state ──────────────────────────────────────────────────
  error: string | null;
  /**
   * ISO timestamp when this server first entered a failed/error state.
   * Tracked via ServerRuntimeCache — accurate to state transition, not snapshot time.
   * Null while the server is healthy or on first snapshot after DO startup.
   */
  firstErrorAt: string | null;

  // ── Runtime transition timestamps ────────────────────────────────────────
  /**
   * ISO timestamp when this server first reached a live state (ready/degraded)
   * within the current DO lifetime.  Null before first successful connection.
   * Tracked via ServerRuntimeCache — not re-set on subsequent snapshots.
   */
  connectedAt: string | null;
  /**
   * ISO timestamp when this server first had discovered items in the current
   * DO lifetime.  Null before first successful discovery.
   */
  discoveredAt: string | null;

  // ── Debug / raw ──────────────────────────────────────────────────────────
  _debug: McpServerDebug;
}

// ── Top-level discovery snapshot ─────────────────────────────────────────────

export interface McpDiscoverySnapshot {
  servers: DiscoveredMcpServer[];
  tools: DiscoveredMcpTool[];
  prompts: DiscoveredMcpPrompt[];
  resources: DiscoveredMcpResource[];
  totalServers: number;
  totalTools: number;
  totalPrompts: number;
  totalResources: number;
  snapshotAt: string;
}

// ── String normalization helpers ──────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

// ── Capabilities normalization ────────────────────────────────────────────────

/**
 * Convert a raw MCP ServerCapabilities object into a structured, typed form.
 *
 * Resilient to missing or malformed fields: each capability category is
 * independently checked so a partial response does not lose the rest.
 *
 * Returns null when the raw value is absent or clearly invalid.
 */
export function normalizeCapabilities(raw: unknown): McpServerCapabilities | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const r = raw as Record<string, unknown>;

  const toolsCap = r.tools;
  const toolsObj = toolsCap && typeof toolsCap === "object" && !Array.isArray(toolsCap)
    ? (toolsCap as Record<string, unknown>)
    : null;

  const promptsCap = r.prompts;
  const promptsObj = promptsCap && typeof promptsCap === "object" && !Array.isArray(promptsCap)
    ? (promptsCap as Record<string, unknown>)
    : null;

  const resourcesCap = r.resources;
  const resourcesObj = resourcesCap && typeof resourcesCap === "object" && !Array.isArray(resourcesCap)
    ? (resourcesCap as Record<string, unknown>)
    : null;

  const experimentalRaw = r.experimental;
  const experimental: Record<string, Record<string, unknown>> =
    experimentalRaw && typeof experimentalRaw === "object" && !Array.isArray(experimentalRaw)
      ? (experimentalRaw as Record<string, Record<string, unknown>>)
      : {};

  return {
    supportsTools: toolsCap !== undefined && toolsCap !== null,
    toolsListChanged: toolsObj?.listChanged === true,
    supportsPrompts: promptsCap !== undefined && promptsCap !== null,
    promptsListChanged: promptsObj?.listChanged === true,
    supportsResources: resourcesCap !== undefined && resourcesCap !== null,
    resourcesSubscribe: resourcesObj?.subscribe === true,
    resourcesListChanged: resourcesObj?.listChanged === true,
    supportsLogging: r.logging !== undefined && r.logging !== null,
    experimental,
    _raw: r,
  };
}

// ── Auth normalization ────────────────────────────────────────────────────────

/**
 * Extract a human-readable provider hint from an OAuth authorization URL.
 * Maps well-known hostnames to brand names; falls back to the second-level domain.
 */
function extractAuthProviderHint(authUrl: string | null): string | null {
  if (!authUrl) return null;
  try {
    const url = new URL(authUrl);
    const host = url.hostname.toLowerCase();
    const patterns: [RegExp, string][] = [
      [/github/, "GitHub"],
      [/google/, "Google"],
      [/microsoft|azure|live\.com|microsoftonline/, "Microsoft"],
      [/slack/, "Slack"],
      [/linear/, "Linear"],
      [/notion/, "Notion"],
      [/atlassian|jira|confluence/, "Atlassian"],
      [/gitlab/, "GitLab"],
      [/bitbucket/, "Bitbucket"],
    ];
    for (const [pattern, name] of patterns) {
      if (pattern.test(host)) return name;
    }
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch {
    return null;
  }
}

// ── Lifecycle state derivation ────────────────────────────────────────────────
//
// Adapted from CloudflareBot mcp-lifecycle.ts deriveMcpLifecycleState().
// Uses textual pattern matching against the raw SDK state string so we are
// not coupled to a specific SDK version's state enum.

function deriveLifecycleState(
  rawSdkState: string | null | undefined,
  authUrl: string | null | undefined,
  error: string | null | undefined,
  discoveredItemCount: number,
  isInSdk: boolean
): McpServerLifecycleState {
  if (!isInSdk) return "disconnected";

  const state = (rawSdkState ?? "").toLowerCase();

  // Auth takes precedence over other state signals
  if (authUrl || /\bauth\b|oauth|awaiting.*authoriz/i.test(state)) {
    return "authenticating";
  }

  // Terminal errors
  if (/fail|error/i.test(state) && !/connect|discover/i.test(state)) {
    return "failed";
  }
  if (error && /fatal|terminal|permanent|unrecover/i.test(error)) {
    return "failed";
  }

  // Capability negotiation / handshaking.
  // SDK MCPConnectionState.CONNECTED ("connected") means the transport layer is
  // established but capability exchange has not started — map to "initializing".
  // The broader /init|negot|handshake|capabil/ pattern catches anything similar.
  if (/init|negot|handshake|capabil|\bconnected\b/i.test(state)) {
    return discoveredItemCount > 0 ? "ready" : "initializing";
  }

  // Tool / resource discovery pass
  if (/discover|warm|list/i.test(state)) {
    return "discovering";
  }

  // Ready-like states from SDK (excludes "connected" — handled above)
  if (/ready|operat/i.test(state)) {
    return discoveredItemCount > 0 ? "ready" : "degraded";
  }

  // Connecting states from SDK ("connect" matches "connecting" but not "connected")
  if (/connect|open|start/i.test(state)) {
    return discoveredItemCount > 0 ? "ready" : "connecting";
  }

  // Unknown state string but we do have tools → treat as ready
  if (discoveredItemCount > 0) return "ready";

  // Fall back: something is in the SDK but we can't classify it
  return "connecting";
}

// ── Item normalization helpers ────────────────────────────────────────────────

/**
 * Convert a raw SDK tool entry into a normalized DiscoveredMcpTool.
 * Returns null if the entry lacks a name (malformed).
 */
export function normalizeTool(
  raw: unknown,
  serverId: string,
  serverName: string
): DiscoveredMcpTool | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const name = str(r.name).trim();
  if (!name) return null;

  return {
    name,
    description: str(r.description),
    inputSchema:
      r.inputSchema && typeof r.inputSchema === "object" && !Array.isArray(r.inputSchema)
        ? (r.inputSchema as Record<string, unknown>)
        : null,
    annotations:
      r.annotations && typeof r.annotations === "object" && !Array.isArray(r.annotations)
        ? (r.annotations as Record<string, unknown>)
        : null,
    serverId,
    serverName,
  };
}

/**
 * Convert a raw SDK prompt argument into a normalized DiscoveredMcpPromptArg.
 * Returns null if the entry lacks a name.
 */
function normalizePromptArg(raw: unknown): DiscoveredMcpPromptArg | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name).trim();
  if (!name) return null;
  return {
    name,
    description: str(r.description),
    required: r.required === true,
  };
}

/**
 * Convert a raw SDK prompt entry into a normalized DiscoveredMcpPrompt.
 * Returns null if the entry lacks a name.
 */
export function normalizePrompt(
  raw: unknown,
  serverId: string,
  serverName: string
): DiscoveredMcpPrompt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const name = str(r.name).trim();
  if (!name) return null;

  const rawArgs = Array.isArray(r.arguments) ? r.arguments : [];
  const args = rawArgs
    .map((a) => normalizePromptArg(a))
    .filter((a): a is DiscoveredMcpPromptArg => a !== null);

  return {
    name,
    description: str(r.description),
    args,
    serverId,
    serverName,
  };
}

/**
 * Convert a raw SDK resource entry into a normalized DiscoveredMcpResource.
 * Returns null if the entry lacks a name.
 */
export function normalizeResource(
  raw: unknown,
  serverId: string,
  serverName: string
): DiscoveredMcpResource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const name = str(r.name).trim();
  if (!name) return null;

  return {
    name,
    description: str(r.description),
    uri: str(r.uri),
    uriTemplate: strOrNull(r.uriTemplate),
    mimeType: strOrNull(r.mimeType),
    serverId,
    serverName,
  };
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build a McpDiscoverySnapshot from the SDK's live state, persisted config,
 * and the in-memory runtime cache.
 *
 * - Each persisted server gets a DiscoveredMcpServer entry regardless of
 *   whether the SDK has a matching live connection.
 * - Disabled servers (enabled=false) appear with state="disconnected".
 * - The runtime cache is mutated in-place to record first-occurrence timestamps
 *   (connectedAt, discoveredAt, firstErrorAt) on state transitions.
 * - Tools, prompts, and resources from the SDK are normalized and annotated
 *   with the corresponding server name.
 * - All normalization is individually guarded so a malformed entry does not
 *   abort the rest of the snapshot.
 *
 * @param raw       The return value of getMcpServers() cast to RawSdkMcpState.
 * @param persisted Credential-free server configs (headers/token already stripped).
 * @param cache     In-memory runtime cache (mutated on state transitions).
 */
export function buildDiscoverySnapshot(
  raw: RawSdkMcpState,
  persisted: PersistedMcpServerSafe[],
  cache: Map<string, ServerRuntimeCache>
): McpDiscoverySnapshot {
  const now = new Date().toISOString();

  // Build bidirectional maps between SDK IDs and server names
  const sdkByName = new Map<string, { id: string; server: RawSdkServer }>();
  const nameById = new Map<string, string>();

  for (const [sdkId, server] of Object.entries(raw.servers ?? {})) {
    try {
      if (server?.name) {
        sdkByName.set(server.name, { id: sdkId, server });
        nameById.set(sdkId, server.name);
      }
    } catch {
      // Malformed SDK entry — skip without aborting the rest
    }
  }

  // State sets for transition detection
  const LIVE_STATES = new Set<McpServerLifecycleState>(["ready", "degraded", "discovering", "initializing"]);
  const ERROR_STATES = new Set<McpServerLifecycleState>(["failed"]);
  const RECONNECTING_STATES = new Set<McpServerLifecycleState>(["connecting", "disconnected"]);

  // Normalize each persisted server
  const servers: DiscoveredMcpServer[] = persisted.map((p): DiscoveredMcpServer => {
    try {
      // Disabled servers: return a minimal disconnected entry without querying the SDK.
      if (!p.enabled) {
        const cached = cache.get(p.id) ?? null;
        return {
          id: p.id,
          name: p.name,
          url: p.url,
          transport: p.transport,
          enabled: false,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          state: "disconnected",
          sdkServerId: null,
          instructions: null,
          capabilities: null,
          auth: { required: false, authUrl: null, providerHint: null },
          toolCount: 0,
          promptCount: 0,
          resourceCount: 0,
          error: null,
          firstErrorAt: null,
          connectedAt: cached?.connectedAt ?? null,
          discoveredAt: cached?.discoveredAt ?? null,
          _debug: { rawSdkState: null, rawCapabilities: null, rawServerUrl: null },
        };
      }

      const sdkInfo = sdkByName.get(p.name);
      const sdk = sdkInfo?.server ?? null;
      const sdkId = sdkInfo?.id ?? null;

      const tools = sdkId ? (raw.tools ?? []).filter((t) => t.serverId === sdkId) : [];
      const prompts = sdkId ? (raw.prompts ?? []).filter((pr) => pr.serverId === sdkId) : [];
      const resources = sdkId ? (raw.resources ?? []).filter((r) => r.serverId === sdkId) : [];

      const discoveredItemCount = tools.length + prompts.length + resources.length;

      const state = deriveLifecycleState(
        sdk?.state,
        sdk?.auth_url,
        sdk?.error,
        discoveredItemCount,
        !!sdkId
      );

      // ── Update runtime cache for transition timestamps ────────────────────
      let entry = cache.get(p.id);
      if (!entry) {
        entry = { prevState: null, connectedAt: null, discoveredAt: null, firstErrorAt: null };
        cache.set(p.id, entry);
      }

      const prevState = entry.prevState;

      // connectedAt: set once when first entering a live state
      if (LIVE_STATES.has(state) && (prevState === null || !LIVE_STATES.has(prevState))) {
        entry.connectedAt = now;
      }

      // discoveredAt: set once when items first appear
      if (discoveredItemCount > 0 && !entry.discoveredAt) {
        entry.discoveredAt = now;
      }

      // firstErrorAt: set on first transition into an error state; reset on reconnect
      if (ERROR_STATES.has(state) && (prevState === null || !ERROR_STATES.has(prevState))) {
        entry.firstErrorAt = now;
      } else if (RECONNECTING_STATES.has(state)) {
        entry.firstErrorAt = null;  // new connection attempt — clear prior error time
      }

      entry.prevState = state;
      // ── End cache update ─────────────────────────────────────────────────

      const capabilities = normalizeCapabilities(sdk?.capabilities ?? null);

      const authUrl = sdk?.auth_url ?? null;
      const auth: McpAuthMeta = {
        required: state === "authenticating",
        authUrl,
        providerHint: extractAuthProviderHint(authUrl),
      };

      return {
        id: p.id,
        name: p.name,
        url: p.url,
        transport: p.transport,
        enabled: true,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        state,
        sdkServerId: sdkId,
        instructions: strOrNull(sdk?.instructions),
        capabilities,
        auth,
        toolCount: tools.length,
        promptCount: prompts.length,
        resourceCount: resources.length,
        error: strOrNull(sdk?.error),
        firstErrorAt: entry.firstErrorAt,
        connectedAt: entry.connectedAt,
        discoveredAt: entry.discoveredAt,
        _debug: {
          rawSdkState: strOrNull(sdk?.state),
          rawCapabilities: sdk?.capabilities ?? null,
          rawServerUrl: strOrNull(sdk?.server_url),
        },
      };
    } catch (err) {
      // Malformed persisted entry — return a safe offline placeholder
      console.error("[EdgeClaw][mcpDiscovery] Failed to normalize server:", p.name, err);
      return {
        id: p.id,
        name: p.name,
        url: p.url,
        transport: p.transport,
        enabled: p.enabled,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        state: "offline",
        sdkServerId: null,
        instructions: null,
        capabilities: null,
        auth: { required: false, authUrl: null, providerHint: null },
        toolCount: 0,
        promptCount: 0,
        resourceCount: 0,
        error: err instanceof Error ? err.message : "Normalization error",
        firstErrorAt: now,
        connectedAt: null,
        discoveredAt: null,
        _debug: { rawSdkState: null, rawCapabilities: null, rawServerUrl: null },
      };
    }
  });

  // Normalize all discovered items across all servers
  const tools: DiscoveredMcpTool[] = (raw.tools ?? [])
    .map((t) => {
      try {
        return normalizeTool(t, t.serverId, nameById.get(t.serverId) ?? "");
      } catch {
        return null;
      }
    })
    .filter((t): t is DiscoveredMcpTool => t !== null);

  const prompts: DiscoveredMcpPrompt[] = (raw.prompts ?? [])
    .map((p) => {
      try {
        return normalizePrompt(p, p.serverId, nameById.get(p.serverId) ?? "");
      } catch {
        return null;
      }
    })
    .filter((p): p is DiscoveredMcpPrompt => p !== null);

  const resources: DiscoveredMcpResource[] = (raw.resources ?? [])
    .map((r) => {
      try {
        return normalizeResource(r, r.serverId, nameById.get(r.serverId) ?? "");
      } catch {
        return null;
      }
    })
    .filter((r): r is DiscoveredMcpResource => r !== null);

  return {
    servers,
    tools,
    prompts,
    resources,
    totalServers: servers.length,
    totalTools: tools.length,
    totalPrompts: prompts.length,
    totalResources: resources.length,
    snapshotAt: now,
  };
}

// ── Log-safe sanitizer ────────────────────────────────────────────────────────
//
// Adapted from CloudflareBot's sanitizeMcpServerForLogs().
// Strips auth URLs and tokens before any structured logging.

/**
 * Return a log-safe version of a DiscoveredMcpServer.
 * Redacts authUrl, debug raw fields, and error text that may contain URLs.
 */
export function sanitizeServerForLogs(
  server: DiscoveredMcpServer
): Omit<DiscoveredMcpServer, "auth" | "_debug"> & {
  auth: Pick<McpAuthMeta, "required" | "providerHint">;
  _debug: Pick<McpServerDebug, "rawSdkState">;
} {
  // Sanitize URL to origin only (no paths/tokens in query strings)
  let safeUrl = server.url;
  try {
    const u = new URL(server.url);
    safeUrl = `${u.protocol}//${u.host}`;
  } catch {
    safeUrl = "<url>";
  }

  return {
    ...server,
    url: safeUrl,
    error: server.error ? server.error.slice(0, 200) : null,
    auth: {
      required: server.auth.required,
      providerHint: server.auth.providerHint,
    },
    // _debug is narrowed to rawSdkState only — rawCapabilities and rawServerUrl
    // are stripped from log output to avoid leaking server internals.
    _debug: {
      rawSdkState: server._debug.rawSdkState,
    },
  };
}
