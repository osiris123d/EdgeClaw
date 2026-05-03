import type { McpDiscoverySnapshot, McpServerLifecycleState } from "../types/mcp";

export type McpHeaderPillClass =
  | "mcp-health-off"
  | "mcp-health-none"
  | "mcp-health-ok"
  | "mcp-health-auth"
  | "mcp-health-error"
  | "mcp-health-progress";

export interface McpHeaderPill {
  key: string;
  label: string;
  className: McpHeaderPillClass;
  title: string;
}

const BAD = (s: McpServerLifecycleState) =>
  s === "failed" || s === "offline";

const NEEDS_AUTH: McpServerLifecycleState = "authenticating";

const IN_FLIGHT = (s: McpServerLifecycleState) =>
  s === "connecting" ||
  s === "initializing" ||
  s === "discovering" ||
  s === "disconnected";

const SETTLED = (s: McpServerLifecycleState) => s === "ready" || s === "degraded";

/**
 * Map MCP discovery snapshot to a single header “pill” for the chat bar.
 * Worst server wins: failed/offline > authenticating > in-flight > all ready.
 */
export function computeMcpHeaderPill(
  enableMcp: boolean,
  snapshot: McpDiscoverySnapshot | null,
  load: "loading" | "ok" | "error"
): McpHeaderPill {
  if (!enableMcp) {
    return {
      key: "off",
      label: "MCP: Off",
      className: "mcp-health-off",
      title: "MCP is disabled. Enable it in Settings to use Model Context Protocol servers.",
    };
  }

  if (load === "loading") {
    return {
      key: "load",
      label: "MCP: ···",
      className: "mcp-health-progress",
      title: "Loading MCP status…",
    };
  }

  if (load === "error") {
    return {
      key: "unavailable",
      label: "MCP: Unavailable",
      className: "mcp-health-error",
      title: "Could not load MCP status. Check the network or try again from Settings.",
    };
  }

  if (!snapshot) {
    return {
      key: "load",
      label: "MCP: ···",
      className: "mcp-health-progress",
      title: "Loading MCP status…",
    };
  }

  const { servers } = snapshot;

  if (servers.length === 0) {
    return {
      key: "empty",
      label: "MCP: None",
      className: "mcp-health-none",
      title: "No MCP servers are configured. Add a server in Settings.",
    };
  }

  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) {
    return {
      key: "alldisabled",
      label: "MCP: None",
      className: "mcp-health-none",
      title: "All MCP servers are disabled. Turn them on in Settings.",
    };
  }

  if (enabled.some((s) => BAD(s.state))) {
    const bad = enabled.filter((s) => BAD(s.state));
    const names = bad.map((s) => s.name).join(", ");
    return {
      key: "bad",
      label: "MCP: Error",
      className: "mcp-health-error",
      title: `One or more MCP servers are not available (${names}). Check Settings to reconnect or fix the configuration.`,
    };
  }

  if (enabled.some((s) => s.state === NEEDS_AUTH)) {
    const need = enabled.find((s) => s.state === NEEDS_AUTH)!;
    return {
      key: "auth",
      label: "MCP: Sign in",
      className: "mcp-health-auth",
      title: `“${need.name}” needs re-authentication. Open Settings, then Sign in for that server.`,
    };
  }

  if (enabled.some((s) => IN_FLIGHT(s.state))) {
    return {
      key: "sync",
      label: "MCP: Starting…",
      className: "mcp-health-progress",
      title: "MCP server(s) are still connecting or discovering tools.",
    };
  }

  if (enabled.every((s) => SETTLED(s.state))) {
    return {
      key: "ok",
      label: "MCP: Ready",
      className: "mcp-health-ok",
      title: "All enabled MCP servers are connected and available to the agent.",
    };
  }

  return {
    key: "unknown",
    label: "MCP: Check",
    className: "mcp-health-error",
    title: "MCP is in an unexpected state. See Settings for details.",
  };
}
