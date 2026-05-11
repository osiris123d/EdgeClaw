/**
 * Validates Codemode relay router tool surface stays aligned with Rpc registration + host execution.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  CODEMODE_RELAYER_ROUTING_TOOL_IDS,
  createCodemodeRelayMetaToolSet,
  classifyNonRetryableToolError,
} from "../codemodeRelayMetaTools";
import { codemodeWireStringifyToolResult } from "../codemodeRouterHelpers";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

test("CODEMODE_RELAYER_ROUTING_TOOL_IDS matches relay meta keys", () => {
  const relay: ToolSet = {
    dummy: tool({
      description: "x",
      inputSchema: z.object({}),
      execute: async (): Promise<number> => 1,
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "x" });
  const keysSorted = CODEMODE_RELAYER_ROUTING_TOOL_IDS.slice().sort();
  assert.deepEqual(Object.keys(meta).sort(), keysSorted);
});

test('Codemode router smoke — tools_find({ query }) host path matches model expectation', async () => {
  const relay: ToolSet = {
    tool_demo: tool({
      description: "Cloudflare dex device tooling",
      inputSchema: z.object({}),
      execute: async (): Promise<number> => 42,
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });

  /** Mirrors successful inner Codemode path (no Rpc) — rejects "method not implemented" class failures. */
  const out = (await execTool(meta, "tools_find", { query: "dex device" })) as {
    matches?: Array<{ name: string }>;
  };

  assert.ok(Array.isArray(out.matches));
  assert.ok(out.matches!.some((m) => m.name === "tool_demo"));
});

test("strict Codemode args: openapi_search rejects unknown keys with unknown_helper_argument", async () => {
  const relay: ToolSet = {
    tool_dummy: tool({
      description: "noop",
      inputSchema: z.object({}),
      execute: async (): Promise<number> => 1,
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const bad = await execTool(meta, "openapi_search", { tag: "x", surpriseKey: true });
  assert.equal((bad as { ok?: boolean }).ok, false);
  assert.equal((bad as { error?: string }).error, "unknown_helper_argument");
});

test("strict planner: missing required query blocks before second execute", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        executes += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [
                      {
                        name: "filter",
                        in: "query",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                  },
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: { relayed: true } }),
            },
          ],
        };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    const d = await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/catalog/items",
    });
    assert.equal((d as { ok?: boolean }).ok, true);
    const blocked = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/catalog/items",
    });
    assert.equal((blocked as { ok?: boolean }).ok, false);
    assert.equal((blocked as { error?: string }).error, "missing_required_parameter");
    assert.equal(executes, 1);
  });
});

test("strict planner: knownValues satisfy path segment → executes HTTP inner", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        executes += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [
                      {
                        name: "resource_id",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                  },
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: { ok: true } }),
            },
          ],
        };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/resources/{resource_id}",
    });
    const ok = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/resources/{resource_id}",
      knownValues: { resource_id: "opaque-resource-token" },
    });
    assert.equal((ok as { ok?: boolean }).ok, true);
    assert.ok(executes >= 2);
  });
});

test("strict planner cache: openapi_describe `{account_id}` template matches concrete /accounts/<32hex>/ path", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        executes += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [
                      {
                        name: "per_page",
                        in: "query",
                        required: false,
                        schema: { type: "integer" },
                      },
                    ],
                  },
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: { workersOk: true } }),
            },
          ],
        };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "sandbox-acct" });
  const cfAccountHex = "a1b2c3d4e5f6789012345678abcdef01";
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
    });
    const ok = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: `/accounts/${cfAccountHex}/workers/scripts`,
    });
    assert.equal((ok as { ok?: boolean }).ok, true);
    assert.equal((ok as { executionPlannerNote?: string }).executionPlannerNote, undefined);
    assert.ok(executes >= 2);
  });
});

test("strict planner cache: openapi_describe concrete /accounts/<32hex>/ path matches `{account_id}` template request", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        executes += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [
                      {
                        name: "direction_alias_inverse",
                        in: "query",
                        required: false,
                        schema: { type: "string" },
                      },
                    ],
                  },
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: { inverseAliasOk: true } }),
            },
          ],
        };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "sandbox-acct" });
  const cfAccountHex = "b2c3d4e5f6789012345678abcdef012a";
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: `/accounts/${cfAccountHex}/workers/scripts`,
    });
    const ok = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
    });
    assert.equal((ok as { ok?: boolean }).ok, true);
    assert.equal((ok as { executionPlannerNote?: string }).executionPlannerNote, undefined);
    assert.ok(executes >= 2);
  });
});

test("cloudflare_request rejects unknown helper keys on strict relay surface", async () => {
  const relay: ToolSet = {
    tool_dummy: tool({ description: "noop", inputSchema: z.object({}), execute: async () => 1 }),
    tool_execute: tool({
      description: "stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const bad = await execTool(meta, "cloudflare_request", {
    method: "GET" as const,
    path: "/a",
    notARealParameter: true,
  });
  assert.equal((bad as { ok?: boolean }).ok, false);
  assert.equal((bad as { error?: string }).error, "unknown_helper_argument");
});

test("cloudflare_request without schema lookup trips missing_schema_lookup inside a Codemode session", async () => {
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: {} }) }],
      }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    const blocked = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: "/accounts/{account_id}/noop",
    });
    assert.equal((blocked as { ok?: boolean }).ok, false);
    assert.equal((blocked as { error?: string }).error, "missing_schema_lookup");

    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });

    const allowed = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: "/accounts/{account_id}/noop",
    });
    assert.equal((allowed as { ok?: boolean }).ok, true);
  });
});

test("reuse-live-sdk-server style mirror relay: tools_find, tools_call_code, openapi planner chain — Rpc wire stays JSON-safe", async () => {
  const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification — accounts, workers, and routes",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify([
              {
                method: "GET",
                path: "/accounts/{account_id}/workers/scripts",
                summary: "List Workers",
              },
            ]),
          },
        ],
      }),
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript including cloudflare.request",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [
                      {
                        name: "account_id",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                  },
                }),
              },
            ],
          };
        }
        if (code.includes("aliasOk")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ aliasOk: true }) }],
          };
        }
        if (code.includes("cloudflare.request")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, result: { scripts: [] } }),
              },
            ],
          };
        }
        if (code.includes("spec.paths")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  summary: "List Workers",
                  parameters: [{ name: "account_id", in: "path" }],
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: "{}" }] };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: accountId });

  await runCodemodeRouterInvocation(async () => {
    const find = (await execTool(meta, "tools_find", { query: "account" })) as {
      matches?: Array<{ name: string }>;
    };
    assert.ok(find.matches?.some((m) => m.name === "tool_WB0fsUJK_search"));

    const describeViaSearchTool = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_search",
      code: `async () => {
        const op = spec.paths['/accounts/{account_id}/workers/scripts']?.get;
        return { summary: op?.summary, parameters: op?.parameters };
      }`,
    });
    assert.equal((describeViaSearchTool as { ok?: boolean }).ok, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(describeViaSearchTool)));

    const search = await execTool(meta, "openapi_search", { pathIncludes: "/workers/scripts" });
    assert.equal((search as { ok?: boolean }).ok, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(search)));

    const describe = await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
    });
    assert.equal((describe as { ok?: boolean }).ok, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(describe)));

    const cf = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
      operationPathTemplate: "/accounts/{account_id}/workers/scripts",
    });
    assert.equal((cf as { ok?: boolean }).ok, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(cf)));

    const directExec = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_execute",
      code: `async () => cloudflare.request({ method: "GET", path: "/accounts/${accountId}/workers/scripts" })`,
    });
    assert.equal((directExec as { ok?: boolean }).ok, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(directExec)));

    const aliasCall = await execTool(meta, "tools_call", {
      toolName: "tool_WB0fsUJK_execute",
      arguments: {
        code: `async () => ({ aliasOk: true })`,
      },
    });
    assert.equal((aliasCall as { ok?: boolean }).ok, true);
    assert.equal((aliasCall as { result?: { aliasOk?: boolean } }).result?.aliasOk, true);
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(aliasCall)));
  });
});

test("tools_call_code rejects JavaScript Function values for `code`", async () => {
  const relay: ToolSet = {
    tool_x: tool({
      description: "x",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async () => ({}),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const bad = await execTool(meta, "tools_call_code", {
    toolName: "tool_x",
    code: (async () => {}) as unknown as string,
  });
  assert.equal((bad as { ok?: boolean }).ok, false);
  assert.equal((bad as { error?: string }).error, "tools_call_code_invalid_code_type");
});

test("openapi_search delegated mirror throws surface [EdgeClaw] boundary (not generic neutral text)", async () => {
  const relay: ToolSet = {
    tool_Z_search: tool({
      description: "OpenAPI MCP search",
      inputSchema: z.object({ code: z.string() }),
      execute: async (): Promise<unknown> => {
        throw new Error('Could not serialize object of type "DurableObject". This type does not support serialization.');
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const out = await execTool(meta, "openapi_search", { tag: "workers" });
  assert.equal((out as { ok?: boolean }).ok, false);
  const err = String((out as { error?: string }).error);
  assert.match(err, /\[EdgeClaw\]\[openapi_search:delegated_invoke\]/);
  assert.equal((out as { boundary?: string }).boundary, "openapi_search:delegated_invoke");
  assert.equal((out as { failureKind?: string }).failureKind, "delegated_mirror_invoke_throw");
  assert.match(err, /DurableObject|serialize object of type/i);
  assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(out)));
});

test("openapi_search JSON-safes raw MCP tool result when tryParseJsonFromMcpToolResult returns the object unchanged", async () => {
  class RpcTarget {}
  const relay: ToolSet = {
    tool_S_search: tool({
      description: "OpenAPI MCP search",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ content: [], leak: new RpcTarget() }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const out = (await execTool(meta, "openapi_search", { tag: "w" })) as {
    ok?: boolean;
    endpoints?: { content?: unknown[]; leak?: string };
  };
  assert.equal(out.ok, true);
  assert.equal(out.endpoints?.leak, "[RpcTarget]");
  assert.ok(Array.isArray(out.endpoints?.content));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

// ─── Non-retryable error hardening ────────────────────────────────────────────

// classifier: provider-agnostic semantic matching
test("classifyNonRetryableToolError: 'does not exist on your account' is resource_not_found_on_account", () => {
  // Cloudflare 10007 regression fixture — matched via semantic message pattern, not error code
  const r = classifyNonRetryableToolError("API error: 10007: This Worker does not exist on your account");
  assert.ok(r !== null);
  assert.equal(r!.kind, "resource_not_found_on_account");
});

test("classifyNonRetryableToolError: 'spec is not defined' is discovery_global_not_in_execute_scope", () => {
  const r = classifyNonRetryableToolError("ReferenceError: spec is not defined");
  assert.ok(r !== null);
  assert.equal(r!.kind, "discovery_global_not_in_execute_scope");
});

test("classifyNonRetryableToolError: transient network error is null (retryable)", () => {
  const r = classifyNonRetryableToolError("fetch failed: ECONNRESET");
  assert.equal(r, null);
});

test("classifyNonRetryableToolError: authentication error is api_authentication_error", () => {
  // Cloudflare 10000 regression fixture — matched via 'Authentication error' substring
  const r = classifyNonRetryableToolError("10000: Authentication error");
  assert.ok(r !== null);
  assert.equal(r!.kind, "api_authentication_error");
});

test("classifyNonRetryableToolError: generic 401 Unauthorized is api_authentication_error", () => {
  const r = classifyNonRetryableToolError("HTTP 401 Unauthorized");
  assert.ok(r !== null);
  assert.equal(r!.kind, "api_authentication_error");
});

test("tools_call_code: spec-inspection code targeting an _execute tool is blocked before RPC with nonRetryable", async () => {
  let executeInvocations = 0;
  const relay: ToolSet = {
    // Generic fake MCP execute tool — not provider-specific
    tool_fakemcp_execute: tool({
      description: "Execute relay (generic fake)",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async () => {
        executeInvocations++;
        return { content: [{ type: "text" as const, text: "{}" }] };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const specInspectionCode = `async () => {
    const paths = spec.paths;
    return Object.keys(paths);
  }`;
  const out = await execTool(meta, "tools_call_code", {
    toolName: "tool_fakemcp_execute",
    code: specInspectionCode,
  });
  // Must be blocked before RPC — execute tool should never be called.
  assert.equal(executeInvocations, 0, "execute tool must not be invoked when spec guard fires");
  assert.equal((out as { ok?: boolean }).ok, false);
  assert.equal((out as { nonRetryable?: boolean }).nonRetryable, true);
  assert.equal((out as { nonRetryableKind?: string }).nonRetryableKind, "spec_not_defined_in_execute_tool");
  const err = String((out as { error?: string }).error ?? "");
  assert.match(err, /spec is not defined/i);
});

test("tools_call_code: spec.paths in code targeting a _search tool is allowed (spec is defined in search env)", async () => {
  const relay: ToolSet = {
    // Generic fake MCP search tool — spec global is valid in search context
    tool_fakemcp_search: tool({
      description: "Search relay (generic fake)",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ paths: ["/resources/{id}/items"] }),
          },
        ],
      }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const out = await execTool(meta, "tools_call_code", {
    toolName: "tool_fakemcp_search",
    code: `async () => {
      const keys = Object.keys(spec.paths);
      return keys;
    }`,
  });
  // Search tool legitimately has spec — guard must not block it.
  assert.equal((out as { ok?: boolean }).ok, true, "spec code targeting search tool must pass guard");
  assert.equal((out as { nonRetryable?: boolean }).nonRetryable, undefined);
});

test("cloudflare_request: 'does not exist on your account' error is classified non-retryable (Cloudflare 10007 regression fixture)", async () => {
  let executeInvocations = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        executeInvocations++;
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, operation: {} }),
              },
            ],
          };
        }
        // Fixture: Cloudflare 10007 — matched via semantic message pattern 'does not exist on your account'
        throw new Error("Cloudflare API error: 10007: This Worker does not exist on your account");
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", { method: "GET", path: "/api/v1/scripts/{script_name}" });
    const countBefore = executeInvocations;
    const out = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/api/v1/scripts/nonexistent-script",
    });
    assert.equal((out as { ok?: boolean }).ok, false);
    assert.equal((out as { nonRetryable?: boolean }).nonRetryable, true);
    assert.equal((out as { nonRetryableKind?: string }).nonRetryableKind, "resource_not_found_on_account");
    // Must not retry (coerce path should be skipped when nonRetryable)
    assert.equal(
      executeInvocations - countBefore,
      1,
      "execute must be called exactly once — not retried via coerce path"
    );
  });
});

test("cloudflare_request: non-retryable result skips coerce-and-retry path", async () => {
  let executeInvocations = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        executeInvocations++;
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: {} }) }],
          };
        }
        throw new Error("10007: This Worker does not exist on your account");
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", { method: "POST", path: "/client/v4/workers/scripts/{name}" });
    const callsBefore = executeInvocations;
    const out = await execTool(meta, "cloudflare_request", {
      method: "POST",
      path: "/client/v4/workers/scripts/ghost-worker",
      body: { metadata: {} },
    });
    assert.equal((out as { nonRetryable?: boolean }).nonRetryable, true, "must be non-retryable");
    // Should be exactly 1 execute call (describe already counted), not 2 (no coerce retry).
    assert.equal(executeInvocations - callsBefore, 1, "coerce-and-retry path must be skipped");
  });
});
