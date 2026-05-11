/**
 * ToolAgent rollout regressions — Node-safe contracts (no Workers DO / no deploy).
 *
 * Covers orchestration preservation on MainAgent, ToolAgent isolation, gateway metadata,
 * AI Gateway router docs, and delegation safety copy.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAiGatewayMetadataRecord,
  edgeClawGatewayAgentFromConstructorName,
  gatewayObservabilityFromDelegatedUserMessage,
} from "../../lib/agentObservability";
import type { Env } from "../../lib/env";
import { prepareToolAgentRpcIngress } from "../subagents/toolAgentRpcIngress";
import {
  SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS,
  TOOL_AGENT_SUBAGENT_TOOL_DENY,
  filterMainAgentToolSurface,
} from "../subagents/subagentToolSurface";
import { applyMainAgentReducedActiveTools } from "../mainAgentToolSurfaceReduction";
import { formatDelegateToolAgentMessage } from "../formatDelegateToolAgentMessage";

const here = dirname(fileURLToPath(import.meta.url));

const emptyEnv = {} as Env;

function assertToolAgentMetadataForDelegateBody(taskKind: "mcp_api" | "external_api" | "tool_orchestration") {
  const body = formatDelegateToolAgentMessage({ userRequest: "call MCP ping", taskKind });
  const prepared = prepareToolAgentRpcIngress(emptyEnv, body);
  assert.equal(prepared.delegationGatewayObs.agent, "ToolAgent");
  assert.equal(prepared.delegationGatewayObs.taskId, taskKind);
  const record = buildAiGatewayMetadataRecord({ ...prepared.delegationGatewayObs, worker: "EdgeClaw" });
  assert.equal(record.agent, "ToolAgent");
  assert.equal(record.task, taskKind);
}

test("Scheduled-task tools stay available on MainAgent-shaped surfaces; ToolAgent denies them", () => {
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has("schedule_task"));
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has("cancel_task"));
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has("list_tasks"));

  const orchestratorLike = {
    schedule_task: { description: "x" },
    cancel_task: { description: "x" },
    list_tasks: { description: "x" },
    mcp_demo: { description: "x" },
  } as unknown as ToolSet;

  const toolAgentSurface = filterMainAgentToolSurface(orchestratorLike, TOOL_AGENT_SUBAGENT_TOOL_DENY);
  assert.ok(!("schedule_task" in toolAgentSurface));
  assert.ok(!("cancel_task" in toolAgentSurface));
  assert.ok(!("list_tasks" in toolAgentSurface));
  assert.ok("mcp_demo" in toolAgentSurface);

  const toolsIndex = readFileSync(join(here, "..", "..", "tools", "index.ts"), "utf8");
  assert.match(toolsIndex, /\bschedule_task\b/, "scheduling tools still composed in tools/index.ts");
});

test("Workflow tools stay on orchestrator surfaces; ToolAgent denies them", () => {
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has("list_workflows"));
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has("run_workflow"));

  const mainPath = join(here, "..", "MainAgent.ts");
  const mainSrc = readFileSync(mainPath, "utf8");
  assert.match(mainSrc, /\blist_workflows\s*:/);
  assert.match(mainSrc, /\brun_workflow\s*:/);

  const mock = {
    list_workflows: {},
    run_workflow: {},
    read_file: {},
  } as unknown as ToolSet;
  const filtered = filterMainAgentToolSurface(mock, TOOL_AGENT_SUBAGENT_TOOL_DENY);
  assert.ok(!("list_workflows" in filtered));
  assert.ok(!("run_workflow" in filtered));
});

test("Skills bridge tools are not denied on ToolAgent and survive MainAgent surface reduction", () => {
  for (const k of ["load_context", "unload_context"] as const) {
    assert.ok(!TOOL_AGENT_SUBAGENT_TOOL_DENY.has(k), `${k} must not be ToolAgent-denylisted`);
  }
  const visible = applyMainAgentReducedActiveTools([
    "codemode",
    "mcp_x",
    "load_context",
    "unload_context",
    "schedule_task",
  ]);
  assert.ok(visible.includes("load_context"));
  assert.ok(visible.includes("unload_context"));
});

test('BrowserAgent maps to metadata.agent "BrowserAgent" and router docs branch on it', () => {
  assert.equal(edgeClawGatewayAgentFromConstructorName("EdgeclawBrowsingAgent"), "BrowserAgent");

  const routerPath = join(here, "..", "..", "..", "docs", "ai-gateway-agent-router-v2.json");
  const router = JSON.parse(readFileSync(routerPath, "utf8")) as {
    elements?: Array<{ properties?: { conditions?: Record<string, unknown> } }>;
  };
  const agentConditions =
    router.elements
      ?.map((e) => e.properties?.conditions?.["metadata.agent"])
      .filter(Boolean) ?? [];
  const browserBranches = agentConditions.filter(
    (c) => typeof c === "object" && c !== null && "$eq" in c && (c as { $eq: string }).$eq === "BrowserAgent"
  );
  assert.ok(browserBranches.length >= 1, "router v2 should include a BrowserAgent metadata.agent branch");
});

test("CoderAgent and TesterAgent gateway mapping and delegation envelope metadata stay distinct", () => {
  assert.equal(edgeClawGatewayAgentFromConstructorName("CoderAgent"), "CoderAgent");
  assert.equal(edgeClawGatewayAgentFromConstructorName("TesterAgent"), "TesterAgent");

  const coderMsg =
    `[EdgeClawSharedWorkspace]{"projectId":"proj-c","role":"coder","taskId":"task-1","runId":"run-9"}[/EdgeClawSharedWorkspace]\ndo work`;
  const coderObs = gatewayObservabilityFromDelegatedUserMessage(coderMsg, "CoderAgent");
  assert.equal(coderObs.agent, "CoderAgent");
  assert.equal(coderObs.projectId, "proj-c");
  assert.equal(coderObs.taskId, "task-1");
  assert.equal(coderObs.runId, "run-9");

  const testerMsg =
    `[EdgeClawSharedWorkspace]{"projectId":"proj-t","role":"tester","taskId":"verify-2"}[/EdgeClawSharedWorkspace]\ncheck`;
  const testerObs = gatewayObservabilityFromDelegatedUserMessage(testerMsg, "TesterAgent");
  assert.equal(testerObs.agent, "TesterAgent");
  assert.equal(testerObs.projectId, "proj-t");
  assert.equal(testerObs.taskId, "verify-2");

  const basePath = join(here, "..", "subagents", "BaseSubAgentThink.ts");
  const baseSrc = readFileSync(basePath, "utf8");
  assert.ok(baseSrc.includes("gatewayObservabilityFromDelegatedUserMessage"));

  const toolFacetPath = join(here, "..", "subagents", "ToolAgentThinkFacet.ts");
  const toolFacetSrc = readFileSync(toolFacetPath, "utf8");
  assert.ok(toolFacetSrc.includes("prepareToolAgentRpcIngress"));
  assert.ok(!/\bgatewayObservabilityFromDelegatedUserMessage\b/.test(toolFacetSrc));

  const coderPath = join(here, "..", "subagents", "CoderAgentThinkFacet.ts");
  assert.ok(!readFileSync(coderPath, "utf8").includes("override async rpcCollectChatTurn"));

  const testerPath = join(here, "..", "subagents", "TesterAgent.ts");
  assert.ok(!readFileSync(testerPath, "utf8").includes("override async rpcCollectChatTurn"));
});

test("When reduction applies, MCP/OpenAPI/codemode names drop but delegation + orchestration can remain", () => {
  const reduced = applyMainAgentReducedActiveTools([
    "codemode",
    "openapi_z",
    "mcp_github",
    "delegate_tool_task",
    "list_workflows",
    "schedule_task",
  ]);
  assert.ok(!reduced.includes("codemode"));
  assert.ok(!reduced.includes("openapi_z"));
  assert.ok(!reduced.includes("mcp_github"));
  assert.ok(reduced.includes("delegate_tool_task"));
  assert.ok(reduced.includes("list_workflows"));
  assert.ok(reduced.includes("schedule_task"));

  const mainSrc = readFileSync(join(here, "..", "MainAgent.ts"), "utf8");
  assert.match(
    mainSrc,
    /!this\.enableToolAgentDelegation \|\| !this\.enableMainToolSurfaceReduction/,
    "narrowing requires both delegation and reduction flags"
  );
});

test("MainAgent normal chat path defaults Gateway metadata.agent to MainAgent (no ToolAgent required)", () => {
  const mainSrc = readFileSync(join(here, "..", "MainAgent.ts"), "utf8");
  assert.ok(mainSrc.includes('agent: obs?.agent ?? "MainAgent"'));
  assert.ok(mainSrc.includes('buildModelBindingsForAiGateway(this.env.AI_GATEWAY_TOKEN, { agent: "MainAgent" }'));
});

test("ToolAgent RPC ingress yields cf-aig-metadata agent ToolAgent and task from workload kind", () => {
  assertToolAgentMetadataForDelegateBody("mcp_api");
  assertToolAgentMetadataForDelegateBody("external_api");
  assertToolAgentMetadataForDelegateBody("tool_orchestration");

  const unknownBody = formatDelegateToolAgentMessage({ userRequest: "z", taskKind: "unknown" });
  const preparedUnknown = prepareToolAgentRpcIngress(emptyEnv, unknownBody);
  assert.equal(preparedUnknown.delegationGatewayObs.taskId, "tool_orchestration");
});

test("ToolAgent deny list removes all main-chat browser client tools from its surface", () => {
  for (const name of ["browser_search", "browser_execute", "browser_session"] as const) {
    assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY.has(name), `expected ToolAgent to deny ${name}`);
  }
});

test("Destructive / deploy orchestration tool names stay off delegated ToolAgent surfaces", () => {
  for (const k of SUBAGENT_ORCHESTRATION_BOUNDARY_KEYS) {
    assert.ok(
      TOOL_AGENT_SUBAGENT_TOOL_DENY.has(k),
      `ToolAgent deny must include orchestration boundary key "${k}"`
    );
  }
  const policy = formatDelegateToolAgentMessage({
    userRequest: "probe APIs",
    taskKind: "mcp_api",
  });
  assert.match(policy, /Do not deploy workloads/i);
  assert.match(policy, /\*\*User request\*\*/);
});

test("Golden path: MCP/OpenAPI-style task → delegate_tool_task payload → ToolAgent metadata; skills + codemode placement under reduction", () => {
  const mainSrc = readFileSync(join(here, "..", "MainAgent.ts"), "utf8");
  assert.match(
    mainSrc,
    /\.\.\.\(this\.enableToolAgentDelegation\s*\n\s*\?/,
    "delegate_tool_task must stay gated on ENABLE_TOOL_AGENT_DELEGATION"
  );

  const userRequest =
    "Use openapi_search_paths on https://api.example.com/openapi.json then call mcp_github_searchrepos for org EdgeClaw.";
  const body = formatDelegateToolAgentMessage({
    userRequest,
    taskKind: "mcp_api",
  });
  assert.match(body, /\[\[edgeclaw:tool-task-kind=mcp_api\]\]/);
  assert.ok(body.includes(userRequest), "delegation body must carry the user request verbatim");

  const prepared = prepareToolAgentRpcIngress(emptyEnv, body);
  assert.equal(prepared.delegationGatewayObs.agent, "ToolAgent");
  assert.equal(prepared.delegationGatewayObs.taskId, "mcp_api");
  const record = buildAiGatewayMetadataRecord({ ...prepared.delegationGatewayObs, worker: "EdgeClaw" });
  assert.equal(record.agent, "ToolAgent");
  assert.equal(record.task, "mcp_api");

  const reducedMainVisible = applyMainAgentReducedActiveTools([
    "delegate_tool_task",
    "load_context",
    "unload_context",
    "codemode",
    "mcp_github_searchrepos",
    "openapi_execute_request",
    "schedule_task",
  ]);
  assert.ok(reducedMainVisible.includes("delegate_tool_task"), "MainAgent keeps delegation tool when registered");
  assert.ok(reducedMainVisible.includes("load_context") && reducedMainVisible.includes("unload_context"));
  assert.ok(!reducedMainVisible.includes("codemode"), "Codemode must not be MainAgent Gateway-visible under reduction");
  assert.ok(!reducedMainVisible.includes("mcp_github_searchrepos"));
  assert.ok(!reducedMainVisible.includes("openapi_execute_request"));

  const toolFacetSrc = readFileSync(join(here, "..", "subagents", "ToolAgentThinkFacet.ts"), "utf8");
  assert.ok(
    toolFacetSrc.includes('["codemode"') || toolFacetSrc.includes('["codemode",'),
    "ToolAgent applies Codemode compression with codemode in activeTools when policy applies"
  );
  assert.ok(toolFacetSrc.includes("createRelayCodemodeToolSet"));
});
