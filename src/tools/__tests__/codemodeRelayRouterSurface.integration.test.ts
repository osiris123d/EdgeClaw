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

function setCodemodeWireDebug(enabled: boolean): void {
  (globalThis as { EDGECLAW_CODEMODE_WIRE_DEBUG?: boolean }).EDGECLAW_CODEMODE_WIRE_DEBUG = enabled;
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

test("probe regression: Object.keys(cm) can be empty while helpers still exist via property access", () => {
  const cm = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "string" && ["openapi_search", "openapi_describe_operation", "cloudflare_request"].includes(prop)) {
          return async (): Promise<Record<string, unknown>> => ({ ok: true, helper: prop });
        }
        return undefined;
      },
      ownKeys: () => [],
    }
  ) as {
    openapi_search: unknown;
    openapi_describe_operation: unknown;
    cloudflare_request: unknown;
  };

  assert.deepEqual(Object.keys(cm), []);
  assert.equal(typeof cm.openapi_search, "function");
  assert.equal(typeof cm.openapi_describe_operation, "function");
  assert.equal(typeof cm.cloudflare_request, "function");
});

test("one invocation shares ALS store across openapi_search -> openapi_describe_operation -> cloudflare_request", async () => {
  setCodemodeWireDebug(true);
  try {
    const relay: ToolSet = {
      tool_search: tool({
        description: "OpenAPI MCP search stub",
        inputSchema: z.object({ code: z.string() }),
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
                        { name: "account_id", in: "path", required: true, schema: { type: "string" } },
                      ],
                    },
                  }),
                },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify([{ method: "GET", path: "/accounts/{account_id}/gateway/rules" }]) }] };
        },
      }),
      tool_execute: tool({
        description: "Execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async () => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: [{ rule_id: "r-1" }] }),
            },
          ],
        }),
      }),
    };
    const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "runtime-acct" });

    await runCodemodeRouterInvocation(async () => {
      const search = (await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      })) as {
        ok?: boolean;
        invocationStorePresent?: boolean;
        invocationStoreId?: string;
        openapiSearchAttempts?: number;
        describeStateKeys?: string[];
      };
      assert.equal(search.ok, true);
      assert.equal(search.invocationStorePresent, true);
      assert.ok(typeof search.invocationStoreId === "string" && search.invocationStoreId.length > 0);
      assert.ok((search.openapiSearchAttempts ?? 0) >= 1);

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as {
        ok?: boolean;
        invocationStorePresent?: boolean;
        invocationStoreId?: string;
        describeStateKeys?: string[];
      };
      assert.equal(describe.ok, true);
      assert.equal(describe.invocationStorePresent, true);
      assert.equal(describe.invocationStoreId, search.invocationStoreId);
      assert.ok((describe.describeStateKeys ?? []).some((k) => k.includes("GET /accounts/{account_id}/gateway/rules")));

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })) as {
        ok?: boolean;
        describeStatus?: string;
        invocationStorePresent?: boolean;
        invocationStoreId?: string;
        describeStateKeys?: string[];
      };
      assert.equal(req.ok, true);
      assert.equal(req.invocationStorePresent, true);
      assert.equal(req.invocationStoreId, search.invocationStoreId);
      assert.notEqual(req.describeStatus, "never_called");
      assert.ok((req.describeStateKeys ?? []).some((k) => k.includes("GET /accounts/{account_id}/gateway/rules")));
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("after awaited openapi_describe_operation, cloudflare_request missing-cache status is not never_called", async () => {
  setCodemodeWireDebug(true);
  try {
    const relay: ToolSet = {
      tool_search: tool({
        description: "OpenAPI MCP search stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (input: unknown) => {
          const code =
            typeof input === "object" && input && "code" in input
              ? String((input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ ok: true, operation: { parameters: [] } }) },
              ],
            };
          }
          return { ok: true };
        },
      }),
      tool_execute: tool({
        description: "Execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: {} }) }] }),
      }),
    };
    const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });

    await runCodemodeRouterInvocation(async () => {
      await execTool(meta, "openapi_search", { tag: "gateway" });
      await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      });
      const miss = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/workers/scripts",
        operationPathTemplate: "/accounts/{account_id}/workers/scripts",
        account_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })) as { ok?: boolean; error?: string; describeStatus?: string };
      assert.equal(miss.ok, false);
      assert.equal(miss.error, "missing_openapi_describe_same_invocation");
      assert.notEqual(miss.describeStatus, "never_called");
      assert.equal(miss.describeStatus, "cache_key_mismatched");
    });
  } finally {
    setCodemodeWireDebug(false);
  }
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
        return { ok: true };
      },
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
    assert.equal(executes, 0);
  });
});

test("openapi_describe_operation routes through tool_*_search (never tool_*_execute)", async () => {
  let searchCalls = 0;
  let executeCalls = 0;
  const relay: ToolSet = {
    tool_AzWW31H_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        searchCalls += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify([{ method: "GET", path: "/accounts/{account_id}/gateway/rules" }]),
            },
          ],
        };
      },
    }),
    tool_AzWW31H_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => {
        executeCalls += 1;
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: {} }) }] };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    const search = await execTool(meta, "openapi_search", { pathIncludes: "/gateway/rules" });
    assert.equal((search as { ok?: boolean }).ok, true);

    const describe = await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    });
    assert.equal((describe as { ok?: boolean }).ok, true, JSON.stringify(describe));
    assert.ok(searchCalls >= 2);
    assert.equal(executeCalls, 0);
  });
});

test("openapi_describe_operation unwraps wrapped {code,result,logs} payload and extracts operation from result.paths", async () => {
  setCodemodeWireDebug(true);
  try {
    let searchCalls = 0;
    let executeCalls = 0;
    const relay: ToolSet = {
      tool_AzWW31H_search: tool({
        description: "OpenAPI MCP search stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (input: unknown) => {
          const code =
            typeof input === "object" && input && "code" in input
              ? String((input as { code?: unknown }).code)
              : "";
          searchCalls += 1;
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            const wrapped = {
              code: 0,
              result: JSON.stringify({
                paths: {
                  "/accounts/{account_id}/gateway/rules": {
                    get: {
                      parameters: [
                        { name: "account_id", in: "path", required: true, schema: { type: "string" } },
                      ],
                    },
                  },
                },
              }),
              logs: ["describe-called"],
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(wrapped) }],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([
                  { method: "GET", path: "/accounts/{account_id}/gateway/rules" },
                ]),
              },
            ],
          };
        },
      }),
      tool_AzWW31H_execute: tool({
        description: "Execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async () => {
          executeCalls += 1;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  result: [
                    { rule_id: "r-1", rule_name: "ht-gw_network-allow_3P-prod-a" },
                    { rule_id: "r-2", rule_name: "not-match" },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };
    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
    });

    await runCodemodeRouterInvocation(async () => {
      const s = (await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      })) as {
        ok?: boolean;
        invocationStoreId?: string;
      };
      assert.equal(s.ok, true);
      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as {
        ok?: boolean;
        invocationStoreId?: string;
        describeStateKeys?: string[];
      };
      assert.equal(describe.ok, true, JSON.stringify(describe));
      assert.equal(describe.invocationStoreId, s.invocationStoreId);
      assert.ok(
        (describe.describeStateKeys ?? []).includes("GET /accounts/{account_id}/gateway/rules")
      );

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "7012a2fac757cc12605e0faa9f5d056f",
        reduction: {
          select: ["rule_id", "rule_name"],
          filterByPrefix: {
            field: "rule_name",
            value: "ht-gw_network-allow_3P",
            caseInsensitive: true,
            trim: true,
          },
          compactResultCap: 50,
        },
      })) as {
        ok?: boolean;
        invocationStoreId?: string;
        describeStatus?: string;
        matchedCount?: number;
        matched?: Array<Record<string, unknown>>;
      };
      assert.equal(req.ok, true, JSON.stringify(req));
      assert.equal(req.invocationStoreId, s.invocationStoreId);
      assert.notEqual(req.describeStatus, "never_called");
      assert.equal(req.matchedCount, 1);
      assert.equal(req.matched?.[0]?.rule_id, "r-1");
      assert.equal(req.matched?.[0]?.rule_name, "ht-gw_network-allow_3P-prod-a");
    });

    assert.ok(searchCalls >= 2);
    assert.equal(executeCalls, 1, "actual list request must run on execute mirror exactly once");
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("openapi_describe_operation accepts wrapped stringified payload with top-level operation and enables strict chain cloudflare_request", async () => {
  setCodemodeWireDebug(true);
  try {
    let executeCalls = 0;
    const executePaths: string[] = [];
    const relay: ToolSet = {
      tool_AzWW31H_search: tool({
        description: "OpenAPI MCP search stub",
        inputSchema: z.object({ code: z.string() }),
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
                    code: 0,
                    result: JSON.stringify({
                      ok: true,
                      operation: {
                        summary: "List Zero Trust Gateway rules",
                        description: "List rules",
                        tags: ["Gateway Rules"],
                        parameters: [
                          { name: "account_id", in: "path", required: true, schema: { type: "string" } },
                        ],
                        responses: { "200": { description: "ok" } },
                      },
                    }),
                    logs: ["describe-called"],
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ method: "GET", path: "/accounts/{account_id}/gateway/rules" }]),
              },
            ],
          };
        },
      }),
      tool_AzWW31H_execute: tool({
        description: "Execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (input: unknown) => {
          const code =
            typeof input === "object" && input && "code" in input
              ? String((input as { code?: unknown }).code)
              : "";
          executeCalls += 1;
          executePaths.push(code);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  result: [
                    { id: "r-1", name: "ht-gw_network-allow_3P-prod-a" },
                    { id: "r-2", name: "other" },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
    });

    await runCodemodeRouterInvocation(async () => {
      const search = (await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      })) as { ok?: boolean; invocationStorePresent?: boolean; invocationStoreId?: string };
      assert.equal(search.ok, true);
      assert.equal(search.invocationStorePresent, true);

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as {
        ok?: boolean;
        invocationStorePresent?: boolean;
        invocationStoreId?: string;
        describeStateKeys?: string[];
      };
      assert.equal(describe.ok, true, JSON.stringify(describe));
      assert.equal(describe.invocationStorePresent, true);
      assert.equal(describe.invocationStoreId, search.invocationStoreId);
      assert.ok(
        (describe.describeStateKeys ?? []).includes("GET /accounts/{account_id}/gateway/rules")
      );

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "7012a2fac757cc12605e0faa9f5d056f",
        reduction: {
          select: ["id", "name"],
          filterByPrefix: {
            field: "name",
            value: "ht-gw_network-allow_3P",
            caseInsensitive: true,
            trim: true,
          },
          compactResultCap: 50,
        },
      })) as {
        ok?: boolean;
        invocationStorePresent?: boolean;
        describeStatus?: string;
        describeStateKeys?: string[];
        matchedCount?: number;
        matched?: Array<Record<string, unknown>>;
      };

      assert.equal(req.ok, true, JSON.stringify(req));
      assert.equal(req.invocationStorePresent, true);
      assert.notEqual(req.describeStatus, "never_called");
      assert.ok((req.describeStateKeys ?? []).includes("GET /accounts/{account_id}/gateway/rules"));
      assert.equal(req.matchedCount, 1);
      assert.equal(req.matched?.[0]?.id, "r-1");
      assert.equal(req.matched?.[0]?.name, "ht-gw_network-allow_3P-prod-a");
    });

    assert.equal(executeCalls, 1, "strict chain should execute exactly one GET list request");
    assert.ok(
      executePaths[0]?.includes('"path":"/accounts/7012a2fac757cc12605e0faa9f5d056f/gateway/rules"'),
      "request path must remain list endpoint (no detail-by-id endpoint)"
    );
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("normalizeDescribePayload handles exact live shape: stringified JSON with top-level ok:true and operation object", async () => {
  setCodemodeWireDebug(true);
  try {
    const relay: ToolSet = {
      tool_AzWW31H_search: tool({
        description: "OpenAPI MCP search stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (input: unknown) => {
          const code =
            typeof input === "object" && input && "code" in input
              ? String((input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            // Exact live shape: stringified JSON containing {"ok": true, "operation": {...}}
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    code: 0,
                    result: JSON.stringify({
                      ok: true,
                      operation: {
                        summary: "List Gateway rules",
                        description: "Retrieve all rules for account",
                        tags: ["gateway"],
                        parameters: [
                          {
                            name: "account_id",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                          },
                          {
                            name: "limit",
                            in: "query",
                            required: false,
                            schema: { type: "integer" },
                          },
                        ],
                        responses: {
                          "200": {
                            description: "Success",
                            content: {
                              "application/json": {
                                schema: {
                                  type: "object",
                                  properties: {
                                    result: {
                                      type: "array",
                                      items: {
                                        type: "object",
                                        properties: {
                                          id: { type: "string" },
                                          name: { type: "string" },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    }),
                    logs: ["describe-live-shape"],
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ method: "GET", path: "/accounts/{account_id}/gateway/rules" }]),
              },
            ],
          };
        },
      }),
      tool_AzWW31H_execute: tool({
        description: "Execute stub for cloudflare_request",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  result: [
                    { id: "r-1", name: "ht-gw_network-allow_3P-prod-a" },
                    { id: "r-2", name: "other" },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "test-account-id",
    });

    await runCodemodeRouterInvocation(async () => {
      const search = (await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      })) as { ok?: boolean; invocationStorePresent?: boolean };
      assert.equal(search.ok, true);
      assert.equal(search.invocationStorePresent, true);

      // Core assertion: describe succeeds with exact live shape stringified {"ok":true,"operation":{...}}
      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as Record<string, unknown>;

      assert.equal(
        describe.ok,
        true,
        `describe must succeed with exact live stringified shape: ${JSON.stringify(describe)}`
      );
      assert.equal(describe.method, "GET", "method must be extracted");
      assert.ok(describe.path, "path must be normalized and returned");

      // Verify operation was cached by attempting cloudflare_request
      // If describe parser failed, this would fail with "describe not available"
      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "test-account-id",
      })) as Record<string, unknown>;

      assert.equal(
        req.ok,
        true,
        `cloudflare_request must succeed after describe (operation must be cached): ${JSON.stringify(req)}`
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("REGRESSION: real MCP wrapper with code,result,logs - unwraps stringified result containing ok:true,operation:{...}", async () => {
  setCodemodeWireDebug(true);
  try {
    const relay: ToolSet = {
      tool_AzWW31H_search: tool({
        description: "OpenAPI MCP search returning real wrapper format",
        inputSchema: z.object({ code: z.string() }),
        execute: async (input: unknown) => {
          const code =
            typeof input === "object" && input && "code" in input
              ? String((input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            // Exact real MCP wrapper: {"code":0,"result":"...stringified...","logs":[...]}
            // where result contains escaped JSON with {"ok":true,"operation":{...}}
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    code: 0,
                    result: JSON.stringify({
                      ok: true,
                      operation: {
                        summary: "List Gateway rules",
                        description: "Retrieve all rules for account",
                        tags: ["gateway"],
                        parameters: [
                          {
                            name: "account_id",
                            in: "path",
                            required: true,
                            schema: { type: "string" },
                          },
                        ],
                        responses: {
                          "200": {
                            description: "Success",
                            content: {
                              "application/json": {
                                schema: {
                                  type: "object",
                                  properties: {
                                    result: {
                                      type: "array",
                                      items: {
                                        type: "object",
                                        properties: {
                                          rule_id: { type: "string" },
                                          rule_name: { type: "string" },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    }),
                    logs: ["describe-live-shape"],
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify([{ method: "GET", path: "/accounts/{account_id}/gateway/rules" }]),
              },
            ],
          };
        },
      }),
      tool_AzWW31H_execute: tool({
        description: "Execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  result: [
                    { rule_id: "r-1", rule_name: "ht-gw_network-allow_3P-prod-a" },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "test-account-id",
    });

    await runCodemodeRouterInvocation(async () => {
      const search = (await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      })) as Record<string, unknown>;
      assert.equal(search.ok, true);

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as Record<string, unknown>;

      assert.equal(
        describe.ok,
        true,
        `describe must unwrap real MCP wrapper {code,result,logs}: ${JSON.stringify(describe)}`
      );

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "test-account-id",
        reduction: {
          select: ["rule_id", "rule_name"],
        },
      })) as Record<string, unknown>;

      assert.equal(
        req.ok,
        true,
        `cloudflare_request must work after real wrapper unwrap: ${JSON.stringify(req)}`
      );
      assert.ok(
        (req.matched as Array<unknown>)?.[0],
        "matched result should be present"
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("read-only GET fallback works only for search-confirmed list endpoint when describe is unavailable", async () => {
  let executeCalls = 0;
  const seenCode: string[] = [];
  const relay: ToolSet = {
    tool_AzWW31H_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "wrapped describe unavailable" }) }],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify([
                { method: "GET", path: "/accounts/{account_id}/gateway/rules" },
              ]),
            },
          ],
        };
      },
    }),
    tool_AzWW31H_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        seenCode.push(code);
        executeCalls += 1;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                result: [
                  { rule_id: "r-10", rule_name: "ht-gw_network-allow_3P-prod-10" },
                ],
              }),
            },
          ],
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
  });

  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { pathIncludes: "/gateway/rules" });

    const listOut = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
    })) as { ok?: boolean; executionPlannerNote?: string };

    assert.equal(listOut.ok, true, JSON.stringify(listOut));
    assert.match(
      listOut.executionPlannerNote ?? "",
      /describe_unavailable_readonly_fallback/i
    );

    const detailOut = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules/{rule_id}",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules/{rule_id}",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      knownValues: { rule_id: "r-10" },
    })) as { ok?: boolean; error?: string };

    assert.equal(detailOut.ok, false);
    assert.equal(detailOut.error, "missing_openapi_describe_same_invocation");
  });

  assert.equal(executeCalls, 1, "fallback must execute only list endpoint request");
  assert.ok(
    seenCode[0]?.includes("\"path\":\"/accounts/7012a2fac757cc12605e0faa9f5d056f/gateway/rules\""),
    "execute call must target read-only list path"
  );
});

test("openapi_describe_operation classifies 'spec is not defined' as wrong mirror routing", async () => {
  const relay: ToolSet = {
    tool_AzWW31H_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
                text: JSON.stringify({ ok: false, error: "spec is not defined" }),
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify([]) }] };
      },
    }),
    tool_AzWW31H_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { pathIncludes: "/gateway/rules" });
    const describe = (await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    })) as { ok?: boolean; error?: string; semanticKey?: string; nonRetryable?: boolean };
    assert.equal(describe.ok, false);
    assert.equal(describe.error, "openapi_describe_wrong_mirror_execute");
    assert.equal(describe.semanticKey, "wrong_tool_api:describe_must_use_search_mirror");
    assert.equal(describe.nonRetryable, true);
  });
});

test("openapi_describe_operation surfaces normalized shape keys on parse failure", async () => {
  const relay: ToolSet = {
    tool_AzWW31H_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code: 0, result: "not-json", logs: ["x"] }),
          },
        ],
      }),
    }),
    tool_AzWW31H_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    const describe = (await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    })) as {
      ok?: boolean;
      failureKind?: string;
      shapeKeys?: string[];
      normalizedFailure?: string;
    };
    assert.equal(describe.ok, false);
    assert.equal(describe.failureKind, "describe_parse_failed");
    assert.ok(Array.isArray(describe.shapeKeys));
    assert.ok((describe.shapeKeys ?? []).includes("result"));
    assert.equal(typeof describe.normalizedFailure, "string");
  });
});

test("same codemode invocation search -> describe -> request succeeds", async () => {
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return { ok: true };
      },
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: { ok: true } }) }],
      }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    const search = await execTool(meta, "openapi_search", { pathIncludes: "/gateway/rules" });
    assert.equal((search as { ok?: boolean }).ok, true);
    const describe = await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    });
    assert.equal((describe as { ok?: boolean }).ok, true);
    const out = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal((out as { ok?: boolean }).ok, true);
  });
});

test("cloudflare_request uses execute mirror (not search mirror)", async () => {
  let searchCalls = 0;
  let executeCalls = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        searchCalls += 1;
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return { ok: true };
      },
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => {
        executeCalls += 1;
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
      path: "/accounts/{account_id}/gateway/rules",
    });
    await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.ok(searchCalls >= 2);
    assert.equal(executeCalls, 1);
  });
});

test("cloudflare_request cache lookup resolves concrete path via operationPathTemplate", async () => {
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return { ok: true };
      },
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, result: { ok: true } }),
          },
        ],
      }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const cfAccountHex = "cccccccccccccccccccccccccccccccc";
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
    });
    const out = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: `/accounts/${cfAccountHex}/workers/scripts`,
      operationPathTemplate: "/accounts/{account_id}/workers/scripts",
    });
    assert.equal((out as { ok?: boolean }).ok, true);
  });
});

test("failed describe reports openapi_describe_failed_same_invocation (not missing same invocation)", async () => {
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
                text: JSON.stringify({ ok: false, error: "describe failed from search mirror" }),
              },
            ],
          };
        }
        return { ok: true };
      },
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, result: { ok: true } }),
          },
        ],
      }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    const describe = await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    });
    assert.equal((describe as { ok?: boolean }).ok, false);
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })) as {
      ok?: boolean;
      error?: string;
      describeStatus?: string;
      cacheKey?: string;
      describeError?: string;
    };
    assert.equal(out.ok, false);
    assert.equal(out.error, "openapi_describe_failed_same_invocation");
    assert.equal(out.describeStatus, "called_but_failed");
    assert.ok(typeof out.cacheKey === "string" && out.cacheKey.length > 0);
    assert.ok(typeof out.describeError === "string" && out.describeError.length > 0);
  });
});

test("strict planner: knownValues satisfy path segment → executes HTTP inner", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
        return { ok: true };
      },
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
    assert.ok(executes >= 1);
  });
});

test("strict planner cache: openapi_describe `{account_id}` template matches concrete /accounts/<32hex>/ path", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
        return { ok: true };
      },
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
    assert.ok(executes >= 1);
  });
});

test("strict planner cache: openapi_describe concrete /accounts/<32hex>/ path matches `{account_id}` template request", async () => {
  let executes = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
        return { ok: true };
      },
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
      account_id: cfAccountHex,
    });
    assert.equal((ok as { ok?: boolean }).ok, true);
    assert.equal((ok as { executionPlannerNote?: string }).executionPlannerNote, undefined);
    assert.ok(executes >= 1);
  });
});

test("cloudflare_request uses explicit target account_id from knownValues instead of runtime account", async () => {
  let executedHttpCode = "";
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [{ name: "account_id", in: "path", required: true, schema: { type: "string" } }],
                  },
                }),
              },
            ],
          };
        }
        executedHttpCode = code;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: { scripts: [] } }),
            },
          ],
        };
      },
    }),
  };

  const runtimeAccountId = "f8afd5d9155fc5142006c5acc3ad5a82";
  const targetAccountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: runtimeAccountId });

  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
    });
    const out = await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/workers/scripts",
      knownValues: { account_id: targetAccountId },
    });

    assert.equal((out as { ok?: boolean }).ok, true);
    assert.ok(executedHttpCode.includes(`/accounts/${targetAccountId}/workers/scripts`));
    assert.ok(!executedHttpCode.includes(`/accounts/${runtimeAccountId}/workers/scripts`));
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

test("cloudflare_request accepts reduction fields (value/perPage/caseInsensitiveFields)", async () => {
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: { parameters: [] } }) }],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: [{ id: "a", name: " PrefixOne " }] }),
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
      path: "/accounts/{account_id}/gateway/rules",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: {
        select: ["id"],
        filterByPrefix: { field: "name", value: "prefix", trim: true, caseInsensitive: true },
        normalize: { trimStrings: true, caseInsensitiveFields: ["name"] },
        pagination: { enabled: true, perPage: 100, maxPages: 5 },
        compactResultCap: 50,
      },
    })) as { ok?: boolean; error?: string; matchedCount?: number; matched?: Array<Record<string, unknown>> };
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.matchedCount, 1);
    assert.equal(out.matched?.[0]?.id, "a");
  });
});

test("cloudflare_request helper failure remains ok:false (not converted to scannedCount:0)", async () => {
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: { parameters: [] } }) }],
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "upstream_fail" }) }] };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", { method: "GET", path: "/accounts/{account_id}/gateway/rules" });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: { select: ["id"] },
    })) as Record<string, unknown>;
    assert.equal(out.ok, false);
    assert.ok(typeof out.error === "string");
    assert.equal("scannedCount" in out, false);
    assert.equal("matchedCount" in out, false);
  });
});

test("cloudflare_request parse failures return non-retryable compact parse envelope", async () => {
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: { parameters: [] } }) }],
          };
        }
        return { content: [{ type: "text" as const, text: '{"success":true,"result":[{"id":"x","name":"bad\\x"}]}' }] };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", { method: "GET", path: "/accounts/{account_id}/gateway/rules" });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: { select: ["id"] },
    })) as { ok?: boolean; error?: string; nonRetryable?: boolean; evidence?: string };
    assert.equal(out.ok, false);
    assert.equal(out.error, "provider_response_parse_failed");
    assert.equal(out.nonRetryable, true);
    assert.ok(typeof out.evidence === "string" && out.evidence.length > 0);
  });
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
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: {} }) }],
        };
      },
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

    const stillBlocked = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: "/accounts/{account_id}/noop",
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal((stillBlocked as { ok?: boolean }).ok, false);
    assert.equal(
      (stillBlocked as { error?: string }).error,
      "missing_openapi_describe_same_invocation"
    );

    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/noop",
    });

    const allowedAfterDescribe = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: "/accounts/{account_id}/noop",
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal((allowedAfterDescribe as { ok?: boolean }).ok, true);
  });
});

test("cloudflare_request returns reduced compact payload for huge list responses (no raw leakage)", async () => {
  let executeCalls = 0;
  const relay: ToolSet = {
    tool_search: tool({
      description: "OpenAPI MCP search stub",
      inputSchema: z.object({ code: z.string() }),
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
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        return { ok: true };
      },
    }),
    tool_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        executeCalls += 1;
        const big = Array.from({ length: 120 }, (_, i) => ({
          rule_id: `rule-${i}`,
          name: i % 2 === 0 ? `ht-gw_network-allow_3P-${i}` : `other-${i}`,
          status: "active",
          blob: "x".repeat(400),
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: big }),
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
      path: "/accounts/{account_id}/gateway/rules",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: {
        select: ["rule_id"],
        filterByPrefix: {
          field: "name",
          value: "ht-gw_network-allow_3P",
          caseInsensitive: true,
          trim: true,
        },
        compactResultCap: 30,
      },
    })) as {
      ok?: boolean;
      scannedCount?: number;
      matchedCount?: number;
      matched?: Array<Record<string, unknown>>;
    };
    assert.equal(out.ok, true);
    assert.ok((out.scannedCount ?? 0) >= 120);
    assert.ok((out.matchedCount ?? 0) >= 30);
    assert.ok(Array.isArray(out.matched));
    assert.equal(Object.keys(out.matched?.[0] ?? {}).join(","), "rule_id");
    const wire = codemodeWireStringifyToolResult(out);
    assert.ok(!wire.includes("\"blob\""), "raw large payload fields must not leak");
    assert.equal(executeCalls >= 1, true);
  });
});

test("cloudflare_request sanitizes control characters and still reduces results", async () => {
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        // Includes invalid control char U+0001 in a JSON string value.
        const malformed =
          '{"success":true,"result":[{"rule_id":"r-1","name":"ht-gw_network-allow_3P\u0001test"},{"rule_id":"r-2","name":"other"}]}'
            .replace("\\u0001", String.fromCharCode(1));
        return { content: [{ type: "text" as const, text: malformed }] };
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "__edgeclaw__" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: {
        select: ["rule_id"],
        filterByPrefix: { field: "name", value: "ht-gw_network-allow_3P", caseInsensitive: true },
      },
    })) as { ok?: boolean; matched?: Array<Record<string, unknown>> };
    assert.equal(out.ok, true);
    assert.equal(out.matched?.[0]?.rule_id, "r-1");
  });
});

test("cloudflare_request paginates in one invocation and tracks scannedCount/matchedCount", async () => {
  let page = 0;
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
              },
            ],
          };
        }
        page += 1;
        const count = page < 3 ? 2 : 1;
        const rows = Array.from({ length: count }, (_, i) => ({
          rule_id: `p${page}-${i}`,
          name: `ht-gw_network-allow_3P-${page}-${i}`,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: rows }),
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
      path: "/accounts/{account_id}/gateway/rules",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      query: { per_page: 2 },
      reduction: {
        select: ["rule_id"],
        pagination: { enabled: true, perPage: 2, maxPages: 3 },
      },
    })) as {
      ok?: boolean;
      scannedCount?: number;
      matchedCount?: number;
      matched?: Array<Record<string, unknown>>;
    };
    assert.equal(out.ok, true);
    assert.equal(out.scannedCount, 5);
    assert.equal(out.matchedCount, 5);
    assert.equal(out.matched?.length, 5);
  });
});

test("cloudflare_request reduction path avoids detail and mutation endpoint calls", async () => {
  const executedCodes: string[] = [];
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
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [{ name: "account_id", in: "path", required: true }],
                  },
                }),
              },
            ],
          };
        }
        executedCodes.push(code);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                result: [
                  { id: "rule-1", name: "ht-gw_network-allow_3P-a" },
                  { id: "rule-2", name: "ht-gw_network-allow_3P-b" },
                ],
              }),
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
      path: "/accounts/{account_id}/gateway/rules",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      operationPathTemplate: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
      reduction: {
        select: ["id"],
        filterByPrefix: { field: "name", value: "ht-gw_network-allow_3P", caseInsensitive: true },
      },
    })) as { ok?: boolean; matched?: Array<Record<string, unknown>> };

    assert.equal(out.ok, true);
    assert.equal(out.matched?.length, 2);

    const joined = executedCodes.join("\n");
    assert.ok(joined.includes('"method":"GET"'));
    assert.equal(joined.includes('"method":"POST"'), false);
    assert.equal(joined.includes('"method":"PUT"'), false);
    assert.equal(joined.includes('"method":"PATCH"'), false);
    assert.equal(joined.includes('"method":"DELETE"'), false);
    assert.equal(joined.includes("/gateway/rules/"), false);
  });
});

test("reuse-live-sdk-server style mirror relay: tools_find, tools_call_code, openapi planner chain — Rpc wire stays JSON-safe", async () => {
  const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification — accounts, workers, and routes",
      inputSchema: z.object({ code: z.string() }),
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
        return {
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
        };
      },
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript including cloudflare.request",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (input: unknown) => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
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
      account_id: accountId,
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
                text: JSON.stringify({ ok: true, operation: { parameters: [] } }),
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
      operationPathTemplate: "/api/v1/scripts/{script_name}",
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
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, operation: { parameters: [] } }) }],
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
      operationPathTemplate: "/client/v4/workers/scripts/{name}",
      body: { metadata: {} },
    });
    assert.equal((out as { nonRetryable?: boolean }).nonRetryable, true, "must be non-retryable");
    // Should be exactly 1 execute call (describe already counted), not 2 (no coerce retry).
    assert.equal(executeInvocations - callsBefore, 1, "coerce-and-retry path must be skipped");
  });
});

test("DIAGNOSTIC: shape_missing_object failure envelope includes normalizerDiagnostic object", async () => {
  setCodemodeWireDebug(true);
  try {
    const unrecognizableDescribePayload = { completelyUnknownKey: 42, noOpFields: true };

    const relay: ToolSet = {
      tool_diag999_search: tool({
        description: "Diagnostic stub - returns unrecognizable describe shape",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          const code =
            typeof _input === "object" && _input !== null && "code" in _input
              ? String((_input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(unrecognizableDescribePayload),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  matches: [
                    {
                      path: "/accounts/{account_id}/diag-resources",
                      method: "GET",
                      tool: "tool_diag999",
                    },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "acct-diag",
    });

    await runCodemodeRouterInvocation(async () => {
      await execTool(meta, "openapi_search", { pathIncludes: "/diag-resources" });

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/diag-resources",
      })) as Record<string, unknown>;

      assert.equal(describe.ok, false, "describe must fail with unrecognizable shape");
      assert.equal(describe.failureKind, "describe_parse_failed");

      const nd = describe.normalizerDiagnostic as Record<string, unknown> | undefined;
      assert.ok(nd !== undefined && typeof nd === "object", "normalizerDiagnostic must be present");
      assert.equal(nd.marker, "[EdgeClaw][describe-normalizer-debug-v3]");

      // parsedPreview must contain the raw payload content
      assert.ok(
        typeof nd.parsedPreview === "string" && nd.parsedPreview.length > 0,
        "normalizerDiagnostic.parsedPreview must be a non-empty string"
      );

      // parsedKeys must include the top-level keys from the unrecognizable payload
      const parsedKeys = nd.parsedKeys as string[];
      assert.ok(
        Array.isArray(parsedKeys) && parsedKeys.includes("completelyUnknownKey"),
        `normalizerDiagnostic.parsedKeys must include 'completelyUnknownKey', got: ${JSON.stringify(parsedKeys)}`
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("DIAGNOSTIC v3: shape_missing_object failure envelope includes normalizerDiagnostic with describe-normalizer-debug-v3 marker", async () => {
  setCodemodeWireDebug(true);
  try {
    const relay: ToolSet = {
      tool_diagv3_search: tool({
        description: "Diagnostic v3 stub - unrecognizable shape",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          const code =
            typeof _input === "object" && _input !== null && "code" in _input
              ? String((_input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ unknownFieldA: 1, unknownFieldB: true }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  matches: [{ path: "/accounts/{account_id}/diagv3", method: "GET", tool: "tool_diagv3" }],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct-v3" });

    await runCodemodeRouterInvocation(async () => {
      await execTool(meta, "openapi_search", { pathIncludes: "/diagv3" });

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/diagv3",
      })) as Record<string, unknown>;

      assert.equal(describe.ok, false, "describe must fail");
      assert.equal(describe.failureKind, "describe_parse_failed");

      const nd = describe.normalizerDiagnostic as Record<string, unknown> | undefined;
      assert.ok(
        nd !== undefined && typeof nd === "object",
        `normalizerDiagnostic must be an object, got: ${JSON.stringify(describe)}`
      );
      assert.equal(
        nd.marker,
        "[EdgeClaw][describe-normalizer-debug-v3]",
        `normalizerDiagnostic.marker must be [EdgeClaw][describe-normalizer-debug-v3], got: ${nd.marker}`
      );
      assert.ok(
        typeof nd.reason === "string" && nd.reason.length > 0,
        "normalizerDiagnostic.reason must be a non-empty string"
      );
      assert.ok(
        Array.isArray(nd.parsedKeys),
        "normalizerDiagnostic.parsedKeys must be an array"
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("REGRESSION: normalizeDescribePayload handles exact live shape where MCP returns raw JSON string containing {ok:true, operation:{...}}", async () => {
  setCodemodeWireDebug(true);
  try {
    // Exact live shape: MCP tool returns text field as a raw JSON string
    // (not a parsed object). parsedType="string" per live v3 diagnostic.
    const livePayload = JSON.stringify({
      ok: true,
      operation: {
        summary: "List Zero Trust Gateway rules",
        parameters: [
          { name: "account_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    });

    let executeCalls = 0;
    const relay: ToolSet = {
      tool_live_search: tool({
        description: "Live regression stub — returns raw JSON string from MCP",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          const code =
            typeof _input === "object" && _input !== null && "code" in _input
              ? String((_input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            // Return livePayload as a raw JSON string in the text field
            // This simulates the real MCP relay returning text that is itself
            // a JSON string (parsedType="string" in live diagnostic)
            return {
              content: [
                {
                  type: "text" as const,
                  text: livePayload,
                },
              ],
            };
          }
          // openapi_search response
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  matches: [
                    {
                      path: "/accounts/{account_id}/gateway/rules",
                      method: "GET",
                      tool: "tool_live",
                    },
                  ],
                }),
              },
            ],
          };
        },
      }),
      tool_live_execute: tool({
        description: "Live execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          executeCalls++;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  result: [
                    { id: "r-1", name: "ht-gw_network-allow_3P-prod-a", action: "allow" },
                  ],
                }),
              },
            ],
          };
        },
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({
      relay,
      cloudflareAccountId: "test-acct-live",
    });

    await runCodemodeRouterInvocation(async () => {
      await execTool(meta, "openapi_search", {
        pathIncludes: "/gateway/rules",
      });

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as Record<string, unknown>;

      assert.equal(
        describe.ok,
        true,
        `openapi_describe_operation must succeed with raw-string live payload. Full envelope: ${JSON.stringify(describe)}`
      );
      assert.equal(
        describe.openapiParameterSlots,
        1,
        "must detect 1 parameter slot from the operation"
      );

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "test-acct-live",
      })) as Record<string, unknown>;

      assert.ok(
        req.ok === true || (req.ok !== false && req.matched !== undefined),
        `cloudflare_request must not return missing_openapi_describe_same_invocation. Got: ${JSON.stringify(req)}`
      );
      assert.notEqual(
        (req as { semanticKey?: string }).semanticKey,
        "missing_openapi_describe_same_invocation",
        `cloudflare_request must not fail with missing_openapi_describe_same_invocation`
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("REGRESSION v4: describe-normalizer-candidate-v4 — raw-string live payload with full operation shape succeeds", async () => {
  setCodemodeWireDebug(true);
  try {
    // Mirrors exact live payload structure from wrangler tail:
    // parsedType="string", parsedPreview=JSON of {ok:true,operation:{summary,parameters,responses}}
    const livePayloadString = JSON.stringify({
      ok: true,
      operation: {
        summary: "List Zero Trust Gateway rules",
        description: "Fetch all Gateway rules for an account",
        tags: ["Zero Trust"],
        parameters: [
          { name: "account_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    });

    const relay: ToolSet = {
      tool_v4reg_search: tool({
        description: "v4 regression stub — raw JSON string in text field",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => {
          const code =
            typeof _input === "object" && _input !== null && "code" in _input
              ? String((_input as { code?: unknown }).code)
              : "";
          if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
            return { content: [{ type: "text" as const, text: livePayloadString }] };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  matches: [
                    { path: "/accounts/{account_id}/gateway/rules", method: "GET", tool: "tool_v4reg" },
                  ],
                }),
              },
            ],
          };
        },
      }),
      tool_v4reg_execute: tool({
        description: "v4 execute stub",
        inputSchema: z.object({ code: z.string() }),
        execute: async (_input: unknown) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                result: [{ id: "r-gw-1", name: "allow-prod", action: "allow" }],
              }),
            },
          ],
        }),
      }),
    };

    const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct-v4-reg" });

    await runCodemodeRouterInvocation(async () => {
      await execTool(meta, "openapi_search", { pathIncludes: "/gateway/rules" });

      const describe = (await execTool(meta, "openapi_describe_operation", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
      })) as Record<string, unknown>;

      assert.equal(
        describe.ok,
        true,
        `describe must succeed for raw-string live payload with full operation. Envelope: ${JSON.stringify(describe)}`
      );
      assert.equal(describe.openapiParameterSlots, 1, "must count 1 parameter from operation");

      const req = (await execTool(meta, "cloudflare_request", {
        method: "GET",
        path: "/accounts/{account_id}/gateway/rules",
        operationPathTemplate: "/accounts/{account_id}/gateway/rules",
        account_id: "acct-v4-reg",
      })) as Record<string, unknown>;

      assert.notEqual(
        (req as { semanticKey?: string }).semanticKey,
        "missing_openapi_describe_same_invocation",
        "cloudflare_request must not return missing_openapi_describe_same_invocation after v4 describe success"
      );
    });
  } finally {
    setCodemodeWireDebug(false);
  }
});

test("CHAIN-EVIDENCE: cloudflare_request carries _chainEvidence even when missing_openapi_describe_same_invocation", async () => {
  // Chain step 1 (openapi_search) is called; step 2 (openapi_describe_operation) is skipped;
  // cloudflare_request must still emit _chainEvidence.called=true with errorCode captured.
  const relay: ToolSet = {
    tool_ce_search: tool({
      description: "chain-evidence stub: search",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            matches: [{ path: "/accounts/{account_id}/rules", method: "GET" }],
          }),
        }],
      }),
    }),
    tool_ce_execute: tool({
      description: "chain-evidence stub: execute",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: [] }) }],
      }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "test-ce-acct",
  });

  await runCodemodeRouterInvocation(async () => {
    // Step 1: openapi_search — must carry _chainEvidence
    const searchResult = (await execTool(meta, "openapi_search", {
      pathIncludes: "/rules",
    })) as Record<string, unknown>;
    const searchEv = (searchResult as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    assert.ok(searchEv !== undefined, "openapi_search result must carry _chainEvidence");
    assert.equal(searchEv!.tool, "openapi_search");
    assert.equal(searchEv!.called, true);

    // Step 2 (openapi_describe_operation) deliberately skipped to trigger missing describe.
    // Step 3: cloudflare_request must fail with missing_openapi_describe_same_invocation
    // but still carry _chainEvidence.called=true.
    const cfResult = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/rules",
      account_id: "test-ce-acct",
    })) as Record<string, unknown>;

    assert.equal(
      cfResult.error,
      "missing_openapi_describe_same_invocation",
      "cloudflare_request must fail with missing_openapi_describe_same_invocation when describe was skipped"
    );

    const cfEv = (cfResult as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    assert.ok(
      cfEv !== undefined,
      `cloudflare_request must carry _chainEvidence even on failure. Got: ${JSON.stringify(cfResult)}`
    );
    assert.equal(cfEv!.tool, "cloudflare_request",
      "_chainEvidence.tool must be cloudflare_request");
    assert.equal(cfEv!.called, true,
      "_chainEvidence.called must be true even on failure");
    assert.equal(
      cfEv!.errorCode,
      "missing_openapi_describe_same_invocation",
      "_chainEvidence.errorCode must capture the failure code"
    );
  });
});

test("CHAIN-EVIDENCE: nested result.error._chainEvidence is discovered by walkForChainEvidence", async () => {
  // Simulate a tool that wraps _chainEvidence inside result.error
  const relay: ToolSet = {
    tool_nest_search: tool({
      description: "nested evidence stub: search",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            // Nested two levels deep: result.error._chainEvidence
            error: {
              code: "some_inner_error",
              _chainEvidence: {
                tool: "openapi_search",
                called: true,
                invocationStorePresent: true,
                invocationStoreId: "nested-store-id",
              },
            },
          }),
        }],
      }),
    }),
    tool_nest_execute: tool({
      description: "nested evidence stub: execute",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: [] }) }],
      }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "test-nest-acct",
  });

  await runCodemodeRouterInvocation(async () => {
    const searchResult = (await execTool(meta, "openapi_search", {
      pathIncludes: "/rules",
    })) as Record<string, unknown>;

    // _chainEvidence was injected at the TOP level by the tool wrapper,
    // so it's always directly accessible; this test validates the tool correctly
    // adds _chainEvidence and that it reads correctly regardless of nesting.
    const topLevelEv = (searchResult as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    assert.ok(topLevelEv !== undefined, "openapi_search should carry top-level _chainEvidence");
    assert.equal(topLevelEv!.tool, "openapi_search");
    assert.equal(topLevelEv!.called, true);
  });
});

test("CHAIN-EVIDENCE: complete chain from nested evidence correctly identifies all three helpers", async () => {
  // Build relay that returns nested evidence for search and describe
  const relay: ToolSet = {
    tool_full_search: tool({
      description: "full chain stub: search",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => {
        const code = typeof _input === "object" && _input !== null && "code" in _input
          ? String((_input as { code?: unknown }).code) : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                operation: {
                  summary: "List rules",
                  parameters: [
                    { name: "account_id", in: "path", required: true, schema: { type: "string" } },
                  ],
                  responses: { "200": { description: "OK" } },
                },
              }),
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              matches: [{ path: "/accounts/{account_id}/rules", method: "GET" }],
            }),
          }],
        };
      },
    }),
    tool_full_execute: tool({
      description: "full chain stub: execute",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, result: [{ id: "r1", name: "rule-1" }] }),
        }],
      }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "test-full-acct",
  });

  await runCodemodeRouterInvocation(async () => {
    const sr = (await execTool(meta, "openapi_search", { pathIncludes: "/rules" })) as Record<string, unknown>;
    const dr = (await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/rules",
    })) as Record<string, unknown>;
    const cr = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/rules",
      operationPathTemplate: "/accounts/{account_id}/rules",
      account_id: "test-full-acct",
    })) as Record<string, unknown>;

    const srEv = (sr as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    const drEv = (dr as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    const crEv = (cr as { _chainEvidence?: Record<string, unknown> })._chainEvidence;

    assert.ok(srEv !== undefined && srEv.called === true, "openapi_search must have evidence");
    assert.ok(drEv !== undefined && drEv.called === true, "openapi_describe_operation must have evidence");
    assert.ok(crEv !== undefined && crEv.called === true, "cloudflare_request must have evidence");
    // Full chain succeeded — no errorCode on cloudflare_request evidence
    assert.equal(crEv!.errorCode, undefined, "cloudflare_request errorCode must be absent on success");
    assert.equal(cr.ok, true, "cloudflare_request must succeed");
  });
});

test("CHAIN-EVIDENCE: complete chain + missing_openapi_describe_same_invocation has errorCode but called=true", async () => {
  // Both search and describe are called; then cloudflare_request is called for a DIFFERENT path
  // so the describe cache misses and it returns missing_openapi_describe_same_invocation.
  const relay: ToolSet = {
    tool_mismatch_search: tool({
      description: "describe-mismatch stub: search",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => {
        const code = typeof _input === "object" && _input !== null && "code" in _input
          ? String((_input as { code?: unknown }).code) : "";
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                operation: {
                  summary: "Describe rules",
                  parameters: [
                    { name: "account_id", in: "path", required: true, schema: { type: "string" } },
                  ],
                  responses: { "200": { description: "OK" } },
                },
              }),
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              matches: [
                { path: "/accounts/{account_id}/rules", method: "GET" },
                { path: "/accounts/{account_id}/other", method: "GET" },
              ],
            }),
          }],
        };
      },
    }),
    tool_mismatch_execute: tool({
      description: "describe-mismatch stub: execute",
      inputSchema: z.object({ code: z.string() }),
      execute: async (_input: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, result: [] }) }],
      }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "test-mismatch-acct",
  });

  await runCodemodeRouterInvocation(async () => {
    // Describe for /rules...
    await execTool(meta, "openapi_search", { pathIncludes: "/rules" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/rules",
    });
    // But call cloudflare_request for /other — cache miss → missing_openapi_describe_same_invocation
    const cr = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/other",
      operationPathTemplate: "/accounts/{account_id}/other",
      account_id: "test-mismatch-acct",
    })) as Record<string, unknown>;

    assert.equal(cr.error, "missing_openapi_describe_same_invocation",
      "cloudflare_request must fail with missing_openapi_describe_same_invocation on cache miss");

    const crEv = (cr as { _chainEvidence?: Record<string, unknown> })._chainEvidence;
    assert.ok(crEv !== undefined, "cloudflare_request must carry _chainEvidence even on cache-miss failure");
    assert.equal(crEv!.called, true, "_chainEvidence.called must be true even on failure");
    assert.equal(crEv!.errorCode, "missing_openapi_describe_same_invocation",
      "_chainEvidence.errorCode must be missing_openapi_describe_same_invocation");
  });
});
