/**
 * MainAgent Gateway `activeTools` reduction helpers (no Workers / DO).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMainAgentReducedActiveTools,
  isMainAgentDelegateFailureBlockedToolName,
  isMainAgentReductionHiddenToolName,
} from "../mainAgentToolSurfaceReduction";

test("isMainAgentReductionHiddenToolName targets MCP, OpenAPI relay, codemode, execute", () => {
  assert.equal(isMainAgentReductionHiddenToolName("codemode"), true);
  assert.equal(isMainAgentReductionHiddenToolName("execute"), true);
  assert.equal(isMainAgentReductionHiddenToolName("mcp_github_search"), true);
  assert.equal(isMainAgentReductionHiddenToolName("openapi_foo"), true);
  assert.equal(isMainAgentReductionHiddenToolName("schedule_task"), false);
  assert.equal(isMainAgentReductionHiddenToolName("list_workflows"), false);
  assert.equal(isMainAgentReductionHiddenToolName("delegate_tool_task"), false);
  assert.equal(isMainAgentReductionHiddenToolName("browser_session"), false);
});

test("isMainAgentDelegateFailureBlockedToolName extends reduction hidden set with relay tools", () => {
  assert.equal(isMainAgentDelegateFailureBlockedToolName("codemode"), true);
  assert.equal(isMainAgentDelegateFailureBlockedToolName("tool_cf_mcp_search"), true);
  assert.equal(isMainAgentDelegateFailureBlockedToolName("tool_cf_mcp_execute"), true);
  assert.equal(isMainAgentDelegateFailureBlockedToolName("tool_execute"), false);
  assert.equal(isMainAgentDelegateFailureBlockedToolName("browser_search"), false);
});

test("applyMainAgentReducedActiveTools drops heavy surfaces and preserves orchestration", () => {
  const names = [
    "codemode",
    "execute",
    "mcp_api_x",
    "openapi_y",
    "schedule_task",
    "list_workflows",
    "run_workflow",
    "delegate_tool_task",
    "browser_search",
  ];
  const out = applyMainAgentReducedActiveTools(names);
  assert.ok(out.length < names.length, "expected fewer visible tools");
  assert.ok(out.includes("schedule_task"));
  assert.ok(out.includes("list_workflows"));
  assert.ok(out.includes("run_workflow"));
  assert.ok(out.includes("delegate_tool_task"));
  assert.ok(out.includes("browser_search"));
  assert.ok(!out.includes("codemode"));
  assert.ok(!out.includes("execute"));
  assert.ok(!out.includes("mcp_api_x"));
  assert.ok(!out.includes("openapi_y"));
});

test("applyMainAgentReducedActiveTools dedupes and sorts", () => {
  assert.deepEqual(applyMainAgentReducedActiveTools(["z", "a", "a"]), ["a", "z"]);
});

test("MainAgent narrows activeTools only when both delegation and reduction flags (source contract)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(
    src,
    /!this\.enableToolAgentDelegation \|\| !this\.enableMainToolSurfaceReduction/,
    "narrowing skipped unless both delegation and reduction flags are true"
  );
  assert.ok(
    /\benableToolAgentDelegation\b/.test(src) && /\?\s*\{\s*\n\s*delegate_tool_task:/s.test(src),
    "delegate_tool_task registered only when enableToolAgentDelegation"
  );
});
