/**
 * ToolAgent Codemode relay plumbing — Node-safe (merged MCP tools → wrapped relay → openapi_search).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import { pickWrappedToolName } from "../../tools/codemodeRouterHelpers";
import { planMinimalToolSurface, pickToolsByName } from "../../tools/toolSurfacePolicy";
import { deriveMainAgentCodemodeCompressionTurn } from "../mainAgentCodemodeCompressionTurn";
import { resolveCodemodeToolSurfaceCompression } from "../../tools/codemodeToolSurfaceResolve";

test("Minimal tool plan wraps MCP tools and relay picks a search tool when tool_*_search exists", () => {
  const mergedTools = {
    list_project_notes: { description: "notes" },
    tool_cloudflare_openapi_search: {
      description: "OpenAPI search",
      execute: async () => ({ ok: true }),
    },
    tool_cloudflare_accounts_http_request: {
      description: "execute",
      execute: async () => ({ ok: true }),
    },
  } as unknown as ToolSet;

  const compressionPreSanity = resolveCodemodeToolSurfaceCompression({
    envGloballyAllows: true,
    userCodemodeToolSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  const turnView = deriveMainAgentCodemodeCompressionTurn({
    mergedTools,
    compressionPreSanity,
    sanityOutcome: undefined,
    codemodeAutoFallbackToLegacyTools: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  const plan = planMinimalToolSurface({
    mergedTools,
    codemodeSurfaceEnabled: turnView.finalCompression.effective,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  assert.equal(plan.reason, "codemode-surface-applied-default");
  const relay = pickToolsByName(mergedTools, plan.wrappedNames);
  const searchName = pickWrappedToolName(relay, "search");
  assert.ok(searchName, "expected wrapped MCP OpenAPI search tool in relay");
  assert.match(searchName!, /search/);
});
