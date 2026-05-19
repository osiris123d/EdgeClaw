/**
 * ToolAgent surface & MainAgent isolation — Node-safe (no Worker-only `cloudflare:*` imports).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ToolSet } from "ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterMainAgentToolSurface,
  TOOL_AGENT_SUBAGENT_TOOL_DENY_KEYS,
} from "../subagents/subagentToolSurface";

const here = dirname(fileURLToPath(import.meta.url));

test("TOOL_AGENT denial list includes browser tooling", () => {
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY_KEYS.includes("browser_search"));
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY_KEYS.includes("browser_session"));
  assert.ok(TOOL_AGENT_SUBAGENT_TOOL_DENY_KEYS.includes("list_tasks"));
});

test("filterMainAgentToolSurface strips browser tooling from a mock MainAgent-shaped surface", () => {
  const mock = {
    browser_search: { description: "" },
    list_project_notes: { description: "" },
    mcp_xyz: { description: "" },
  } as unknown as ToolSet;
  const out = filterMainAgentToolSurface(
    mock,
    new Set(TOOL_AGENT_SUBAGENT_TOOL_DENY_KEYS)
  );
  assert.ok(!("browser_search" in out));
  assert.ok("list_project_notes" in out);
  assert.ok("mcp_xyz" in out);
});

test("MainAgent uses dynamic import for ToolAgent (no static submodule import)", () => {
  const mainPath = join(here, "..", "MainAgent.ts");
  const src = readFileSync(mainPath, "utf8");
  assert.match(src, /class MainAgent\b/);
  assert.match(src, /delegateToToolAgent\b/);
  assert.ok(
    !/\bfrom\s+["']\.\/subagents\/ToolAgent["']/.test(src),
    "Prefer dynamic import(\"./subagents/ToolAgent\") over static `from`"
  );
});

test("ToolAgent DO export is a thin facet wrapper (source contract)", () => {
  const toolAgentPath = join(here, "..", "subagents", "ToolAgent.ts");
  const ts = readFileSync(toolAgentPath, "utf8");
  assert.match(ts, /export class ToolAgent extends ToolAgentThinkFacet/);
});

test("ToolAgentThinkFacet defines MCP sync RPC for MainAgent delegation mirror", () => {
  const facetPath = join(here, "..", "subagents", "ToolAgentThinkFacet.ts");
  const src = readFileSync(facetPath, "utf8");
  assert.match(src, /\brpcSyncMcpConfigFromMainAgent\b/);
  assert.match(src, /\boauthCallbackHost\b/);
  assert.match(src, /\bmcpRestoreShouldIncludeOAuthRouting\b/);
  assert.match(src, /\bstripPersistedMcpServerOAuthRoutingFields\b/);
  assert.match(src, /\bmcpRestoreDiag\b/);
  assert.match(src, /\bskipRestore:\s*shouldReuseLiveMcpSdkServer\b/);
  assert.match(src, /\bmcpSyncDecision\b/);
  assert.match(src, /reuse-live-sdk-server/);
  assert.match(src, /\bbuildMcpLiveMirrorToolSet\b/);
  assert.match(src, /codemodeSurface=ready wrappedToolCount=/);
  assert.match(src, /codemodeSurface=no_wrapped_search_tool/);
  assert.match(src, /tool_agent_setup_failure:mcp_live_reuse_mirror_incomplete/);
  assert.match(src, /tool_agent_setup_failure:codemode_surface_incomplete/);
  assert.match(src, /if \(this\._mcpMirrorSetupFailure\)/, "pre-inference setup short-circuit");
  assert.match(src, /buildToolAgentResultEnvelope\(\{[\s\S]*hadToolActivity: false/s, "setup short-circuit emits deterministic failure envelope");
  assert.match(src, /findMissingMcpMirrorDescriptors/, "sync validates mirror descriptors for reuse rows");
  assert.match(src, /\bonChatRecovery\b/, "fiber recovery rehydrates / gates codemode mirror");
  assert.match(src, /edgeclaw_ta_mcp_mirror_v1/, "durable snapshot key for MCP mirror rehydration");
  assert.match(src, /mcpMirrorRehydrate/, "log marker when mirror rebuilt from storage");
});
