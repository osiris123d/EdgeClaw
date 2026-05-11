/**
 * MCP restore / OAuth persistence — Node-safe unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import {
  buildAddMcpServerSdkOptions,
  buildAddMcpServerSdkOptionsWithoutOAuthRouting,
  formatToolAgentMcpBootstrapError,
  mcpRestoreShouldIncludeOAuthRouting,
  restorePersistedMcpServersFromConfig,
  TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX,
  type ThinkMcpRestoreHost,
} from "../mcpRestoreFromPersisted";
import {
  buildDiscoverySnapshot,
  mergePersistedMcpServersWithDiscoverySnapshot,
  migratePersistedMcpServer,
  EMPTY_RAW_SDK_STATE,
  type DiscoveredMcpServer,
  type McpDiscoverySnapshot,
  type PersistedMcpServerSafe,
  type RawSdkMcpState,
} from "../mcpDiscovery";
import { pickWrappedToolName } from "../../tools/codemodeRouterHelpers";
import { computeDelegateToolTaskTurnLatchesAndReply } from "../../agents/delegateToolTaskTurnOutcome";
import { shouldReuseLiveMcpSdkServer } from "../mcpToolAgentLiveReuse";

test("migratePersistedMcpServer preserves OAuth routing fields and authUrl (snake_case aliases)", () => {
  const migrated = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Cloudflare Code Mode",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    callback_host: "https://worker.example",
    callback_path: "mcp-callback",
    agents_prefix: "agents",
    auth_url: "https://oauth.example/authorize",
  });
  assert.equal(migrated.callbackHost, "https://worker.example");
  assert.equal(migrated.callbackPath, "mcp-callback");
  assert.equal(migrated.agentsPrefix, "agents");
  assert.equal(migrated.authUrl, "https://oauth.example/authorize");
});

test("buildAddMcpServerSdkOptions forwards callbackHost/callbackPath/agentsPrefix for Agents SDK", () => {
  const opts = buildAddMcpServerSdkOptions({
    id: "x",
    name: "s",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    callbackHost: "https://origin.example",
    callbackPath: "/cb",
    agentsPrefix: "agents",
  });
  assert.equal(opts.callbackHost, "https://origin.example");
  assert.equal(opts.callbackPath, "/cb");
  assert.equal(opts.agentsPrefix, "agents");
  assert.equal((opts.transport as { type?: string }).type, "streamable-http");
});

test("restorePersistedMcpServersFromConfig records failures (fail-fast source for ToolAgent)", async () => {
  const calls: string[] = [];
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({
      mcpServers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          name: "fail-server",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    }),
    configure: async () => {},
    addMcpServer: async (name) => {
      calls.push(name);
      throw new Error("OAuth configuration incomplete: missing authUrl");
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(calls.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.name, "fail-server");
  assert.match(failures[0]!.message, /OAuth configuration incomplete: missing authUrl/);
});

test("formatToolAgentMcpBootstrapError prefixes ToolAgent MCP restore failures", () => {
  const out = formatToolAgentMcpBootstrapError("OAuth configuration incomplete: missing authUrl");
  assert.ok(out.startsWith(TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX));
  assert.match(out, /OAuth configuration incomplete: missing authUrl/);
});

test("successful restore calls addMcpServer once per enabled row", async () => {
  let n = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({
      mcpServers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440002",
          name: "tool_cloudflare_openapi_search",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          callbackHost: "https://origin.example",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440003",
          name: "tool_cloudflare_accounts_http_request",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          callbackHost: "https://origin.example",
        },
      ],
    }),
    configure: async () => {},
    addMcpServer: async (_name, _url, sdkOpts) => {
      n += 1;
      assert.ok(sdkOpts && typeof sdkOpts === "object");
      assert.equal((sdkOpts as { callbackHost?: string }).callbackHost, "https://origin.example");
      return { state: "ready" };
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(n, 2);
  assert.equal(failures.length, 0);
});

test("migratePersistedMcpServer reads auth.required from nested auth object", () => {
  const m = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440010",
    name: "Code Mode",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    auth: { required: false },
  });
  assert.equal(m.authRequired, false);
});

test("authRequired false omits OAuth routing from buildAddMcpServerSdkOptions even if callbackHost persisted", () => {
  const opts = buildAddMcpServerSdkOptions({
    id: "x",
    name: "s",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    callbackHost: "https://origin.example",
    authRequired: false,
  });
  assert.equal(opts.callbackHost, undefined);
  assert.equal(opts.callbackPath, undefined);
  assert.equal(opts.agentsPrefix, undefined);
});

test("mcpRestoreShouldIncludeOAuthRouting is false for ready discovery hints without OAuth", () => {
  assert.equal(
    mcpRestoreShouldIncludeOAuthRouting({
      id: "x",
      name: "s",
      url: "https://u",
      transport: "streamable-http",
      enabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      mcpRuntimeState: "ready",
      mcpToolCount: 2,
    }),
    false
  );
});

test("restore retries without OAuth routing after missing authUrl when OAuth routing was used", async () => {
  let attempt = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({
      mcpServers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440099",
          name: "cf-mcp",
          url: "https://mcp.cloudflare.com/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          callbackHost: "https://worker.example",
        },
      ],
    }),
    configure: async () => {},
    addMcpServer: async (_name, _url, sdkOpts) => {
      attempt += 1;
      const o = sdkOpts as { callbackHost?: string };
      if (attempt === 1) {
        assert.ok(o.callbackHost);
        throw new Error("OAuth configuration incomplete: missing authUrl");
      }
      assert.equal(o.callbackHost, undefined);
      return { state: "ready" };
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(attempt, 2);
  assert.equal(failures.length, 0);
});

test("restore does not retry stripped path when authRequired is true", async () => {
  let attempt = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({
      mcpServers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440098",
          name: "oauth-server",
          url: "https://example.com/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          callbackHost: "https://worker.example",
          authRequired: true,
        },
      ],
    }),
    configure: async () => {},
    addMcpServer: async () => {
      attempt += 1;
      throw new Error("OAuth configuration incomplete: missing authUrl");
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(attempt, 1);
  assert.equal(failures.length, 1);
});

test("mergePersistedMcpServersWithDiscoverySnapshot copies auth.required and MCP runtime hints", () => {
  const persisted = [
    migratePersistedMcpServer({
      id: "id1",
      name: "Code Mode",
      url: "https://mcp.cloudflare.com/mcp",
      transport: "streamable-http",
      enabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    }),
  ];
  const safe: PersistedMcpServerSafe[] = persisted.map((p) => {
    const { headers: _h, token: _t, authUrl: _a, ...rest } = p;
    return rest;
  });

  const raw: RawSdkMcpState = {
    ...EMPTY_RAW_SDK_STATE,
    servers: {
      sk: {
        name: "Code Mode",
        server_url: "https://mcp.cloudflare.com/mcp",
        state: "ready",
        error: null,
        auth_url: null,
        instructions: null,
        capabilities: {},
      },
    },
    tools: [
      { name: "search_tool", serverId: "sk", description: "" },
      { name: "execute_tool", serverId: "sk", description: "" },
    ],
  };

  const snap = buildDiscoverySnapshot(raw, safe, new Map());
  const merged = mergePersistedMcpServersWithDiscoverySnapshot(persisted, snap);
  assert.equal(merged[0]!.authRequired, false);
  assert.equal(merged[0]!.mcpSdkServerId, "sk");
  assert.equal(merged[0]!.mcpRuntimeState, "ready");
  assert.equal(merged[0]!.mcpToolCount, 2);
});

test("mergePersistedMcpServersWithDiscoverySnapshot preserves persisted authRequired when disc.auth.required is absent", () => {
  const persisted = [
    migratePersistedMcpServer({
      id: "id1",
      name: "srv",
      url: "https://example.com/mcp",
      transport: "streamable-http",
      enabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      authRequired: false,
      callbackHost: "https://callback.example",
    }),
  ];
  const disc = {
    id: "id1",
    name: "srv",
    url: "https://example.com/mcp",
    auth: { required: undefined, authUrl: null, providerHint: null },
    state: "ready",
    sdkServerId: "sk",
    toolCount: 2,
  } as unknown as DiscoveredMcpServer;

  const snap: McpDiscoverySnapshot = {
    servers: [disc],
    tools: [],
    prompts: [],
    resources: [],
    totalServers: 1,
    totalTools: 0,
    totalPrompts: 0,
    totalResources: 0,
    snapshotAt: "2024-01-01T00:00:00.000Z",
  };

  const merged = mergePersistedMcpServersWithDiscoverySnapshot(persisted, snap);
  assert.equal(merged[0]!.authRequired, false);
  assert.equal(mcpRestoreShouldIncludeOAuthRouting(merged[0]!), false);
  assert.equal(merged[0]!.callbackHost, undefined);
  assert.equal(merged[0]!.authUrl, undefined);
});

test("mergePersistedMcpServersWithDiscoverySnapshot matches live row by URL when stable ids/names diverge", () => {
  const persisted = [
    migratePersistedMcpServer({
      id: "persisted-row",
      name: "Wrong MCP Label",
      url: "https://mcp.cloudflare.com/mcp",
      transport: "streamable-http",
      enabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      callbackHost: "https://worker.example",
    }),
  ];
  const disc = {
    id: "WB0fsUJK",
    name: "Cloudflare Code Mode",
    url: "https://mcp.cloudflare.com/mcp/",
    auth: { required: false, authUrl: null, providerHint: null },
    state: "ready",
    sdkServerId: "WB0fsUJK",
    toolCount: 2,
  } as unknown as DiscoveredMcpServer;

  const snap: McpDiscoverySnapshot = {
    servers: [disc],
    tools: [],
    prompts: [],
    resources: [],
    totalServers: 1,
    totalTools: 0,
    totalPrompts: 0,
    totalResources: 0,
    snapshotAt: "2024-01-01T00:00:00.000Z",
  };

  const merged = mergePersistedMcpServersWithDiscoverySnapshot(persisted, snap);
  assert.equal(merged[0]!.authRequired, false);
  assert.equal(merged[0]!.mcpSdkServerId, "WB0fsUJK");
  assert.equal(merged[0]!.mcpRuntimeState, "ready");
  assert.equal(merged[0]!.mcpToolCount, 2);
  assert.equal(mcpRestoreShouldIncludeOAuthRouting(merged[0]!), false);
  assert.equal(merged[0]!.callbackHost, undefined);
});

test("merge + restore: persisted callbackHost with discovery auth.required=false strips OAuth and never sends callbackHost to SDK", async () => {
  const persisted = [
    migratePersistedMcpServer({
      id: "id-cf",
      name: "Cloudflare Code Mode",
      url: "https://mcp.cloudflare.com/mcp",
      transport: "streamable-http",
      enabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      callbackHost: "https://worker.example",
      callbackPath: "/cb",
      agentsPrefix: "agents",
    }),
  ];
  const safe: PersistedMcpServerSafe[] = persisted.map((p) => {
    const { headers: _h, token: _t, authUrl: _a, ...rest } = p;
    return rest;
  });
  const raw: RawSdkMcpState = {
    ...EMPTY_RAW_SDK_STATE,
    servers: {
      WB0fsUJK: {
        name: "Cloudflare Code Mode",
        server_url: "https://mcp.cloudflare.com/mcp",
        state: "ready",
        error: null,
        auth_url: null,
        instructions: null,
        capabilities: {},
      },
    },
    tools: [
      { name: "openapi_search", serverId: "WB0fsUJK", description: "" },
      { name: "cloudflare_request", serverId: "WB0fsUJK", description: "" },
    ],
  };
  const snap = buildDiscoverySnapshot(raw, safe, new Map());
  const merged = mergePersistedMcpServersWithDiscoverySnapshot(persisted, snap);
  assert.equal(merged[0]!.authRequired, false);
  assert.equal(merged[0]!.callbackHost, undefined);

  const opts = buildAddMcpServerSdkOptions(merged[0]!);
  assert.equal(opts.callbackHost, undefined);
  assert.equal(opts.callbackPath, undefined);
  assert.equal(opts.agentsPrefix, undefined);
  assert.equal((opts as { oauth?: unknown }).oauth, undefined);

  let sawOpts: Record<string, unknown> | undefined;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({ mcpServers: merged }),
    configure: async () => {},
    addMcpServer: async (_name, _url, sdkOpts) => {
      sawOpts = sdkOpts as Record<string, unknown>;
      assert.equal(sdkOpts?.callbackHost, undefined);
      assert.equal(sdkOpts?.callbackPath, undefined);
      assert.equal(sdkOpts?.agentsPrefix, undefined);
      return { state: "ready" };
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(failures.length, 0);
  assert.ok(sawOpts && typeof sawOpts === "object");
});

test("Codemode MCP relay uses tool_<sdkServerId>_search and tool_<sdkServerId>_execute naming (CF Code Mode)", () => {
  const relay = {
    tool_WB0fsUJK_search: { description: "" },
    tool_WB0fsUJK_execute: { description: "" },
  } as unknown as ToolSet;
  assert.equal(pickWrappedToolName(relay, "search"), "tool_WB0fsUJK_search");
  assert.equal(pickWrappedToolName(relay, "execute"), "tool_WB0fsUJK_execute");
});

test("delegate latch: successful delegation after MCP sync does not set toolAgent bootstrapFailed", () => {
  const { latches } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: { ok: true, text: "Tools ran." },
  });
  assert.equal(latches.bootstrapFailed, false);
  assert.equal(latches.delegateOk, true);
});

test("authRequired true with authUrl keeps OAuth routing fields in SDK options", () => {
  const opts = buildAddMcpServerSdkOptions({
    id: "x",
    name: "oauth-mcp",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authRequired: true,
    authUrl: "https://oauth.example/authorize",
    callbackHost: "https://origin.example",
    callbackPath: "/mcp-callback",
    agentsPrefix: "agents",
  });
  assert.equal(opts.callbackHost, "https://origin.example");
  assert.equal(opts.callbackPath, "/mcp-callback");
  assert.equal(opts.agentsPrefix, "agents");
});

test("authRequired true without resolvable auth: restore failure surfaces for ToolAgent bootstrap", async () => {
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({
      mcpServers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440501",
          name: "oauth-only",
          url: "https://mcp.example/mcp",
          transport: "streamable-http",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          authRequired: true,
          callbackHost: "https://worker.example",
        },
      ],
    }),
    configure: async () => {},
    addMcpServer: async () => {
      throw new Error("OAuth configuration incomplete: missing authUrl");
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host);
  assert.equal(failures.length, 1);
  const prefixed = formatToolAgentMcpBootstrapError(failures[0]!.message);
  assert.match(prefixed, /OAuth configuration incomplete:\s*missing authUrl/i);
});

test("buildAddMcpServerSdkOptionsWithoutOAuthRouting never adds callback fields", () => {
  const opts = buildAddMcpServerSdkOptionsWithoutOAuthRouting({
    id: "x",
    name: "s",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    callbackHost: "https://origin.example",
    authRequired: true,
  });
  assert.equal(opts.callbackHost, undefined);
});

test("skipRestore (live reuse): Cloudflare Code Mode ready row does not call addMcpServer — no missing authUrl path", async () => {
  const row = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440701",
    name: "Cloudflare Code Mode",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    callbackHost: "https://stale.example",
    authUrl: "https://stale-oauth.example/auth",
    auth: { required: false },
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), true);

  let calls = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({ mcpServers: [row] }),
    configure: async () => {},
    addMcpServer: async () => {
      calls += 1;
      throw new Error("OAuth configuration incomplete: missing authUrl");
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host, {
    skipRestore: shouldReuseLiveMcpSdkServer,
  });
  assert.equal(calls, 0);
  assert.equal(failures.length, 0);
});

test("skipRestore: OAuth-required row still restores via addMcpServer", async () => {
  const row = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440702",
    name: "oauth-mcp",
    url: "https://mcp.example/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    authRequired: true,
    authUrl: "https://oauth.example/authorize",
    callbackHost: "https://worker.example",
    mcpSdkServerId: "ABC123",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);

  let calls = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({ mcpServers: [row] }),
    configure: async () => {},
    addMcpServer: async (_name, _url, opts) => {
      calls += 1;
      assert.equal((opts as { callbackHost?: string }).callbackHost, "https://worker.example");
      return { state: "authenticating" };
    },
  };

  const { failures } = await restorePersistedMcpServersFromConfig(host, {
    skipRestore: shouldReuseLiveMcpSdkServer,
  });
  assert.equal(calls, 1);
  assert.equal(failures.length, 0);
});

test("skipRestore: no sdk id falls through to restore-persisted (addMcpServer invoked)", async () => {
  const row = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440703",
    name: "plain-mcp",
    url: "https://example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
    authRequired: false,
  });
  assert.equal(shouldReuseLiveMcpSdkServer(row), false);

  let calls = 0;
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({ mcpServers: [row] }),
    configure: async () => {},
    addMcpServer: async () => {
      calls += 1;
      return { state: "ready" };
    },
  };

  await restorePersistedMcpServersFromConfig(host, { skipRestore: shouldReuseLiveMcpSdkServer });
  assert.equal(calls, 1);
});

test("skipRestore: mixed reuse + restore rows calls addMcpServer only for non-reuse", async () => {
  const reuse = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440704",
    name: "Code Mode",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    auth: { required: false },
    mcpSdkServerId: "WB0fsUJK",
    mcpRuntimeState: "ready",
    mcpToolCount: 2,
  });
  const restore = migratePersistedMcpServer({
    id: "550e8400-e29b-41d4-a716-446655440705",
    name: "other",
    url: "https://other.example/mcp",
    transport: "streamable-http",
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });

  const names: string[] = [];
  const host: ThinkMcpRestoreHost = {
    getConfig: () => ({ mcpServers: [reuse, restore] }),
    configure: async () => {},
    addMcpServer: async (name) => {
      names.push(name);
      return { state: "ready" };
    },
  };

  await restorePersistedMcpServersFromConfig(host, { skipRestore: shouldReuseLiveMcpSdkServer });
  assert.deepEqual(names, ["other"]);
});
