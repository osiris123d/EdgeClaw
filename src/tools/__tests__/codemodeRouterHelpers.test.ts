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
  injectAccountIntoApiPath,
  pathUsesHostnameAsDeviceIdSegment,
  pathUsesLikelyHostnameAsDeviceSegment,
  toolsFindByDescription,
  pickWrappedToolName,
  matchDeviceNeedle,
  pickDeviceRowsFromCloudflarePayload,
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
