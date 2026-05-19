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

export interface McpMirrorValidationIssue {
  serverId: string;
  serverName: string;
  sdkServerId: string;
  missingToolNames: string[];
}

export interface McpMirrorNameResolution {
  /** Actual search tool name or null if not found */
  search: string | null;
  /** Actual execute tool name or null if not found */
  execute: string | null;
  /** Resolution strategy used: 'exact' | 'normalized' | 'not_found' */
  strategy: "exact" | "normalized" | "not_found";
}

/**
 * Resolve actual MCP mirror tool names from mcpAiTools, handling sanitized/normalized sdkServerId.
 * AI SDK tool names may sanitize characters like hyphens from the raw sdkServerId.
 * This function tries multiple strategies to find the actual tool names.
 */
export function resolveMcpMirrorToolNames(
  mcpAiTools: ToolSet | undefined,
  sdkServerId: string
): McpMirrorNameResolution {
  if (!mcpAiTools || !sdkServerId?.trim()) {
    return { search: null, execute: null, strategy: "not_found" };
  }

  const sid = sdkServerId.trim();

  // Strategy 1: Try exact match (raw sdkServerId as-is)
  const exactSearch = `tool_${sid}_search`;
  const exactExecute = `tool_${sid}_execute`;
  if (exactSearch in mcpAiTools && exactExecute in mcpAiTools) {
    return { search: exactSearch, execute: exactExecute, strategy: "exact" };
  }

  // Strategy 2: Try normalized match (remove non-alphanumeric, keep only alphanumeric and underscore)
  const normalized = sid.replace(/[^a-zA-Z0-9_]/g, "");
  if (normalized !== sid) {
    const normalizedSearch = `tool_${normalized}_search`;
    const normalizedExecute = `tool_${normalized}_execute`;
    if (normalizedSearch in mcpAiTools && normalizedExecute in mcpAiTools) {
      return { search: normalizedSearch, execute: normalizedExecute, strategy: "normalized" };
    }
  }

  // Strategy 3: Scan tool names for matching suffix pattern if normalization yielded results
  // This is a fallback for complex transformations we haven't accounted for
  const allToolNames = Object.keys(mcpAiTools ?? {});
  const normalizedForSearch = normalized || sid.replace(/[^a-zA-Z0-9]/g, "");

  const searchCandidates = allToolNames.filter(
    (name) =>
      name.endsWith("_search") &&
      (name.includes(normalizedForSearch) || name.includes(sid.toLowerCase()))
  );
  const executeCandidates = allToolNames.filter(
    (name) =>
      name.endsWith("_execute") &&
      (name.includes(normalizedForSearch) || name.includes(sid.toLowerCase()))
  );

  if (searchCandidates.length > 0 && executeCandidates.length > 0) {
    return {
      search: searchCandidates[0]!,
      execute: executeCandidates[0]!,
      strategy: "normalized",
    };
  }

  return { search: null, execute: null, strategy: "not_found" };
}

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
 * Uses resolver to find actual tool names, accounting for sanitized/normalized sdkServerId.
 */
export function buildMcpMirrorToolDescriptors(
  mcpAiTools: ToolSet | undefined,
  reuseRows: PersistedMcpServer[]
): Record<string, McpMirrorToolDescriptor> {
  const out: Record<string, McpMirrorToolDescriptor> = {};
  for (const row of reuseRows) {
    const sid = row.mcpSdkServerId?.trim();
    if (!sid) continue;

    // Resolve actual tool names using generic strategy
    const resolved = resolveMcpMirrorToolNames(mcpAiTools, sid);
    if (resolved.strategy === "not_found") {
      // Log that we couldn't resolve tool names
      if (isCodemodeWireDebugEnabled()) {
        console.log(
          `[EdgeClaw][mcp-mirror-resolve] server=${JSON.stringify(row.name)} ` +
            `sdkServerId=${sid} search=missing execute=missing strategy=not_found`
        );
      }
      continue;
    }

    // Log resolution with strategy
    if (isCodemodeWireDebugEnabled()) {
      console.log(
        `[EdgeClaw][mcp-mirror-resolve] server=${JSON.stringify(row.name)} ` +
          `sdkServerId=${sid} search=${resolved.search ?? "missing"} ` +
          `execute=${resolved.execute ?? "missing"} strategy=${resolved.strategy}`
      );
    }

    // Add descriptors for the actual resolved tool names
    for (const [suffix, toolName] of [
      ["search", resolved.search],
      ["execute", resolved.execute],
    ] as const) {
      if (!toolName) continue;
      const def = mcpAiTools?.[toolName];
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
      out[toolName] = { description, jsonSchema };
    }
  }
  return out;
}

/** Resolves expected mirrored wrapper names for a live-reuse MCP server row. */
export function expectedMcpMirrorToolNamesForServer(args: {
  mcpAiTools: ToolSet | undefined;
  server: PersistedMcpServer;
}): string[] {
  const sid = args.server.mcpSdkServerId?.trim();
  if (!sid) return [];
  const resolved = resolveMcpMirrorToolNames(args.mcpAiTools, sid);
  if (resolved.strategy === "not_found") return [];
  const result: string[] = [];
  if (resolved.search) result.push(resolved.search);
  if (resolved.execute) result.push(resolved.execute);
  return result;
}

/**
 * Validates that live-reuse rows have the required mirrored wrapper descriptors.
 * ToolAgent must not run inference if any reuse row is missing required mirror wrappers.
 */
export function findMissingMcpMirrorDescriptors(args: {
  reuseRows: PersistedMcpServer[];
  descriptors: Record<string, McpMirrorToolDescriptor>;
  mcpAiTools?: ToolSet;
}): McpMirrorValidationIssue[] {
  const issues: McpMirrorValidationIssue[] = [];
  const descriptorKeys = new Set(Object.keys(args.descriptors ?? {}));
  for (const row of args.reuseRows) {
    const sdkServerId = row.mcpSdkServerId?.trim();
    if (!sdkServerId) continue;
    const expected = expectedMcpMirrorToolNamesForServer({
      mcpAiTools: args.mcpAiTools,
      server: row,
    });
    const missingToolNames = expected.filter((name) => !descriptorKeys.has(name));
    if (missingToolNames.length > 0) {
      issues.push({
        serverId: row.id,
        serverName: row.name,
        sdkServerId,
        missingToolNames,
      });
    }
  }
  return issues;
}

/** Checks if wire-debug mode is enabled for diagnostic logging. */
function isCodemodeWireDebugEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.["CODEMODE_WIRE_DEBUG"] === "true";
}
