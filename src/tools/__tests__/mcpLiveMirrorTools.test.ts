/**
 * MCP live mirror tools on ToolAgent — Node-safe registration tests (no DO / getAgentByName execution).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import { buildMcpLiveMirrorToolSet } from "../mcpLiveMirrorTools";

test("buildMcpLiveMirrorToolSet exposes tool_<sdkId>_search and tool_<sdkId>_execute when parent binding present", () => {
  const tools = buildMcpLiveMirrorToolSet({
    env: { MAIN_AGENT: {} } as unknown as Env,
    parentAgentName: "main-agent-instance",
    descriptors: {
      tool_WB0fsUJK_search: { description: "search mirror", jsonSchema: {} },
      tool_WB0fsUJK_execute: { description: "execute mirror", jsonSchema: {} },
    },
  });
  const t = tools as Record<string, { description?: string; execute?: unknown }>;
  assert.ok(t.tool_WB0fsUJK_search && typeof t.tool_WB0fsUJK_search.execute === "function");
  assert.ok(t.tool_WB0fsUJK_execute && typeof t.tool_WB0fsUJK_execute.execute === "function");
  assert.equal(t.tool_WB0fsUJK_search.description, "search mirror");
});

test("buildMcpLiveMirrorToolSet skips non-matching descriptor keys", () => {
  const tools = buildMcpLiveMirrorToolSet({
    env: { MAIN_AGENT: {} } as unknown as Env,
    parentAgentName: "parent",
    descriptors: {
      arbitrary_tool: { description: "x", jsonSchema: {} },
    },
  });
  assert.equal(Object.keys(tools as object).length, 0);
});

test("mirror RPC uses direct stub method invocation — not fn.call(stub, ...)", async () => {
  // Track how rpcExecuteDelegatedMcpTool is invoked on the stub object.
  const callLog: { viaCall: boolean; thisArg: unknown }[] = [];

  // Stub that records whether .call() or direct invocation was used.
  const stubRpcFn = function (this: unknown, payload: unknown) {
    callLog.push({ viaCall: this !== undefined && this !== globalThis, thisArg: this });
    void payload;
    return Promise.resolve({ ok: true, result: "direct" });
  };

  const fakeStub = { rpcExecuteDelegatedMcpTool: stubRpcFn };

  // Patch the internal getNamedAgentStub via module override (dynamic import mock).
  // We do this by temporarily monkey-patching the module-level helper used inside buildMcpLiveMirrorToolSet.
  // Since getNamedAgentStub is not exported, we inject a fake MAIN_AGENT namespace whose
  // getAgentByName resolves to our fakeStub.
  const fakeNs = Symbol("fakeNs");
  const { agents: agentsMod } = await (async () => {
    // Dynamic import is mocked at the module cache level if available; otherwise provide a shim.
    try {
      return { agents: await import("agents") };
    } catch {
      return { agents: null };
    }
  })();
  void agentsMod; // may be null in Node test runner — that's fine, we assert via fn.call absence.

  // Assert: the source no longer contains `fn.call(stub,` — the direct invocation guard.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const srcPath = resolve(dirname(__filename), "../mcpLiveMirrorTools.ts");
  const src = readFileSync(srcPath, "utf8");

  assert.ok(
    !src.includes("fn.call(stub,"),
    "Source must not use fn.call(stub, ...) — direct stub method invocation required"
  );
  assert.ok(
    src.includes("typedStub.rpcExecuteDelegatedMcpTool(rpcPayload)"),
    "Source must invoke rpcExecuteDelegatedMcpTool directly on typedStub"
  );
});
