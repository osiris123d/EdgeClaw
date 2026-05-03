/**
 * Inline “checkpoint” when an MCP tool step failed and re-authentication may help.
 * UI explains system state; buttons repair; copy avoids vague “MCP failed” only.
 */
import { useCallback, useEffect, useState } from "react";
import type { McpDiscoverySnapshot, DiscoveredMcpTool } from "../../types/mcp";
import { getMcpState, reconnectMcpServer } from "../../lib/mcpApi";
import { openOAuthPopup, type OAuthPopupResult } from "../../lib/mcpOAuth";
import type { McpReauthCalloutData } from "../../types";

type AuthReason = "expired" | "forbidden" | "unknown";

function classifyMcpError(text: string): AuthReason {
  const t = text.toLowerCase();
  if (/\b403\b|forbidden|permission denied|insufficient|scope|not allowed to|additional permission/i.test(t)) {
    return "forbidden";
  }
  if (/\b401\b|unauthor|expired|invalid.?token|oauth|sign in|re-?auth|credential/i.test(t)) {
    return "expired";
  }
  return "unknown";
}

function formatToolNameFallback(name: string | undefined): string {
  if (!name) return "MCP";
  if (name.includes(" ") || name.includes(".")) return name;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function findServerForTool(
  snap: McpDiscoverySnapshot,
  toolName: string | undefined
): { server: (typeof snap.servers)[0]; tool: DiscoveredMcpTool } | { server: (typeof snap.servers)[0]; tool: null } | null {
  const tool = toolName
    ? snap.tools.find((x) => x.name === toolName) ?? null
    : null;
  if (tool) {
    const server = snap.servers.find((s) => s.id === tool.serverId) ?? null;
    if (server) {
      return { server, tool };
    }
  }
  const needAuth = snap.servers.find((s) => s.state === "authenticating" && s.auth.authUrl);
  if (needAuth) {
    return { server: needAuth, tool: null };
  }
  return null;
}

export interface McpReauthCalloutProps {
  data: McpReauthCalloutData;
  onOpenSettings: () => void;
  onRetryLastUser: () => void;
}

export function McpReauthCallout({ data, onOpenSettings, onRetryLastUser }: McpReauthCalloutProps) {
  const [snapshot, setSnapshot] = useState<McpDiscoverySnapshot | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const reason = classifyMcpError(data.errorText);

  const load = useCallback(() => {
    getMcpState()
      .then(setSnapshot)
      .catch(() => {
        setSnapshot(null);
        setStatusMsg("Couldn’t load MCP status — try Settings.");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const match = snapshot ? findServerForTool(snapshot, data.toolName) : null;
  const serverLabel = match?.server.name ?? formatToolNameFallback(data.toolName);
  const authUrl = match?.server.auth?.authUrl ?? null;
  const serverState = match?.server.state;

  const headline =
    reason === "forbidden"
      ? "Additional permission needed"
      : reason === "expired"
        ? "Connection expired"
        : "Reconnect to continue";

  const sub =
    reason === "forbidden"
      ? `You're signed in, but this action needs additional permission for ${serverLabel}.`
      : reason === "expired"
        ? `Your ${serverLabel} session is no longer authenticated. Reconnect to continue this step.`
        : `We couldn't confirm your ${serverLabel} connection. Reconnect or pick another source to continue.`;

  const handleReconnect = useCallback(() => {
    if (!match?.server?.name) {
      onOpenSettings();
      return;
    }
    setStatusMsg(null);
    setReconnecting(true);
    const name = match.server.name;
    reconnectMcpServer(name)
      .then((next) => {
        setSnapshot(next);
        const srv = next.servers.find((s) => s.name === name);
        if (srv?.state === "authenticating" && srv.auth.authUrl) {
          openOAuthPopup(srv.auth.authUrl, (r: OAuthPopupResult) => {
            if (r.success) {
              getMcpState().then(setSnapshot).catch(() => {});
            }
            setStatusMsg(
              r.success
                ? `Reconnected to ${serverLabel}. Ready to resume your last action.`
                : `Reconnection didn’t complete. We couldn’t verify access to ${serverLabel} yet. Please try signing in again or choose another source.`
            );
            setReconnecting(false);
          });
        } else {
          setStatusMsg(`Reconnected to ${serverLabel}. Ready to resume your last action.`);
          setReconnecting(false);
        }
      })
      .catch((e) => {
        setStatusMsg(
          e instanceof Error ? e.message : "Reconnection failed — use Settings to retry."
        );
        setReconnecting(false);
      });
  }, [match?.server, onOpenSettings, serverLabel]);

  const openAuth = useCallback(() => {
    if (!authUrl) {
      onOpenSettings();
      return;
    }
    setStatusMsg(null);
    openOAuthPopup(authUrl, (r) => {
      if (r.success) {
        getMcpState().then(setSnapshot).catch(() => {});
        setStatusMsg(`Reconnected to ${serverLabel}. Ready to resume your last action.`);
      } else {
        setStatusMsg(
          `Reconnection didn’t complete. We couldn’t verify access to ${serverLabel} yet. Please try signing in again or choose another source.`
        );
      }
    });
  }, [authUrl, onOpenSettings, serverLabel]);

  return (
    <div className="mcp-reauth-callout" role="status">
      <p className="mcp-reauth-title">{headline}</p>
      <p className="mcp-reauth-body muted">{sub}</p>
      {serverState === "failed" && match?.server.error && (
        <p className="mcp-reauth-note muted">{match.server.error}</p>
      )}
      <div className="mcp-reauth-actions">
        <button
          type="button"
          className="btn-header-secondary"
          disabled={reconnecting}
          onClick={handleReconnect}
        >
          {reconnecting ? "Reconnecting…" : `Reconnect ${serverLabel}`}
        </button>
        {authUrl && (
          <button type="button" className="btn-header-secondary" onClick={openAuth} disabled={reconnecting}>
            Sign in again
          </button>
        )}
        <button type="button" className="btn-header-secondary" onClick={onRetryLastUser} disabled={reconnecting}>
          Retry last step
        </button>
        <button type="button" className="mcp-reauth-linkish" onClick={onOpenSettings}>
          Use another source (Settings)
        </button>
      </div>
      {statusMsg && <p className="mcp-reauth-status muted" aria-live="polite">{statusMsg}</p>}
    </div>
  );
}
