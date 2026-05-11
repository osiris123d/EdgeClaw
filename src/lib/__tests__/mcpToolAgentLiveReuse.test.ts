/**
 * ToolAgent live MCP SDK reuse (mirror vs restore) — Node-safe unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import {
  buildMcpMirrorToolDescriptors,
  shouldReuseLiveMcpSdkServer,
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

test("buildMcpMirrorToolDescriptors copies search/execute from parent mcp.getAITools()", () => {
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
