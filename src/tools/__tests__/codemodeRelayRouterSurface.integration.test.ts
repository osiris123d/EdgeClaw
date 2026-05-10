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
} from "../codemodeRelayMetaTools";
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
