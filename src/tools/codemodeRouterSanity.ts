/**
 * End-to-end sanity check for Codemode relay helpers (WorkerLoader + Rpc surface).
 * Runs a minimal userland script that exercises router methods on the live EdgeClaw executor.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createCodemodeRelayMetaToolSet, CODEMODE_RELAYER_ROUTING_TOOL_IDS } from "./codemodeRelayMetaTools";
import { EdgeClawDynamicWorkerExecutor } from "./edgeClawDynamicWorkerExecutor";

const SANITY_DUMMY_ACCOUNT = "11111111111111111111111111111111";

function mcpTextJson(obj: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
  };
}

/** Wrapped tools that satisfy openapi_search / cloudflare_request / resolve_device_identifier / tools_call. */
export function buildCodemodeSanityRelayToolSet(): ToolSet {
  return {
    tool_sanity_search: tool({
      description: "__edgeclaw_sanity__ OpenAPI search stub",
      inputSchema: z.object({ code: z.string() }),
      execute: async (): Promise<{ content: Array<{ type: "text"; text: string }> }> =>
        mcpTextJson([]),
    }),
    tool_sanity_execute: tool({
      description: "__edgeclaw_sanity__ Code Mode execute stub",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async (): Promise<{ content: Array<{ type: "text"; text: string }> }> =>
        mcpTextJson({ success: true, result: [] }),
    }),
  };
}

const SANITY_CODE = `
async () => {
  const cm = typeof codemode !== "undefined" ? codemode : arguments[0]?.codemode;
  if (!cm || typeof cm !== "object") throw new Error("codemode_undefined");
  const need = ["tools_find", "openapi_search", "openapi_describe_operation", "cloudflare_request", "resolve_device_identifier", "tools_call", "tools_call_code"];
  for (const k of need) {
    if (typeof cm[k] !== "function") throw new Error(k + "_not_a_function");
  }
  await cm.tools_find({ query: "__edgeclaw_sanity__" });
  await cm.openapi_search({ tag: "__edgeclaw_sanity__" });
  await cm.openapi_describe_operation({
    method: "GET",
    path: "/__edgeclaw_sanity__/openapi/describe",
  });
  await cm.cloudflare_request({
    method: "GET",
    path: "/accounts/{account_id}/devices",
  });
  await cm.resolve_device_identifier({ hostnameOrSerial: "__edgeclaw_no_match__" });
  await cm.tools_call_code({
    toolName: "tool_sanity_execute",
    code: "async () => ({ sanity: true })",
  });
  await cm.tools_call({
    toolName: "tool_sanity_execute",
    input: { code: "async () => ({})" },
  });
  return { __edgeclaw_sanity__: "ok" };
}
`.trim();

export type CodemodeSanityRunnerResult =
  | { ok: true; registeredMethods: string }
  | { ok: false; reason: string };

/**
 * Verifies relay meta keys + one full WorkerLoader round-trip through the codemode tool.
 */
export async function runCodemodeRelayRouterSanity(opts: {
  loader: WorkerLoader;
  timeoutMs?: number;
  cloudflareAccountId?: string;
}): Promise<CodemodeSanityRunnerResult> {
  const rawAccount = opts.cloudflareAccountId?.trim() || SANITY_DUMMY_ACCOUNT;
  const account = /^[a-f0-9]{32}$/i.test(rawAccount) ? rawAccount : SANITY_DUMMY_ACCOUNT;
  const relay = buildCodemodeSanityRelayToolSet();
  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: account,
  });
  for (const k of [
    "tools_find",
    "openapi_search",
    "openapi_describe_operation",
    "cloudflare_request",
    "resolve_device_identifier",
    "tools_call",
    "tools_call_code",
  ]) {
    if (!(k in meta)) {
      return { ok: false, reason: `missing_meta_tool:${k}` };
    }
  }

  const executor = new EdgeClawDynamicWorkerExecutor({
    loader: opts.loader,
    timeout: opts.timeoutMs ?? 25_000,
    globalOutbound: null,
  });
  const codemodeTool = createExecuteTool({
    tools: meta,
    executor,
  });

  try {
    const ex = (codemodeTool as { execute?: (input: unknown) => Promise<unknown> }).execute;
    if (typeof ex !== "function") {
      return { ok: false, reason: "codemode_execute_missing" };
    }
    await ex({ code: SANITY_CODE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const low = msg.toLowerCase();
    if (low.includes("rpc receiver") && low.includes("implement")) {
      return { ok: false, reason: `rpc_receiver:${msg.slice(0, 200)}` };
    }
    if (low.includes("codemode_undefined") || low.includes("_not_a_function")) {
      return { ok: false, reason: `sandbox_surface:${msg.slice(0, 200)}` };
    }
    return { ok: false, reason: `execution:${msg.slice(0, 280)}` };
  }

  const registeredMethods = [...CODEMODE_RELAYER_ROUTING_TOOL_IDS].sort().join(",");
  return { ok: true, registeredMethods };
}
