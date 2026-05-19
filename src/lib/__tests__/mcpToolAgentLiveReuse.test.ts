/**
 * ToolAgent live MCP SDK reuse (mirror vs restore) — Node-safe unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import {
  buildMcpMirrorToolDescriptors,
  expectedMcpMirrorToolNamesForServer,
  findMissingMcpMirrorDescriptors,
  shouldReuseLiveMcpSdkServer,
  resolveMcpMirrorToolNames,
} from "../mcpToolAgentLiveReuse";
import { migratePersistedMcpServer } from "../mcpDiscovery";

const baseRow = {
  id: "550e8400-e29b-41d4-a716-446655440700",
  name: "Cloudflare Code Mode",
  url: "https://mcp.cloudflare.com/mcp",
  transport: "streamable-http" as const,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

test("shouldReuseLiveMcpSdkServer: ready + sdk id + tools + auth.required false (stale OAuth fields OK)", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    callbackHost: "https://stale-callback.example",
    authUrl: "https://stale-oauth.example/authorize",
    auth: { required: false },
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), true);
});

test("shouldReuseLiveMcpSdkServer: degraded state qualifies", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "degraded",
    mcpToolCount: 1,
    authRequired: false,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), true);
});

test("shouldReuseLiveMcpSdkServer: authRequired true → no reuse", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: true,
    authUrl: "https://oauth.example/authorize",
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);
});

test("shouldReuseLiveMcpSdkServer: missing sdk id → no reuse", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);
});

test("shouldReuseLiveMcpSdkServer: toolCount 0 → no reuse", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 0,
    authRequired: false,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);
});

test("shouldReuseLiveMcpSdkServer: disabled row → no reuse", () => {
  const row = migratePersistedMcpServer({
    ...baseRow,
    enabled: false,
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);
});

test("resolveMcpMirrorToolNames: exact match with alphanumeric sdkServerId", () => {
  const mcpAiTools = {
    tool_WB0fsUJK_search: { description: "Search" },
    tool_WB0fsUJK_execute: { description: "Execute" },
  } as unknown as ToolSet;
  const resolved = resolveMcpMirrorToolNames(mcpAiTools, "WB0fsUJK");
  assert.equal(resolved.search, "tool_WB0fsUJK_search");
  assert.equal(resolved.execute, "tool_WB0fsUJK_execute");
  assert.equal(resolved.strategy, "exact");
});

test("resolveMcpMirrorToolNames: normalized match when hyphen is removed (AzWW3-1H → AzWW31H)", () => {
  const mcpAiTools = {
    tool_AzWW31H_search: { description: "Search" },
    tool_AzWW31H_execute: { description: "Execute" },
  } as unknown as ToolSet;
  const resolved = resolveMcpMirrorToolNames(mcpAiTools, "AzWW3-1H");
  assert.equal(resolved.search, "tool_AzWW31H_search");
  assert.equal(resolved.execute, "tool_AzWW31H_execute");
  assert.equal(resolved.strategy, "normalized");
});

test("resolveMcpMirrorToolNames: not found when neither exact nor normalized exists", () => {
  const mcpAiTools = {
    tool_SomeOther_search: { description: "Search" },
    tool_SomeOther_execute: { description: "Execute" },
  } as unknown as ToolSet;
  const resolved = resolveMcpMirrorToolNames(mcpAiTools, "AzWW3-1H");
  assert.equal(resolved.search, null);
  assert.equal(resolved.execute, null);
  assert.equal(resolved.strategy, "not_found");
});

test("resolveMcpMirrorToolNames: empty/undefined mcpAiTools", () => {
  const resolved = resolveMcpMirrorToolNames(undefined, "WB0fsUJK");
  assert.equal(resolved.search, null);
  assert.equal(resolved.execute, null);
  assert.equal(resolved.strategy, "not_found");
});

test("buildMcpMirrorToolDescriptors: copies search/execute from parent mcp.getAITools() with exact match", () => {
  const mcpAiTools = {
    tool_WB0fsUJK_search: {
      description: "Search OpenAPI",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    tool_WB0fsUJK_execute: {
      description: "Execute",
      inputSchema: { type: "object" },
    },
  } as unknown as ToolSet;

  const reuseRows = [
    migratePersistedMcpServer({
      ...baseRow,
      mcpSdkServerId: "WB0fsUJK",
      mcpRuntimeState: "ready",
      mcpToolCount: 2,
      authRequired: false,
    }),
  ];

  const desc = buildMcpMirrorToolDescriptors(mcpAiTools, reuseRows);
  assert.equal(desc.tool_WB0fsUJK_search?.description, "Search OpenAPI");
  assert.equal(desc.tool_WB0fsUJK_execute?.description, "Execute");
  assert.equal(desc.tool_WB0fsUJK_search?.jsonSchema.type, "object");
});

test("buildMcpMirrorToolDescriptors: uses normalized tool names when sdkServerId is sanitized", () => {
  const mcpAiTools = {
    tool_AzWW31H_search: {
      description: "Search OpenAPI",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    tool_AzWW31H_execute: {
      description: "Execute",
      inputSchema: { type: "object" },
    },
  } as unknown as ToolSet;

  const reuseRows = [
    migratePersistedMcpServer({
      ...baseRow,
      name: "Cloudflare Code Mode",
      mcpSdkServerId: "AzWW3-1H", // hyphen will be removed by normalization
      mcpRuntimeState: "ready",
      mcpToolCount: 2,
      authRequired: false,
    }),
  ];

  const desc = buildMcpMirrorToolDescriptors(mcpAiTools, reuseRows);
  // Descriptor keys should be the actual normalized names, not the raw sdkServerId
  assert.equal(desc.tool_AzWW31H_search?.description, "Search OpenAPI");
  assert.equal(desc.tool_AzWW31H_execute?.description, "Execute");
  assert(!("tool_AzWW3-1H_search" in desc), "should not have raw sdkServerId keys");
});

test("expectedMcpMirrorToolNamesForServer: exact match returns correct names", () => {
  const mcpAiTools = {
    tool_srv_123_search: { description: "Search" },
    tool_srv_123_execute: { description: "Execute" },
  } as unknown as ToolSet;

  const row = migratePersistedMcpServer({
    ...baseRow,
    name: "Acme Internal MCP",
    mcpSdkServerId: "srv_123",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  const names = expectedMcpMirrorToolNamesForServer({ mcpAiTools, server: row });
  assert.deepEqual(names, ["tool_srv_123_search", "tool_srv_123_execute"]);
});

test("expectedMcpMirrorToolNamesForServer: normalized match handles sanitized sdkServerId", () => {
  const mcpAiTools = {
    tool_AzWW31H_search: { description: "Search" },
    tool_AzWW31H_execute: { description: "Execute" },
  } as unknown as ToolSet;

  const row = migratePersistedMcpServer({
    ...baseRow,
    name: "Cloudflare Code Mode",
    mcpSdkServerId: "AzWW3-1H",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  const names = expectedMcpMirrorToolNamesForServer({ mcpAiTools, server: row });
  // Should return the actual normalized names, not the raw sdkServerId
  assert.deepEqual(names, ["tool_AzWW31H_search", "tool_AzWW31H_execute"]);
});

test("expectedMcpMirrorToolNamesForServer: returns empty array when tools not found", () => {
  const mcpAiTools = {
    tool_Other_search: { description: "Search" },
    tool_Other_execute: { description: "Execute" },
  } as unknown as ToolSet;

  const row = migratePersistedMcpServer({
    ...baseRow,
    mcpSdkServerId: "AzWW3-1H",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  const names = expectedMcpMirrorToolNamesForServer({ mcpAiTools, server: row });
  assert.deepEqual(names, []);
});

test("findMissingMcpMirrorDescriptors: detects missing required wrappers per reuse row", () => {
  const mcpAiTools = {
    tool_GENERIC_search: { description: "search", jsonSchema: {} },
    tool_GENERIC_execute: { description: "execute", jsonSchema: {} },
  } as unknown as ToolSet;

  const row = migratePersistedMcpServer({
    ...baseRow,
    name: "Generic MCP",
    mcpSdkServerId: "GENERIC",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  const issues = findMissingMcpMirrorDescriptors({
    reuseRows: [row],
    descriptors: {
      tool_GENERIC_search: {
        description: "search",
        jsonSchema: {},
      },
    },
    mcpAiTools,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.sdkServerId, "GENERIC");
  assert.deepEqual(issues[0]?.missingToolNames, ["tool_GENERIC_execute"]);
});

test("findMissingMcpMirrorDescriptors: validates against resolved actual names for sanitized ids", () => {
  const mcpAiTools = {
    tool_AzWW31H_search: { description: "search", jsonSchema: {} },
    tool_AzWW31H_execute: { description: "execute", jsonSchema: {} },
  } as unknown as ToolSet;

  const row = migratePersistedMcpServer({
    ...baseRow,
    name: "Cloudflare Code Mode",
    mcpSdkServerId: "AzWW3-1H",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  const issues = findMissingMcpMirrorDescriptors({
    reuseRows: [row],
    descriptors: {
      tool_AzWW31H_search: {
        description: "search",
        jsonSchema: {},
      },
    },
    mcpAiTools,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.sdkServerId, "AzWW3-1H");
  // Should report the actual normalized name, not the raw sdkServerId
  assert.deepEqual(issues[0]?.missingToolNames, ["tool_AzWW31H_execute"]);
});
