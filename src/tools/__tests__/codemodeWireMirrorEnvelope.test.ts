/**
 * Regression: mirrored MCP / delegated RPC payloads must become plain JSON before crossing Codemode + Agents RPC.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodemodeRelayMetaToolSet } from "../codemodeRelayMetaTools";
import {
  codemodeWireSafeErrorMessage,
  codemodeWireStringifyToolEnvelope,
  codemodeWireStringifyToolResult,
  toCodemodeWireSerializable,
} from "../codemodeRouterHelpers";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";

class DurableObjectStub {}

/** Stand-in for Workers `RpcTarget` constructor name checks (local empty class). */
class RpcTarget {}

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

test("toCodemodeWireSerializable replaces blocked constructors under result, Error.cause, logs, meta", () => {
  const err = new Error("wrapper", { cause: new RpcTarget() as unknown as Error });
  const input = {
    result: { x: new DurableObjectStub(), y: 1 },
    error: err,
    logs: [{ line: 1, ctx: new RpcTarget() }],
    meta: { trace: new DurableObjectStub() },
  };
  const safe = toCodemodeWireSerializable(input) as Record<string, unknown>;
  assert.equal((safe.result as { x: string }).x, "[DurableObjectStub]");
  assert.equal((safe.result as { y: number }).y, 1);
  const errOut = safe.error as { message?: string; cause?: string };
  assert.ok(typeof errOut.message === "string");
  assert.equal(errOut.cause, "[RpcTarget]");
  assert.equal(((safe.logs as unknown[])[0] as { ctx: string }).ctx, "[RpcTarget]");
  assert.equal(((safe.meta as { trace: string }).trace), "[DurableObjectStub]");
});

test("codemodeWireStringifyToolEnvelope never throws; JSON.parse succeeds; placeholders for blocked types", () => {
  const wire = codemodeWireStringifyToolEnvelope({
    ok: false,
    error: new Error("top", { cause: new DurableObjectStub() as unknown as Error }),
    logs: [new RpcTarget()],
    meta: { nested: new DurableObjectStub() },
    result: { ok: true, data: new RpcTarget() },
  });
  assert.doesNotThrow(() => JSON.parse(wire));
  const parsed = JSON.parse(wire) as { result: Record<string, unknown> };
  assert.ok(parsed.result);
  assert.equal((parsed.result.result as { data: string }).data, "[RpcTarget]");
  assert.ok(Array.isArray(parsed.result.logs));
  assert.equal((parsed.result.logs as string[])[0], "[RpcTarget]");
});

test("codemodeWireSafeErrorMessage flattens Error cause chains with RpcTarget into safe strings", () => {
  const msg = codemodeWireSafeErrorMessage(
    new Error("outer", { cause: new Error("inner", { cause: new RpcTarget() as unknown as Error }) })
  );
  assert.ok(msg.includes("outer"));
  assert.ok(msg.includes("cause:"));
  assert.ok(msg.includes("[RpcTarget]"));
});

test("ToolAgent-style relay: tools_call_code + tools_find tolerate nested host-like objects in raw execute payloads", async () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI specification",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (input: unknown): Promise<unknown> => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("search-inner")) {
          return { endpoints: [{ path: "/example", summary: "ExampleOp", stub: new DurableObjectStub() }] };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify([{ method: "GET", path: "/example", summary: "ExampleOp" }]),
            },
          ],
        };
      },
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute Cloudflare API JavaScript",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (input: unknown): Promise<unknown> => {
        const code =
          typeof input === "object" && input && "code" in input
            ? String((input as { code?: unknown }).code)
            : "";
        if (code.includes("execute-inner")) {
          return {
            success: true,
            result: { scripts: [], ptr: new RpcTarget() },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                result: { scripts: [] },
              }),
            },
          ],
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  await runCodemodeRouterInvocation(async () => {
    const find = (await execTool(meta, "tools_find", { query: "OpenAPI" })) as {
      matches?: Array<{ name: string }>;
    };
    assert.ok(find.matches?.some((m) => m.name === "tool_WB0fsUJK_search"));

    const searchCode = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_search",
      code: `async () => ({ probe: "search-inner" })`,
    });
    assert.equal((searchCode as { ok?: boolean }).ok, true);
    const ep = (searchCode as { result?: { endpoints?: Array<{ stub?: string }> } }).result?.endpoints;
    assert.ok(Array.isArray(ep));
    assert.equal(ep![0]!.stub, "[DurableObjectStub]");
    const searchWire = codemodeWireStringifyToolResult(searchCode);
    const searchParsed = JSON.parse(searchWire) as { result: unknown };
    assert.doesNotThrow(() => JSON.stringify(searchParsed.result));

    const execCode = await execTool(meta, "tools_call_code", {
      toolName: "tool_WB0fsUJK_execute",
      code: `async () => ({ probe: "execute-inner" })`,
    });
    assert.equal((execCode as { ok?: boolean }).ok, true);
    const r = (execCode as { result?: { success?: boolean; result?: { scripts?: unknown[]; ptr?: string } } }).result;
    assert.equal(r?.success, true);
    assert.ok(Array.isArray(r?.result?.scripts));
    assert.equal(r?.result?.ptr, "[RpcTarget]");
    assert.doesNotThrow(() => JSON.parse(codemodeWireStringifyToolResult(execCode)));
  });
});
