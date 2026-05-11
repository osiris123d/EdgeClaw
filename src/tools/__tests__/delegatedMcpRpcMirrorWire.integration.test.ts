/**
 * Delegated MCP mirror: Agents RPC requires structuredClone-safe payloads; JSON round-trip after
 * sanitization must preserve OpenAPI / Cloudflare API shapes for codemode helpers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodemodeRelayMetaToolSet } from "../codemodeRelayMetaTools";
import { toDelegatedMcpRpcWireValue } from "../codemodeRouterHelpers";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";

class DurableObjectStub {}

class RpcTarget {}

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

test("simulated MainAgent rpcExecuteDelegatedMcpTool envelope is structuredClone-safe after wire helper", () => {
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
  const parsed = JSON.parse(env.resultWire) as unknown;
  const again = toDelegatedMcpRpcWireValue(parsed);
  assert.deepEqual(again, parsed);
});

test("tools_call_code on mirrored ids returns openapi + Cloudflare-like JSON without neutral serialization error", async () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> =>
        toDelegatedMcpRpcWireValue({
          endpoints: [{ method: "GET", path: "/accounts/{account_id}/workers/scripts", summary: "List Workers" }],
          leak: new DurableObjectStub(),
        }),
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<unknown> =>
        toDelegatedMcpRpcWireValue({
          success: true,
          result: { scripts: [{ name: "demo-worker" }] },
          leak: new RpcTarget(),
        }),
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  await runCodemodeRouterInvocation(async () => {
    const searchOut = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_search",
      code: `async () => ({ probe: "mirror-search" })`,
    });
    assert.equal((searchOut as { ok?: boolean }).ok, true, JSON.stringify(searchOut));
    const sr = (searchOut as { result?: { endpoints?: Array<{ path?: string; summary?: string }> } }).result;
    assert.ok(Array.isArray(sr?.endpoints));
    assert.equal(sr?.endpoints?.[0]?.path, "/accounts/{account_id}/workers/scripts");
    assert.equal(sr?.endpoints?.[0]?.summary, "List Workers");
    assert.match(JSON.stringify(searchOut), /List Workers/);
    assert.doesNotMatch(JSON.stringify(searchOut), /Delegated tool returned a non-serializable value/);

    const execOut = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_execute",
      code: `async () => ({ probe: "mirror-exec" })`,
    });
    assert.equal((execOut as { ok?: boolean }).ok, true, JSON.stringify(execOut));
    const er = (execOut as { result?: { success?: boolean; result?: { scripts?: Array<{ name?: string }> } } }).result;
    assert.equal(er?.success, true);
    assert.equal(er?.result?.scripts?.[0]?.name, "demo-worker");
    assert.doesNotMatch(JSON.stringify(execOut), /Delegated tool returned a non-serializable value/);
  });
});
