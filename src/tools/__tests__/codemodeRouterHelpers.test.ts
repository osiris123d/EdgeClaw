/**
 * Codemode router helpers — semantic discovery, path safety, MCP parsing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  assertValidAsyncArrowSource,
  buildCloudflareRequestInnerCode,
  buildOpenApiDescribeOperationInnerCode,
  buildOpenapiSearchInnerCode,
  codemodeWireSafeErrorMessage,
  codemodeWireStringifyToolResult,
  coerceDelegatedRpcOkEnvelopeResult,
  coerceStandaloneStructuredClonePortable,
  ensureJsonSafeForCodemodeRelay,
  injectAccountIntoApiPath,
  pathUsesHostnameAsDeviceIdSegment,
  pathUsesLikelyHostnameAsDeviceSegment,
  toolsFindByDescription,
  pickWrappedToolName,
  matchDeviceNeedle,
  pickDeviceRowsFromCloudflarePayload,
  toCodemodeWireSerializable,
  toDelegatedMcpRpcWireValue,
  tryParseJsonFromMcpToolResult,
  DEFAULT_DEVICE_LIST_PATH_TEMPLATES,
} from "../codemodeRouterHelpers";

test("tools_find ranks by description keywords (opaque ids)", () => {
  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI spec. Products: dex, …",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({}),
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute JavaScript against the Cloudflare API. First use search…",
      inputSchema: z.object({ code: z.string() }),
      execute: async () => ({}),
    }),
  };
  const matches = toolsFindByDescription("Cloudflare DEX", relay);
  assert.ok(matches.some((m) => m.name === "tool_WB0fsUJK_search"));
  assert.ok(matches.some((m) => m.name === "tool_WB0fsUJK_execute"));
  matches.forEach((m) => assert.ok(m.score > 0));
});

test("buildOpenApiDescribeOperationInnerCode targets spec.paths and carries describe marker", () => {
  const code = buildOpenApiDescribeOperationInnerCode({ method: "GET", path: "/pets/{petId}" });
  assert.ok(code.includes("EDGECLAW_OPENAPI_DESCRIBE"));
  assert.ok(code.includes("spec.paths"));
  assert.ok(code.includes("/pets/{petId}"));
});

test("openapi_search inner code mentions spec.paths but exposes no outer spec binding", () => {
  const code = buildOpenapiSearchInnerCode({ tag: "dex" });
  assert.ok(code.includes("spec.paths"));
  assert.ok(code.includes('"tag":"dex"') || code.includes('"dex"'));
});

test("buildCloudflareRequestInnerCode serializes GET path into inner cloudflare.request", () => {
  const code = buildCloudflareRequestInnerCode({
    method: "GET",
    path: "/accounts/acct/dex/tests/overview",
  });
  assert.ok(code.includes("cloudflare.request"));
  assert.ok(code.includes("/accounts/acct/dex/tests/overview"));
});

test("injectAccountIntoApiPath replaces {account_id}", () => {
  assert.equal(injectAccountIntoApiPath("/accounts/{account_id}/dex/x", "aid"), "/accounts/aid/dex/x");
});

test("assertValidAsyncArrowSource rejects non-async-arrow", () => {
  assert.throws(() => assertValidAsyncArrowSource("function() {}"), /async arrow/);
  assert.ok(assertValidAsyncArrowSource("async () => 1").startsWith("async"));
});

test("pickWrappedToolName finds tool_* suffix", () => {
  const relay: ToolSet = {
    grep: tool({ description: "x", inputSchema: z.object({}), execute: async () => {} }),
    tool_AA_search: tool({ description: "s", inputSchema: z.object({}), execute: async () => {} }),
    tool_AA_execute: tool({ description: "e", inputSchema: z.object({}), execute: async () => {} }),
  };
  assert.equal(pickWrappedToolName(relay, "search"), "tool_AA_search");
  assert.equal(pickWrappedToolName(relay, "execute"), "tool_AA_execute");
});

test("tryParseJsonFromMcpToolResult unwraps MCP text JSON", () => {
  const raw = {
    content: [{ type: "text", text: JSON.stringify({ a: 1 }) }],
  };
  assert.deepEqual(tryParseJsonFromMcpToolResult(raw), { a: 1 });
});

test("resolve_device_identifier list paths never embed hostname as /devices/:id segment", () => {
  const host = "MEMHQ2375GK1";
  for (const tmpl of DEFAULT_DEVICE_LIST_PATH_TEMPLATES) {
    const path = tmpl.replace(/\{account_id\}/g, "acct-example");
    assert.equal(pathUsesHostnameAsDeviceIdSegment(path, host), false);
    assert.equal(pathUsesLikelyHostnameAsDeviceSegment(path), false);
  }
  assert.equal(pathUsesLikelyHostnameAsDeviceSegment(`/accounts/x/dex/devices/${host}/live`), true);
});

test("pickDeviceRowsFromCloudflarePayload + matchDeviceNeedle", () => {
  const payload = {
    success: true,
    result: [
      { device_id: "550e8400-e29b-41d4-a716-446655440000", serial_number: "MEMHQ2375GK1", name: "Desk" },
    ],
  };
  const rows = pickDeviceRowsFromCloudflarePayload(payload);
  const cand = matchDeviceNeedle(rows, "MEMHQ2375GK1");
  assert.equal(cand[0]?.deviceId, "550e8400-e29b-41d4-a716-446655440000");
});

class DurableObjectStub {}

test("toCodemodeWireSerializable neutralizes host-object constructors for Rpc wire", () => {
  const sanitized = toCodemodeWireSerializable({
    ok: true,
    nested: new DurableObjectStub(),
    keep: { a: 1 },
  }) as { nested: string; keep: { a: number } };
  assert.equal(sanitized.nested, "[DurableObjectStub]");
  assert.deepEqual(sanitized.keep, { a: 1 });
});

test("codemodeWireStringifyToolResult produces JSON even when payloads nest exotic stubs", () => {
  const wire = codemodeWireStringifyToolResult({
    endpoints: [{ x: new DurableObjectStub() }],
  });
  const parsed = JSON.parse(wire) as { result?: { endpoints?: Array<{ x: string }> } };
  assert.ok(parsed.result);
  assert.equal(parsed.result!.endpoints![0]!.x, "[DurableObjectStub]");
});

test("ensureJsonSafeForCodemodeRelay round-trips after toCodemodeWireSerializable", () => {
  class RpcTarget {}
  const out = ensureJsonSafeForCodemodeRelay({ a: 1, x: new RpcTarget() }) as { a: number; x: string };
  assert.equal(out.a, 1);
  assert.equal(out.x, "[RpcTarget]");
});

test("codemodeWireSafeErrorMessage never throws on exotic errors", () => {
  const msg = codemodeWireSafeErrorMessage(
    new Error(
      'Could not serialize object of type "DurableObject". This type does not support serialization.'
    )
  );
  assert.ok(msg.length > 0);
  assert.match(msg, /Delegated tool returned a non-serializable value/);
  assert.doesNotMatch(msg, /DurableObject/i);
});

test("codemodeWireSafeErrorMessage preserves [EdgeClaw] diagnostics that quote Rpc clone noise", () => {
  const inner = 'Could not serialize object of type "DurableObject"';
  const msg = codemodeWireSafeErrorMessage(
    new Error(`[EdgeClaw] coerceDelegatedRpcOkEnvelopeResult: envelope_clone_failed (${inner})`)
  );
  assert.match(msg, /^\[EdgeClaw\] coerceDelegatedRpcOkEnvelopeResult/);
  assert.match(msg, /DurableObject/i);
  assert.doesNotMatch(msg, /Delegated tool returned a non-serializable value \(internal\)/);
});

test("toDelegatedMcpRpcWireValue yields structuredClone-safe envelopes for Agents RPC", () => {
  class DurableObjectStub {}
  const wired = toDelegatedMcpRpcWireValue({
    content: [{ type: "text", text: JSON.stringify({ ok: true, endpoints: [{ path: "/a" }] }) }],
    leak: new DurableObjectStub(),
  }) as { content: unknown[]; leak: string };
  assert.equal(wired.leak, "[DurableObjectStub]");
  assert.doesNotThrow(() => structuredClone({ ok: true, result: wired }));
});

test("toDelegatedMcpRpcWireValue stringifies bigint and stays structuredClone-safe", () => {
  const wired = toDelegatedMcpRpcWireValue({ count: 42n }) as { count: string };
  assert.equal(wired.count, "42");
  assert.doesNotThrow(() => structuredClone(wired));
});

test("toDelegatedMcpRpcWireValue json replacer neutralizes blocked ctor during stringify", () => {
  class RpcTarget {}
  const wired = toDelegatedMcpRpcWireValue({ x: new RpcTarget() }) as { x: string };
  assert.equal(wired.x, "[RpcTarget]");
  assert.doesNotThrow(() => structuredClone(wired));
});

test("coerceDelegatedRpcOkEnvelopeResult keeps MainAgent Rpc return envelope structuredClone-safe", () => {
  const wired = toDelegatedMcpRpcWireValue({
    content: [{ type: "text", text: JSON.stringify([{ method: "GET", path: "/x" }]) }],
  }) as Record<string, unknown>;
  const out = coerceDelegatedRpcOkEnvelopeResult(wired);
  assert.deepEqual(out, wired);
  assert.doesNotThrow(() => structuredClone({ ok: true, result: out }));
});

test("coerceStandaloneStructuredClonePortable normalizes MCP-shaped payload for RPC return", () => {
  class DurableObjectStub {}
  const leaky = {
    content: [{ type: "text", text: JSON.stringify({ ok: true, endpoints: [] }) }],
    extra: new DurableObjectStub(),
  };
  const out = coerceStandaloneStructuredClonePortable(
    toDelegatedMcpRpcWireValue(leaky)
  ) as { content: unknown[]; extra: string };
  assert.equal(typeof out.extra, "string");
  assert.ok(String(out.extra).includes("DurableObject"));
  assert.doesNotThrow(() => structuredClone(out));
});

test("codemodeWireStringifyToolResult returns JSON for cyclic nested payload", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const wire = codemodeWireStringifyToolResult({ bad: cyclic });
  const data = JSON.parse(wire) as { result?: unknown };
  assert.ok(data.result !== undefined);
});
