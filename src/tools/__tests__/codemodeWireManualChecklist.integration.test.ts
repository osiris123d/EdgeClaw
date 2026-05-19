/**
 * Operator “manual checklist” for delegated MCP → codemode wire safety (Node, no Worker).
 *
 * Run:
 *   npm run test:codemode-wire-manual-checklist
 * or:
 *   npx tsx --test src/tools/__tests__/codemodeWireManualChecklist.integration.test.ts
 *
 * Live Workers still need `globalThis.EDGECLAW_CODEMODE_WIRE_DEBUG = true` for console probes;
 * this file only asserts serialization / helper outcomes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodemodeRelayMetaToolSet } from "../codemodeRelayMetaTools";
import { toDelegatedMcpRpcWireValue } from "../codemodeRouterHelpers";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";

const NEUTRAL = "Delegated tool returned a non-serializable value (internal).";
const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class DurableObjectStub {}
class RpcTarget {}

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

function mcpTextJson(obj: unknown, leak: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    leak,
  } as Record<string, unknown>;
}

test("checklist: rpcExecuteDelegatedMcpTool envelope stays structuredClone-safe after wire helper", () => {
  const raw = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify([{ method: "GET", path: "/demo", summary: "Demo" }]),
      },
    ],
    leak: new DurableObjectStub(),
  };
  const wired = toDelegatedMcpRpcWireValue(raw);
  const env = { ok: true as const, resultWire: JSON.stringify(wired) };
  assert.doesNotThrow(() => structuredClone(env));
});

test("checklist: openapi_search returns parsed endpoints when MCP payload nests non-cloneable leaks", async () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> =>
        mcpTextJson([{ method: "GET", path: "/accounts/{account_id}/zones", summary: "List zones" }], new DurableObjectStub()),
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> => mcpTextJson({ ok: true }, new RpcTarget()),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: ACCOUNT_ID });

  await runCodemodeRouterInvocation(async () => {
    const out = (await execTool(meta, "openapi_search", { pathIncludes: "zones" })) as {
      ok?: boolean;
      endpoints?: unknown;
      error?: string;
    };
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(Array.isArray(out.endpoints));
    const row = (out.endpoints as { path?: string }[])[0];
    assert.equal(row?.path, "/accounts/{account_id}/zones");
    assert.doesNotMatch(JSON.stringify(out), new RegExp(NEUTRAL.replace(/[()]/g, "\\$&")));
  });
});

test("checklist: cloudflare_request returns Cloudflare-style envelope when execute nests RpcTarget leak", async () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (input: { code?: string }): Promise<unknown> => {
        if (typeof input?.code === "string" && input.code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return mcpTextJson(
            {
              ok: true,
              operation: { parameters: [{ name: "account_id", in: "path", required: true }] },
            },
            new DurableObjectStub()
          );
        }
        return mcpTextJson([{ method: "GET", path: "/accounts/{account_id}/zones" }], new DurableObjectStub());
      },
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> => {
        return mcpTextJson(
          {
            success: true,
            result: { zones: [{ id: "zone1", name: "example.com" }] },
          },
          new RpcTarget()
        );
      },
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: ACCOUNT_ID });

  await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { pathIncludes: "zones" });
    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/zones",
    });
    const out = (await execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/zones",
      operationPathTemplate: "/accounts/{account_id}/zones",
      knownValues: { account_id: ACCOUNT_ID },
    })) as { ok?: boolean; result?: { zones?: Array<{ id?: string }> }; error?: string };
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.result?.zones?.[0]?.id, "zone1");
    assert.doesNotMatch(JSON.stringify(out), new RegExp(NEUTRAL.replace(/[()]/g, "\\$&")));
  });
});

test("checklist: tools_call_code stays ok:true with wired leaky MCP execute result", async () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search stub",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> =>
        toDelegatedMcpRpcWireValue({
          endpoints: [{ method: "GET", path: "/x" }],
          leak: new DurableObjectStub(),
        }),
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute stub",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> =>
        toDelegatedMcpRpcWireValue({
          success: true,
          result: { scripts: [{ name: "demo-worker" }] },
          leak: new RpcTarget(),
        }),
    }),
  };
  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: ACCOUNT_ID });

  await runCodemodeRouterInvocation(async () => {
    const searchOut = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_search",
      code: `async () => ({ probe: "mirror-search" })`,
    });
    assert.equal((searchOut as { ok?: boolean }).ok, true);
    assert.doesNotMatch(JSON.stringify(searchOut), /Delegated tool returned a non-serializable value/);
  });
});

test("checklist: neutral serialization error only when execute throws RPC-like noise, not on leaky return", async () => {
  const relayThrow: ToolSet = {
    tool_sdk_search: tool({
      description: "Search",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> => {
        throw new Error('Could not serialize object of type "DurableObject"');
      },
    }),
    tool_sdk_execute: tool({
      description: "Execute",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> => ({ ok: true }),
    }),
  };
  const metaThrow = createCodemodeRelayMetaToolSet({ relay: relayThrow, cloudflareAccountId: ACCOUNT_ID });

  await runCodemodeRouterInvocation(async () => {
    const bad = (await execTool(metaThrow, "openapi_search", { pathIncludes: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    assert.equal(bad.ok, false);
    assert.equal(bad.error, NEUTRAL);
  });
});
