/**
 * Frontend MCP types.
 *
 * Mirrors the normalized shapes from src/lib/mcpDiscovery.ts and
 * src/api/mcpRoutes.ts.  Keep in sync manually — no shared import
 * across the worker/frontend boundary.
 */

// ── Transport ──────────────────────────────────────────────────────────────────
//
// CF_Truth only connects to MCP servers via https:// URLs.  Cloudflare's
// binding/RPC transport for direct worker-to-worker MCP is intentionally absent
// — no McpBinding is declared in wrangler.jsonc.
//
//   "streamable-http"  Recommended default.  Stateful HTTP/SSE, OAuth-capable.
//   "sse"              Legacy.  Plain HTTP GET SSE.  Deprecated by the MCP spec.
//   "auto"             SDK auto-detect.  Kept for persisted backward compat only.

export type McpTransport = "streamable-http" | "sse" | "auto";

/** Human-readable labels shown in the transport select. */
export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  "streamable-http": "Streamable HTTP",
  "sse":             "Legacy SSE",
  "auto":            "Auto-detect",
};

/** Inline advisory shown below the add-server bar when a non-default transport is chosen. */
export const MCP_TRANSPORT_ADVISORY: Partial<Record<McpTransport, string>> = {
  "sse":
    "Legacy SSE is deprecated. Use only if the server does not support Streamable HTTP.",
  "auto":
    "Auto-detect tries Streamable HTTP first and falls back to SSE on 4xx responses. " +
    "Connection failures in auto mode produce non-specific errors — prefer an explicit transport.",
};

// ── Lifecycle state ────────────────────────────────────────────────────────────

/**
 * Richer state machine derived from raw SDK state + evidence.
 * See mcpDiscovery.ts deriveLifecycleState() for derivation rules.
 */
export type McpServerLifecycleState =
  | "disconnected"   // persisted but no SDK connection yet
  | "connecting"     // SDK establishing connection
  | "initializing"   // capability negotiation in progress
  | "authenticating" // waiting for OAuth authorization
  | "discovering"    // loading tool/prompt/resource lists
  | "ready"          // connected, items available
  | "degraded"       // connected, but server returned no items
  | "failed"         // SDK reported unrecoverable error
  | "offline";       // previously seen, now absent

// ── Capabilities ───────────────────────────────────────────────────────────────

export interface McpServerCapabilities {
  supportsTools: boolean;
  toolsListChanged: boolean;
  supportsPrompts: boolean;
  promptsListChanged: boolean;
  supportsResources: boolean;
  resourcesSubscribe: boolean;
  resourcesListChanged: boolean;
  supportsLogging: boolean;
  experimental: Record<string, Record<string, unknown>>;
  /** Raw capabilities object — for debug display only. */
  _raw: Record<string, unknown>;
}

// ── Auth metadata ──────────────────────────────────────────────────────────────

export interface McpAuthMeta {
  required: boolean;
  authUrl: string | null;
  /** Brand name hint extracted from authUrl (e.g. "GitHub", "Google"). */
  providerHint: string | null;
}

// ── Debug fields ───────────────────────────────────────────────────────────────

export interface McpServerDebug {
  rawSdkState: string | null;
  rawCapabilities: Record<string, unknown> | null;
  rawServerUrl: string | null;
}

// ── Discovered items ───────────────────────────────────────────────────────────

export interface DiscoveredMcpTool {
  name: string;
  /** Empty string when server did not provide a description. */
  description: string;
  /** JSON Schema for the tool's input parameters. Null for legacy servers. */
  inputSchema: Record<string, unknown> | null;
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
  /** Arguments the caller can pass when invoking this prompt. */
  args: DiscoveredMcpPromptArg[];
  serverId: string;
  serverName: string;
}

export interface DiscoveredMcpResource {
  name: string;
  description: string;
  uri: string;
  uriTemplate: string | null;
  mimeType: string | null;
  serverId: string;
  serverName: string;
}

// ── Server entry ───────────────────────────────────────────────────────────────
//
// Persisted fields (stable, safe to display):
//   id, name, url, transport, enabled, createdAt, updatedAt
//
// Runtime fields (rebuilt on every snapshot — not stored in DO SQLite):
//   state, sdkServerId, instructions, capabilities, auth,
//   toolCount, promptCount, resourceCount, error,
//   firstErrorAt, connectedAt, discoveredAt, _debug

export interface DiscoveredMcpServer {
  // ── Persisted identity ──────────────────────────────────────────────────
  /** Stable UUID generated at creation. Safe React list key. */
  id: string;
  /** User-assigned display name. */
  name: string;
  url: string;
  transport: McpTransport;
  /** When false: configured but deliberately disconnected. */
  enabled: boolean;
  /** ISO timestamp when this config was first created. */
  createdAt: string;
  /** ISO timestamp when this config was last modified (not on reconnect). */
  updatedAt: string;

  // ── Runtime connection state ────────────────────────────────────────────
  state: McpServerLifecycleState;
  sdkServerId: string | null;

  // ── Runtime discovered metadata ─────────────────────────────────────────
  instructions: string | null;
  capabilities: McpServerCapabilities | null;
  /** authUrl is transient OAuth handshake state — never persisted. */
  auth: McpAuthMeta;

  // ── Runtime discovery counts ────────────────────────────────────────────
  toolCount: number;
  promptCount: number;
  resourceCount: number;

  // ── Runtime error state ─────────────────────────────────────────────────
  error: string | null;
  /** ISO timestamp of first error transition (null when healthy). */
  firstErrorAt: string | null;

  // ── Runtime transition timestamps ───────────────────────────────────────
  /** ISO timestamp when first connected within current DO lifetime. */
  connectedAt: string | null;
  /** ISO timestamp when items were first discovered within current DO lifetime. */
  discoveredAt: string | null;

  // ── Debug / raw ─────────────────────────────────────────────────────────
  _debug: McpServerDebug;
}

// ── Full snapshot (API response shape) ────────────────────────────────────────

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

// ── Add-server request ─────────────────────────────────────────────────────────

export interface McpAddServerRequest {
  name: string;
  url: string;
  transport?: McpTransport;
  /**
   * Arbitrary HTTP headers forwarded to the server on every SDK request.
   * Common values: { Authorization: "Bearer <token>" }, CF Access headers, etc.
   * Stored server-side only — never returned in discovery snapshots.
   */
  headers?: Record<string, string>;
  /**
   * @deprecated Use headers: { Authorization: "Bearer <token>" } instead.
   * Accepted for backward compatibility.
   */
  token?: string;
}

// ── UI page state ──────────────────────────────────────────────────────────────

export interface McpPageState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  successMessage: string | null;
  snapshot: McpDiscoverySnapshot | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** States where the server is live and usable (tools injected into turns). */
export const MCP_LIVE_STATES: McpServerLifecycleState[] = ["ready", "degraded"];

/** States where the user should take action (authorize or reconnect). */
export const MCP_ACTION_STATES: McpServerLifecycleState[] = ["authenticating", "failed", "offline"];

/** Human-readable labels for lifecycle states. */
export const MCP_STATE_LABELS: Record<McpServerLifecycleState, string> = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  initializing: "Initializing…",
  authenticating: "Auth needed",
  discovering: "Discovering…",
  ready: "Ready",
  degraded: "Connected (no items)",
  failed: "Failed",
  offline: "Offline",
};
