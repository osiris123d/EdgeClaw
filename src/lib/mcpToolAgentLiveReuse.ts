/**
 * ToolAgent MCP delegation: reuse MainAgent's live MCP SDK connection instead of calling
 * {@link ThinkMcpRestoreHost.addMcpServer} when discovery proves the server is ready and non-OAuth.
 */

import type { ToolSet } from "ai";
import type { PersistedMcpServer } from "./mcpDiscovery";

export type McpMirrorToolDescriptor = {
  description: string;
  jsonSchema: Record<string, unknown>;
};

/** True when ToolAgent should mirror parent's MCP tools and skip SDK restore for this row. */
export function shouldReuseLiveMcpSdkServer(server: PersistedMcpServer): boolean {
  if (!server.enabled) return false;
  const state = server.mcpRuntimeState ?? "";
  if (state !== "ready" && state !== "degraded") return false;
  const sid = server.mcpSdkServerId?.trim();
  if (!sid) return false;
  const tc = server.mcpToolCount ?? 0;
  if (tc <= 0) return false;
  if (server.authRequired === true) return false;
  return server.authRequired === false || server.authRequired === undefined;
}

export function partitionMcpServersForToolAgentSync(rows: PersistedMcpServer[]): {
  reuseLive: PersistedMcpServer[];
  restorePersisted: PersistedMcpServer[];
} {
  const reuseLive = rows.filter(shouldReuseLiveMcpSdkServer);
  const reuseKey = new Set(reuseLive.map((r) => r.id));
  const restorePersisted = rows.filter((r) => !reuseKey.has(r.id));
  return { reuseLive, restorePersisted };
}

/**
 * Snapshot MCP AI tool definitions from MainAgent (`mcp.getAITools()`) for mirrored relay names.
 */
export function buildMcpMirrorToolDescriptors(
  mcpAiTools: ToolSet,
  reuseRows: PersistedMcpServer[]
): Record<string, McpMirrorToolDescriptor> {
  const out: Record<string, McpMirrorToolDescriptor> = {};
  for (const row of reuseRows) {
    const sid = row.mcpSdkServerId?.trim();
    if (!sid) continue;
    for (const suffix of ["search", "execute"] as const) {
      const name = `tool_${sid}_${suffix}`;
      const def = mcpAiTools[name];
      if (!def || typeof def !== "object") continue;
      const description =
        typeof (def as { description?: string }).description === "string"
          ? (def as { description: string }).description
          : `MCP ${suffix} (live mirror via MainAgent)`;
      let jsonSchema: Record<string, unknown> = {};
      const rawSchema = (def as { inputSchema?: unknown }).inputSchema;
      if (rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema)) {
        try {
          jsonSchema = JSON.parse(JSON.stringify(rawSchema)) as Record<string, unknown>;
        } catch {
          jsonSchema = {};
        }
      }
      out[name] = { description, jsonSchema };
    }
  }
  return out;
}
