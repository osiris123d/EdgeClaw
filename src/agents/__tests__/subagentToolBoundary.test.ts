/**
 * Sub-agent tool boundary regression — imports **only** `subagentToolSurface` (no MainAgent/CoderAgent graph).
 *
 * **Hidden coupling:** `filterMainAgentToolSurface` only affects keys from `MainAgent.getTools()`. Think merges
 * built-in shell workspace tools separately; those are not filtered here (see `subagentToolSurface.ts` header).
 *
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import {
  CODER_SUBAGENT_TOOL_DENY,
  SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS,
  TESTER_SUBAGENT_TOOL_DENY,
  filterMainAgentToolSurface,
} from "../subagents/subagentToolSurface";

test("CODER deny set covers orchestration contract keys", () => {
  for (const k of SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS) {
    assert.ok(
      CODER_SUBAGENT_TOOL_DENY.has(k),
      `CODER_SUBAGENT_TOOL_DENY must include contract key "${k}"`
    );
  }
});

test("TESTER deny set is superset of coder deny keys", () => {
  for (const k of CODER_SUBAGENT_TOOL_DENY) {
    assert.ok(TESTER_SUBAGENT_TOOL_DENY.has(k), `Tester deny missing "${k}"`);
  }
});

test("TESTER additionally denies project note mutations", () => {
  assert.ok(TESTER_SUBAGENT_TOOL_DENY.has("save_project_note"));
  assert.ok(TESTER_SUBAGENT_TOOL_DENY.has("delete_project_note"));
});

test("filterMainAgentToolSurface strips orchestration keys but keeps allowed tools", () => {
  const mockFull = {
    list_workflows: { description: "x" },
    run_workflow: { description: "x" },
    evaluate_release_gate: { description: "x" },
    execute_preview_deployment: { description: "x" },
    shared_workspace_read_file: { description: "ok" },
    propose_patch: { description: "ok" },
  } as unknown as ToolSet;

  const coderFiltered = filterMainAgentToolSurface(mockFull, CODER_SUBAGENT_TOOL_DENY);
  assert.ok(!("list_workflows" in coderFiltered));
  assert.ok(!("evaluate_release_gate" in coderFiltered));
  assert.ok("shared_workspace_read_file" in coderFiltered);
  assert.ok("propose_patch" in coderFiltered);

  const testerFiltered = filterMainAgentToolSurface(mockFull, TESTER_SUBAGENT_TOOL_DENY);
  assert.ok(!("run_workflow" in testerFiltered));
});
