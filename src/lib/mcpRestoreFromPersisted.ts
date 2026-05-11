/**
 * Restore MCP SDK connections from {@link PersistedMcpServer} rows in Think `configure()` storage.
 * Shared by MainAgent startup and ToolAgent delegation mirror sync.
 */

import {
  migratePersistedMcpServer,
  stripPersistedMcpServerOAuthRoutingFields,
  type PersistedMcpServer,
} from "./mcpDiscovery";

export type ThinkMcpRestoreHost = {
  getConfig(): unknown;
  configure(cfg: Record<string, unknown>): Promise<void>;
  addMcpServer(
    name: string,
    url: string,
    options?: Record<string, unknown>
  ): Promise<{ state?: string }>;
};

/** Prefix for ToolAgent-visible MCP bootstrap failures (delegation fail-fast). */
export const TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX = "ToolAgent MCP restore failed:";

export function formatToolAgentMcpBootstrapError(message: string): string {
  const m = typeof message === "string" ? message.trim() : String(message ?? "").trim();
  return `${TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX} ${m}`;
}

export type McpRestoreFailure = { name: string; message: string };

export type RestorePersistedMcpServersResult = {
  failures: McpRestoreFailure[];
};

/**
 * Whether Agents SDK options should include OAuth callback routing (`callbackHost`, etc.).
 * When false, omit those fields so streamable-http restore does not enter OAuth bootstrap
 * (e.g. Cloudflare Code Mode ready / auth.required === false).
 *
 * Order matters: {@link PersistedMcpServer.authRequired} === false wins over persisted
 * `callbackHost` / `agentsPrefix` leftovers. Live-ready servers with tools also skip OAuth routing.
 */
export function mcpRestoreShouldIncludeOAuthRouting(server: PersistedMcpServer): boolean {
  if (server.authRequired === true) return true;
  if (server.authRequired === false) return false;

  const state = server.mcpRuntimeState ?? "";
  const toolCount = server.mcpToolCount ?? 0;
  if ((state === "ready" || state === "degraded") && toolCount > 0 && server.authRequired !== true) {
    return false;
  }

  if (server.authUrl?.trim()) return true;
  if (server.callbackHost?.trim() || server.callbackPath?.trim() || server.agentsPrefix?.trim()) {
    return true;
  }
  return false;
}

function transportPayload(server: PersistedMcpServer): Record<string, unknown> {
  const persistedHeaders =
    server.headers ?? (server.token ? { Authorization: `Bearer ${server.token}` } : undefined);

  return {
    ...(persistedHeaders ? { headers: persistedHeaders } : {}),
    ...(server.transport ? { type: server.transport } : {}),
  };
}

/** SDK options with OAuth routing only when {@link mcpRestoreShouldIncludeOAuthRouting} is true. */
export function buildAddMcpServerSdkOptions(server: PersistedMcpServer): Record<string, unknown> {
  const routing = mcpRestoreShouldIncludeOAuthRouting(server);
  const row = routing ? server : stripPersistedMcpServerOAuthRoutingFields(server);

  const sdkOptions: Record<string, unknown> = {
    transport: transportPayload(row),
  };

  if (!routing) {
    return sdkOptions;
  }

  if (row.callbackHost?.trim()) {
    sdkOptions.callbackHost = row.callbackHost.trim();
  }
  if (row.callbackPath?.trim()) {
    sdkOptions.callbackPath = row.callbackPath.trim();
  }
  if (row.agentsPrefix?.trim()) {
    sdkOptions.agentsPrefix = row.agentsPrefix.trim();
  }

  return sdkOptions;
}

/** Same transport/headers as {@link buildAddMcpServerSdkOptions} but never OAuth callback fields. */
export function buildAddMcpServerSdkOptionsWithoutOAuthRouting(
  server: PersistedMcpServer
): Record<string, unknown> {
  return {
    transport: transportPayload(server),
  };
}

function oauthSdkOptionsIncludeRouting(opts: Record<string, unknown>): boolean {
  return Boolean(
    opts.callbackHost ||
      opts.callbackPath ||
      opts.agentsPrefix ||
      opts.redirectUrl ||
      opts.authProvider ||
      opts.authUrl ||
      (opts.oauth && typeof opts.oauth === "object")
  );
}

function isMissingAuthUrlOAuthError(message: string): boolean {
  return /OAuth configuration incomplete:\s*missing authUrl/i.test(message);
}

export type RestorePersistedMcpServersOptions = {
  /** Skip SDK restore for servers satisfied via MainAgent live MCP mirror (no second `addMcpServer`). */
  skipRestore?: (server: PersistedMcpServer) => boolean;
};

/**
 * Reads `mcpServers` from the agent's persisted config and calls `addMcpServer` for each enabled row.
 * Skips when the list is empty. Logs per-server failures; returns structured failures for ToolAgent.
 */
export async function restorePersistedMcpServersFromConfig(
  host: ThinkMcpRestoreHost,
  options?: RestorePersistedMcpServersOptions
): Promise<RestorePersistedMcpServersResult> {
  const failures: McpRestoreFailure[] = [];
  const cfg = (host.getConfig() ?? {}) as Record<string, unknown>;
  const list = cfg.mcpServers;
  if (!Array.isArray(list) || list.length === 0) {
    return { failures };
  }

  const servers: PersistedMcpServer[] = [];
  for (const raw of list) {
    try {
      servers.push(migratePersistedMcpServer(raw));
    } catch (err) {
      console.warn("[EdgeClaw][mcp] Skipping malformed persisted server entry during restore:", err);
    }
  }

  const enabledServers = servers.filter((s) => s.enabled);
  const disabledCount = servers.length - enabledServers.length;
  const toRestore = enabledServers.filter((s) => !(options?.skipRestore?.(s) ?? false));
  const skippedLiveReuse = enabledServers.length - toRestore.length;
  console.log(
    `[EdgeClaw][mcp] Restoring ${toRestore.length} enabled MCP server(s)` +
      (skippedLiveReuse > 0 ? ` (${skippedLiveReuse} live-reuse skip)` : "") +
      (disabledCount > 0 ? ` (${disabledCount} disabled, skipped)` : "") +
      "."
  );

  for (const server of toRestore) {
    try {
      let sdkOptions = buildAddMcpServerSdkOptions(server);
      let result: { state?: string };
      try {
        result = await host.addMcpServer(server.name, server.url, sdkOptions);
      } catch (errFirst) {
        const msgFirst = errFirst instanceof Error ? errFirst.message : String(errFirst);
        if (
          isMissingAuthUrlOAuthError(msgFirst) &&
          oauthSdkOptionsIncludeRouting(sdkOptions) &&
          server.authRequired !== true
        ) {
          console.warn(
            `[EdgeClaw][mcp] Server "${server.name}" restore hit OAuth authUrl error with OAuth routing; ` +
              `retrying without callback routing (authRequired=${String(server.authRequired)})`
          );
          sdkOptions = buildAddMcpServerSdkOptionsWithoutOAuthRouting(server);
          result = await host.addMcpServer(server.name, server.url, sdkOptions);
        } else {
          throw errFirst;
        }
      }

      if (result.state === "authenticating") {
        console.log(
          `[EdgeClaw][mcp] Server "${server.name}" needs OAuth re-authorization after restore. ` +
            `User must authorize via the Settings panel.`
        );
      } else {
        console.log(`[EdgeClaw][mcp] Restored server "${server.name}" (state=${result.state}).`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[EdgeClaw][mcp] Failed to restore server "${server.name}":`, err);
      failures.push({ name: server.name, message });
    }
  }

  return { failures };
}
