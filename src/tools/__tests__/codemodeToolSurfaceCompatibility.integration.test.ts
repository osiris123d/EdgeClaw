/**
 * ENABLE_CODEMODE_TOOL_SURFACE compatibility — integration-style regressions mirroring Think + AI SDK.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { classifyMergedToolsForSurface, planMinimalToolSurface } from "../toolSurfacePolicy";
import {
  assertToolRunnableInRegistry,
  diagnosePrepareStepWidenAgainstFreeze,
  mergePrepareStepWithFrozenActiveTools,
  simulateProviderVisibleToolKeys,
} from "../gatewayToolSurfaceAudit";

const stubTool = tool({
  description: "stub",
  inputSchema: z.object({}),
  execute: async (): Promise<object> => ({}),
});

function augmentedRegistryKeys(registryKeys: string[], overlayKeys: string[]): string[] {
  return [...new Set([...registryKeys, ...overlayKeys])];
}

test("diagnosePrepareStepWidenAgainstFreeze emits when superclass/extensions add tools beyond freeze", () => {
  const frozen = ["codemode", "load_context", "write"];
  const msg = diagnosePrepareStepWidenAgainstFreeze(frozen, {
    activeTools: [...frozen, "mcp_github_search"],
  });
  assert.ok(msg?.includes("mcp_github_search"));
});

test("diagnosePrepareStepWidenAgainstFreeze stays quiet when prepareStep narrows or matches freeze", () => {
  assert.equal(diagnosePrepareStepWidenAgainstFreeze(["a", "b"], { activeTools: ["a"] }), undefined);
  assert.equal(diagnosePrepareStepWidenAgainstFreeze(["a", "b"], { activeTools: ["a", "b"] }), undefined);
  assert.equal(diagnosePrepareStepWidenAgainstFreeze(null, { activeTools: ["x"] }), undefined);
});

test("Equivalent planner outcome when sanity forces compression off vs user toggle off", () => {
  const mergedTools: ToolSet = {
    load_context: stubTool,
    mcp_documents_search: stubTool,
    read: stubTool,
  };

  const wouldCompress = planMinimalToolSurface({
    mergedTools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(wouldCompress.reason, "codemode-surface-applied-default");

  const sanityFailedWide = planMinimalToolSurface({
    mergedTools,
    codemodeSurfaceEnabled: false,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(sanityFailedWide.reason, "codemode-surface-disabled");
  /** Sanity failure should match this wide path so MCP + skills schemas stay Gateway-visible again. */
  const visibleWide = simulateProviderVisibleToolKeys(Object.keys(mergedTools), undefined);
  assert.ok(visibleWide.includes("mcp_documents_search"));
  assert.ok(visibleWide.includes("load_context"));
});

test("continuation steps stay clamped — mergePrepareStepWithFrozenActiveTools over malicious widen attempts", () => {
  const frozen = ["codemode", "load_context", "unload_context", "write"] as const;
  const widenParent = {
    activeTools: ["codemode", "load_context", "unload_context", "write", "mcp_wide", "read"],
    model: undefined,
  };
  const step0 = mergePrepareStepWithFrozenActiveTools([...frozen], widenParent);
  const step1 = mergePrepareStepWithFrozenActiveTools([...frozen], widenParent);
  const step2 = mergePrepareStepWithFrozenActiveTools([...frozen], widenParent);

  assert.deepEqual(step0?.activeTools, [...frozen]);
  assert.deepEqual(step1?.activeTools, [...frozen]);
  assert.deepEqual(step2?.activeTools, [...frozen]);
  assert.ok(diagnosePrepareStepWidenAgainstFreeze([...frozen], widenParent));
});

test("ENABLE_CODEMODE_TOOL_SURFACE=false ⇒ legacy unrestricted Gateway semantics (undefined activeTools)", () => {
  const mergedTools: ToolSet = {
    mcp_ping: stubTool,
    grep: stubTool,
    codemode: stubTool,
  };
  const plan = planMinimalToolSurface({
    mergedTools,
    codemodeSurfaceEnabled: false,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(plan.reason, "codemode-surface-disabled");

  const registryKeys = Object.keys(mergedTools);
  const visible = simulateProviderVisibleToolKeys(registryKeys, undefined);
  assert.deepEqual([...visible].sort(), [...registryKeys].sort());

  assert.strictEqual(
    mergePrepareStepWithFrozenActiveTools(null, undefined),
    undefined
  );
  /** Unfrozen forwards parent `prepareStep` hints verbatim. */
  const fwd = mergePrepareStepWithFrozenActiveTools(null, { activeTools: ["mcp_ping"] });
  assert.deepEqual(fwd?.activeTools, ["mcp_ping"]);
});

test("Skills/session tools remain direct alongside Codemode compression when sandbox + flag are on", () => {
  const mergedTools: ToolSet = {
    load_context: stubTool,
    unload_context: stubTool,
    grep: stubTool,
    codemode: stubTool,
  };
  assert.ok(classifyMergedToolsForSurface(mergedTools).direct.has("load_context"));
  assert.ok(classifyMergedToolsForSurface(mergedTools).direct.has("unload_context"));
});

/**
 * Mirrors one Think turn: assembled registry ∪ beforeTurn `{ codemode }`, then narrowed `activeTools`.
 * Subsequent “continuation” steps replay beforeStep clamps.
 */
test("Integration — MCP excluded from Gateway payload, runnable on host; skills direct; Codemode on", () => {
  const mergedBaseregistry: ToolSet = {
    load_context: stubTool,
    unload_context: stubTool,
    browser_session: stubTool,
    mcp_documents_search: stubTool,
    read: stubTool,
    grep: stubTool,
  };

  const plan = planMinimalToolSurface({
    mergedTools: mergedBaseregistry,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(plan.reason, "codemode-surface-applied-default");

  /** Think merges TurnConfig `{ codemode }` atop ctx.tools — union keys for outbound request assembly. */
  const overlayCodemode = ["codemode"];
  const allKeysSorted = augmentedRegistryKeys(Object.keys(mergedBaseregistry), overlayCodemode).sort();

  const gatewayActive = [...new Set(["codemode", ...plan.directNames])];

  assert.ok(plan.directNames.includes("load_context"));
  assert.ok(plan.directNames.includes("unload_context"));

  /** Gateway-visible schemas (AI SDK filtering). */
  const visibleSorted = simulateProviderVisibleToolKeys(allKeysSorted, gatewayActive).sort();
  assert.ok(!visibleSorted.includes("mcp_documents_search"));
  assert.ok(!visibleSorted.includes("grep"));
  assert.ok(visibleSorted.includes("codemode"));

  /** Skills load/ununload tools stay advertised for direct invocation (never wrapped behind Codemode). */
  assert.ok(visibleSorted.includes("load_context"));
  assert.ok(visibleSorted.includes("unload_context"));

  /** Host execution map still exposes MCP definitions for codemode.tools_call / Think execute */
  assertToolRunnableInRegistry(mergedBaseregistry, "mcp_documents_search");

  /** Continuation-ish steps: superclass tries to widen; clamp restores freeze. */
  const frozenGateway = [...gatewayActive];
  for (let step = 0; step < 3; step += 1) {
    const widen = {
      activeTools: [...allKeysSorted],
      fakeStep: step,
    };
    assert.ok(diagnosePrepareStepWidenAgainstFreeze(frozenGateway, widen));
    const clamped = mergePrepareStepWithFrozenActiveTools(frozenGateway, widen);
    const stepVisibleSorted = simulateProviderVisibleToolKeys(allKeysSorted, clamped?.activeTools).sort();
    assert.deepEqual(stepVisibleSorted, [...frozenGateway].sort());
    assert.ok(!stepVisibleSorted.includes("mcp_documents_search"));
    assert.ok(!stepVisibleSorted.includes("grep"));
  }
});
