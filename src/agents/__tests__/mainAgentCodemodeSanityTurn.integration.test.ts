/**
 * Structural integration tests for Codemode sanity ↔ Gateway surface wiring.
 *
 * {@link MainAgent.beforeTurn} delegates compression + sanity merge + planner visibility to
 * {@link deriveMainAgentCodemodeCompressionTurn} so we can validate behavior in Node/tsx without
 * instantiating Think / MainAgent (those pull `@cloudflare/think/tools/execute`, which Node cannot resolve).
 *
 * Sanity execution itself is mocked by passing deterministic `sanityOutcome` values (matching
 * `runCodemodeRelayRouterSanity` results). Deployed Worker code uses {@link MainAgentConfig.codemodeSanityProbe}
 * only when injecting the same mocks at the DO boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { deriveMainAgentCodemodeCompressionTurn } from "../mainAgentCodemodeCompressionTurn";
import { resolveCodemodeToolSurfaceCompression } from "../../tools/codemodeToolSurfaceResolve";
import type { CodemodeSanityRunnerResult } from "../../tools/codemodeRouterSanity";
import {
  classifyMergedToolsForSurface,
  planMinimalToolSurface,
} from "../../tools/toolSurfacePolicy";
import { isAssistantReplySilentAfterCodemodes } from "../../tools/codemodeVisibleFallback";

const stub = tool({
  description: "stub",
  inputSchema: z.object({}),
  execute: async (): Promise<object> => ({}),
});

function eligibilityOpen(): ReturnType<typeof resolveCodemodeToolSurfaceCompression> {
  return resolveCodemodeToolSurfaceCompression({
    envGloballyAllows: true,
    userCodemodeToolSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
}

/** Registry shape mirroring Think-merged MCP + Skills + relays (beforeTurn overlays `codemode` separately). */
function sampleMergedThinkRegistry(): ToolSet {
  return {
    load_context: stub,
    unload_context: stub,
    mcp_search_docs_search: stub,
    openapi_tool_cloudflare_execute: stub,
    read: stub,
    grep: stub,
  };
}

test("parity: deriveMainAgentCodemodeCompressionTurn matches direct planMinimalToolSurface when sanity passes", () => {
  const merged = sampleMergedThinkRegistry();
  const pre = eligibilityOpen();
  assert.equal(pre.effective, true);
  const sanityOk: CodemodeSanityRunnerResult = {
    ok: true,
    registeredMethods: "tools_find,tools_call",
  };
  const view = deriveMainAgentCodemodeCompressionTurn({
    mergedTools: merged,
    compressionPreSanity: pre,
    sanityOutcome: sanityOk,
    codemodeAutoFallbackToLegacyTools: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  const directPlan = planMinimalToolSurface({
    mergedTools: merged,
    codemodeSurfaceEnabled: view.finalCompression.effective,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(directPlan.reason, "codemode-surface-applied-default");
  assert.deepEqual(
    view.gatewayVisibleToolNamesSorted,
    [...new Set(["codemode", ...directPlan.directNames])].sort()
  );
  assert.equal(view.gatewayUnrestrictedSchemas, false);
  assert.equal(view.fallbackToLegacy, false);
  assert.equal(view.finalCompression.effective, true);
  assert.equal(view.finalCompression.reason, "enabled_by_setting");
  assert.deepEqual(view.sanityTelemetryStatus, "ok");
  assert.ok(view.gatewayVisibleToolNamesSorted.includes("codemode"));
  assert.ok(view.gatewayVisibleToolNamesSorted.includes("load_context"));
  assert.ok(view.gatewayVisibleToolNamesSorted.includes("unload_context"));
  assert.ok(!view.gatewayVisibleToolNamesSorted.includes("mcp_search_docs_search"));
});

test("sanity plumbing failure + autoFallback: legacy wide Gateway, telemetry fallback set, no banner", () => {
  const merged = sampleMergedThinkRegistry();
  const pre = eligibilityOpen();
  const failRpc: CodemodeSanityRunnerResult = {
    ok: false,
    reason:
      'RPC receiver does not implement method "tools_find" — codemode router miswired',
  };
  const view = deriveMainAgentCodemodeCompressionTurn({
    mergedTools: merged,
    compressionPreSanity: pre,
    sanityOutcome: failRpc,
    codemodeAutoFallbackToLegacyTools: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(view.finalCompression.effective, false);
  assert.equal(view.finalCompression.reason, "disabled_sanity_failed");
  assert.equal(view.gatewayUnrestrictedSchemas, true);
  assert.equal(view.visibleSanityBanner, null);
  assert.equal(view.fallbackToLegacy, true);
  assert.deepEqual(view.sanityTelemetryStatus, "failed");
  assert.ok(view.gatewayVisibleToolNamesSorted.includes("mcp_search_docs_search"));
  assert.ok(view.gatewayVisibleToolNamesSorted.includes("load_context"));
});

test("sanity failure without autoFallback: visible banner avoids silent Done-only transcripts", () => {
  const merged = sampleMergedThinkRegistry();
  const pre = eligibilityOpen();
  const view = deriveMainAgentCodemodeCompressionTurn({
    mergedTools: merged,
    compressionPreSanity: pre,
    sanityOutcome: { ok: false, reason: "codemode_undefined sandbox surface" },
    codemodeAutoFallbackToLegacyTools: false,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.ok(view.visibleSanityBanner && view.visibleSanityBanner.includes("sanity check failed"));
  assert.equal(isAssistantReplySilentAfterCodemodes(view.visibleSanityBanner!), false);
});

test("MCP + Skills hosts stay in merged registry across compressed vs sane-fail wide paths", () => {
  const merged = sampleMergedThinkRegistry();
  const pre = eligibilityOpen();
  const okView = deriveMainAgentCodemodeCompressionTurn({
    mergedTools: merged,
    compressionPreSanity: pre,
    sanityOutcome: { ok: true, registeredMethods: "tools_find" },
    codemodeAutoFallbackToLegacyTools: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  const failView = deriveMainAgentCodemodeCompressionTurn({
    mergedTools: merged,
    compressionPreSanity: pre,
    sanityOutcome: { ok: false, reason: "rpc_receiver:oops" },
    codemodeAutoFallbackToLegacyTools: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(okView.gatewayVisibleToolNamesSorted.includes("mcp_search_docs_search"), false);
  assert.equal(failView.gatewayVisibleToolNamesSorted.includes("mcp_search_docs_search"), true);

  /** Host-merge keys never disappear — classify sees wrapped MCP/OpenAPI-ish tools consistently. */
  const cls = classifyMergedToolsForSurface(merged);
  assert.ok(cls.direct.has("load_context"));
  assert.ok(cls.direct.has("unload_context"));
  assert.ok([...cls.wrapped].some((n) => n.startsWith("mcp_")));
});
