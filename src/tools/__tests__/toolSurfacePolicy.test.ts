import test from "node:test";
import assert from "node:assert/strict";
import { classifyMergedToolsForSurface, planMinimalToolSurface } from "../toolSurfacePolicy";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import {
  estimateActiveToolSurfaceTokens,
  estimateMergedToolSurfaceTokens,
} from "../toolSurfaceTelemetry";

const stubTool = tool({
  description: "stub",
  inputSchema: z.object({}),
  execute: async (): Promise<object> => ({}),
});
test("classification keeps approval and HITL tools direct", () => {
  const tools = {
    mcp_ping: stubTool,
    openapi_search_paths: stubTool,
    browser_search: stubTool,
    browser_session: stubTool,
    read: stubTool,
    schedule_task: stubTool,
    run_workflow: stubTool,
    set_context: stubTool,
    write: stubTool,
  } satisfies ToolSet;

  const { direct, wrapped, excluded } = classifyMergedToolsForSurface(tools);

  assert.equal(excluded.has("codemode"), false);
  assert.ok(direct.has("browser_session"));
  assert.ok(direct.has("schedule_task"));
  assert.ok(direct.has("run_workflow"));
  assert.ok(direct.has("write"));
  assert.ok(direct.has("set_context"));
  assert.ok(wrapped.has("mcp_ping"));
  assert.ok(wrapped.has("openapi_search_paths"));
  assert.ok(wrapped.has("browser_search"));
  assert.ok(wrapped.has("read"));
});

test("planMinimalToolSurface compresses MCP/OpenAPI names into wrapped set when sandbox available", () => {
  const tools = {
    mcp_github_search: stubTool,
    openapi_execute_request: stubTool,
    grep: stubTool,
    cancel_task: stubTool,
    browser_session: stubTool,
    write: stubTool,
  } satisfies ToolSet;

  const plan = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  assert.equal(plan.reason, "codemode-surface-applied-default");
  assert.ok(plan.wrappedNames.includes("mcp_github_search"));
  assert.ok(plan.wrappedNames.includes("openapi_execute_request"));
  assert.ok(plan.wrappedNames.includes("grep"));
  assert.ok(!plan.directNames.includes("mcp_github_search"));
  assert.ok(plan.directNames.includes("cancel_task"));
  assert.ok(plan.directNames.includes("browser_session"));
  assert.ok(plan.directNames.includes("write"));

  const gatewayActive = ["codemode", ...plan.directNames];
  for (const w of ["mcp_github_search", "openapi_execute_request"]) {
    assert.ok(!gatewayActive.includes(w), `${w} should not be advertised top-level`);
  }
});

test("planMinimalToolSurface skips compression when sandbox flag or loader missing", () => {
  const tools = {
    mcp_ping: stubTool,
    browser_session: stubTool,
    read: stubTool,
  } satisfies ToolSet;

  const disabled = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: false,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(disabled.reason, "codemode-surface-disabled");
  assert.deepEqual(disabled.wrappedNames, []);

  const noLoader = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: false,
    codeExecutionEnabled: true,
  });
  assert.equal(noLoader.reason, "no-loader-binding");

  const noExec = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: false,
  });
  assert.equal(noExec.reason, "code-execution-disabled");
});

test("planMinimalToolSurface reports no wrapped tools when every tool is classified direct", () => {
  const tools = {
    browser_session: stubTool,
    run_workflow: stubTool,
    set_context: stubTool,
    write: stubTool,
    delete: stubTool,
    schedule_task: stubTool,
    cancel_task: stubTool,
    list_tasks: stubTool,
  } satisfies ToolSet;

  const plan = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  assert.equal(plan.reason, "no-wrapped-tools");
  assert.equal(plan.wrappedNames.length, 0);
});

test("Gateway-visible surface is much smaller than full merged registry token estimate", () => {
  const bigDescription = `x`.repeat(800);
  const heavyStub = tool({
    description: bigDescription,
    inputSchema: z.object({}),
    execute: async (): Promise<object> => ({}),
  });

  const tools: ToolSet = {
    browser_session: stubTool,
    write: stubTool,
  };

  for (let i = 0; i < 36; i += 1) {
    tools[`mcp_integration_${i}`] = heavyStub;
  }

  const plan = planMinimalToolSurface({
    mergedTools: tools,
    codemodeSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });

  assert.equal(plan.reason, "codemode-surface-applied-default");

  const fullTokens = estimateMergedToolSurfaceTokens(tools);
  const codemodeStub = stubTool as ToolSet[string];
  const augmented: ToolSet = { ...tools, codemode: codemodeStub };
  const activeNames = ["codemode", ...plan.directNames];
  const compressedTokens = estimateActiveToolSurfaceTokens(augmented, activeNames);

  assert.ok(
    compressedTokens * 10 < fullTokens,
    `expected compressed estimate (${compressedTokens}) << full (${fullTokens})`
  );
});
