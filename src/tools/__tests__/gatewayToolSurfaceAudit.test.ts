import test from "node:test";
import assert from "node:assert/strict";
import { classifyMergedToolsForSurface, planMinimalToolSurface } from "../toolSurfacePolicy";
import {
  simulateProviderVisibleToolKeys,
  buildAiGatewayToolsAuditSnapshot,
} from "../gatewayToolSurfaceAudit";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

const stubTool = tool({
  description: "stub",
  inputSchema: z.object({}),
  execute: async (): Promise<object> => ({}),
});

/** Mirrors Think `_runInferenceLoop` `{ ...assembled, ...TurnConfig.tools }` before wrappers. */
function mergeThinkStyleToolKeys(registryKeys: string[], overlayKeys: string[]): string[] {
  return [...new Set([...registryKeys, ...overlayKeys])];
}

test("Gateway visibility: unrestricted when activeTools is undefined (legacy mode)", () => {
  const allKeys = mergeThinkStyleToolKeys(["read", "mcp_ping", "write"], []);
  assert.deepEqual(
    simulateProviderVisibleToolKeys(allKeys, undefined),
    allKeys
  );
});

test("Gateway visibility: codemode compression hides MCP/OpenAPI stubs from payload", () => {
  const registryKeys = mergeThinkStyleToolKeys(
    ["read", "mcp_github_search", "browser_session", "write", "list_workflows"],
    ["codemode"]
  );

  const mergedTools = registryKeys.reduce<ToolSet>((acc, name) => {
    acc[name] = stubTool;
    return acc;
  }, {});

  const plan = planMinimalToolSurface({
    mergedTools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(plan.reason, "codemode-surface-applied-default");

  const gatewayActiveOrdered = [...new Set(["codemode", ...plan.directNames])];
  const visible = simulateProviderVisibleToolKeys(registryKeys, gatewayActiveOrdered);

  const sortedExpected = [...gatewayActiveOrdered].sort();
  const sortedActual = [...visible].sort();
  assert.deepEqual(sortedActual, sortedExpected);
  assert.ok(!visible.includes("mcp_github_search"));
  assert.ok(visible.includes("codemode"));
});

test("MCP approval-gated tools stay direct — visible when policy marks them direct", () => {
  const tools: ToolSet = {
    mcp_delete_everything: {
      ...stubTool,
      needsApproval: true,
    },
    mcp_safe_read: stubTool,
  };
  const { direct, wrapped } = classifyMergedToolsForSurface(tools);
  assert.ok(direct.has("mcp_delete_everything"));
  assert.ok(wrapped.has("mcp_safe_read"));

  const plan = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(plan.reason, "codemode-surface-applied-default");
  assert.ok(plan.directNames.includes("mcp_delete_everything"));
  assert.ok(!plan.directNames.includes("mcp_safe_read"));

  const registryKeys = Object.keys(tools);
  const active = [...new Set(["codemode", ...plan.directNames])];
  const visible = simulateProviderVisibleToolKeys(registryKeys, active);
  assert.ok(visible.includes("mcp_delete_everything"));
  assert.ok(!visible.includes("mcp_safe_read"));
});

test("Skills session bridge: load_context / unload_context classify as direct (not hidden)", () => {
  const tools: ToolSet = {
    load_context: stubTool,
    unload_context: stubTool,
    read: stubTool,
  };
  const { wrapped, direct } = classifyMergedToolsForSurface(tools);
  assert.ok(direct.has("load_context"));
  assert.ok(direct.has("unload_context"));
  assert.ok(wrapped.has("read"));
});

test("Multi-step inference: overriding activeTools dominates any wider prepareStep parent", () => {
  const parentPrepareStepReturn = {
    activeTools: ["browser_search", "browser_execute", "read", "mcp_wide"],
    model: undefined,
  };
  const frozen = ["codemode", "browser_session"];

  const coerced = {
    ...parentPrepareStepReturn,
    activeTools: frozen,
  };

  assert.deepEqual(coerced.activeTools, frozen);
});

test("buildAiGatewayToolsAuditSnapshot attaches codemode binding label", () => {
  const tools: ToolSet = { codemode: stubTool, write: stubTool };
  const snap = buildAiGatewayToolsAuditSnapshot(tools, ["codemode", "write"]);
  assert.equal(snap.bindings.codemode, "codemode_relay_shell");
  assert.equal(snap.bindings.write, "registered");
});
