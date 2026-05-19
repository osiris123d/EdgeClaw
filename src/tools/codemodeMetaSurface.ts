/**
 * Builds the top-level `codemode` sandbox tool that exposes relay meta-tools
 * (see {@link createCodemodeRelayMetaToolSet}) via Think's sandbox runner.
 */

import type { ToolSet } from "ai";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceStateBackend } from "@cloudflare/shell";
import type { Workspace } from "@cloudflare/shell";
import {
  CODEMODE_RELAYER_ROUTING_TOOL_IDS,
  createCodemodeRelayMetaToolSet,
  type CodemodeRelayMetaToolSetArgs,
} from "./codemodeRelayMetaTools";
import { EdgeClawDynamicWorkerExecutor } from "./edgeClawDynamicWorkerExecutor";

export { createCodemodeRelayMetaToolSet, type CodemodeRelayMetaToolSetArgs } from "./codemodeRelayMetaTools";

export interface CreateRelayCodemodeToolArgs extends CodemodeRelayMetaToolSetArgs {
  loader: WorkerLoader;
  workspace?: Workspace;
  timeoutMs?: number;
  /** When false, skip `[EdgeClaw][codemode-router]` bootstrap log (sanity probes, tests). Default true. */
  emitBootstrapLog?: boolean;
  /**
   * Optional workspace Settings appendix — trimmed/capped upstream. Appended verbatim to
   * the `codemode` tool description (additive).
   */
  codemodeDescriptionAppendix?: string;
}

const CODEMODE_ROUTER_BOOT_LOG_KEY = "__edgeClaw_codemodeRouterBootstrapLogged";

function emitCodemodeRouterBootstrapOnce(stateBound: boolean, enabled: boolean): void {
  if (!enabled) return;
  const g = globalThis as Record<string, unknown>;
  if (g[CODEMODE_ROUTER_BOOT_LOG_KEY]) return;
  g[CODEMODE_ROUTER_BOOT_LOG_KEY] = true;
  const methods = [...CODEMODE_RELAYER_ROUTING_TOOL_IDS].sort().join(",");
  console.log(`[EdgeClaw][codemode-router] registeredMethods=${methods} workspaceState=${stateBound}`);
}

export function createRelayCodemodeToolSet(args: CreateRelayCodemodeToolArgs): ToolSet {
  const {
    relay,
    loader,
    workspace,
    timeoutMs,
    cloudflareAccountId,
    emitBootstrapLog = true,
    codemodeDescriptionAppendix,
  } = args;

  const appendix =
    typeof codemodeDescriptionAppendix === "string" ? codemodeDescriptionAppendix.trim() : "";
  const state = workspace ? createWorkspaceStateBackend(workspace) : undefined;
  const metaTools = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId,
  });

  emitCodemodeRouterBootstrapOnce(Boolean(state), emitBootstrapLog);

  const appendixBlock =
    appendix.length > 0
      ? [
          "",
          "---",
          "**Additional MCP/Codemode guidance (workspace Settings):**",
          appendix,
        ]
      : [];

  const codemode = createExecuteTool({
    tools: metaTools,
    ...(state ? { state } : {}),
    executor: new EdgeClawDynamicWorkerExecutor({
      loader,
      timeout: timeoutMs ?? 30_000,
      globalOutbound: null,
    }),
    description: [
      "Sandbox with Codemode **router** helpers — orchestration only / no provider SDK in outer JS.",
      "`codemode` (and `arguments[0]?.codemode`):",
      "",
      "**Required HTTP/OpenAPI sequence — ALL THREE steps in the SAME codemode call (NEVER split across invocations):**",
      "**openapi_search → openapi_describe_operation → cloudflare_request**",
      "The `openapi_describe_operation` cache is **invocation-local**. If you split these three steps across separate `codemode` calls, `cloudflare_request` is rejected with `missing_openapi_describe_same_invocation`. Always compose a single async function that calls all three in sequence.",
      "",
      "**Planner-required (when MCP exposes OpenAPI):** For any HTTP/API call where an operation exists in the spec, you **must** call **openapi_describe_operation({ method, path })** first (use the **exact** `paths` template from search, e.g. `/resources/{id}`). Then call **cloudflare_request** with **operationPathTemplate** set to that same template, **knownValues** filled from prior partial results (identifiers, inventory, settings), and **query** / **body** only for fields the plan allows. **Do not** issue **cloudflare_request** as a blind guess-and-retry: the schema planner blocks the relay until required parameters are satisfied (or you fix **knownValues** / query / body).",
      "For list/search workloads, always pass `reduction` to cloudflare_request so filtering and compaction happen in the same execution context before output is returned (never return raw list payloads).",
      "Endpoint discovery is not equivalent to endpoint execution. Construct the smallest sufficient execution plan from the user’s requested fields: prefer list/collection endpoints first, use detail endpoints only when fields are missing or detail verification is explicitly requested, and never use mutation endpoints unless the user explicitly requests mutation behavior.",
      "",
      "Helpers:",
      "- **tools_find({ query })** — discover MCP tools by description (`tool_*` ids alone are meaningless).",
      "- **openapi_search({ tag?, pathIncludes?, summaryIncludes?, product? })** — narrow operations; no outer `spec`.",
      "- **openapi_describe_operation({ method, path })** — load `parameters` / `requestBody` into the invocation cache for strict planning. It is a schema/spec helper and must run via the MCP **search/spec mirror** (`tool_*_search`), never an execute mirror.",
      "- **tools_describe({ toolName })** OR **openapi_search** satisfies schema discovery gate; **describe_operation** satisfies the planner for HTTP routes.",
      "- **cloudflare_request({ method, path, operationPathTemplate, query?, body?, knownValues?, intent?, reduction? })** — MCP HTTP relay; pass **operationPathTemplate** whenever the OpenAPI template differs from emitted `path` or for clarity. Use `reduction` (`select`, `filterByPrefix.value`, `normalize`, `pagination.enabled/perPage/maxPages`, `compactResultCap`) for list/search tasks.",
      "- **resolve_device_identifier({ hostnameOrSerial })** — optional inventory-style resolution when schemas require stable ids.",
      "- **MCP execute relay tools (`tool_*_execute`) do NOT expose `spec`** — calling them to inspect OpenAPI schemas throws `spec is not defined`. Use `openapi_search` + `openapi_describe_operation` for all schema discovery.",
      "- Lower level: **tools_call_code** / **tools_call**.",
      "",
      "Canonical pattern:",
      "```js",
      "async () => {",
      "  const cm = typeof codemode !== \"undefined\" ? codemode : arguments[0]?.codemode;",
      "  await cm.openapi_search({ pathIncludes: \"/v1/desired-route\" });",
      "  const template = \"/accounts/{account_id}/v1/resources/{resource_id}\";",
      "  await cm.openapi_describe_operation({ method: \"GET\", path: template });",
      "  const result = await cm.cloudflare_request({",
      "    method: \"GET\",",
      "    path: template,",
      "    operationPathTemplate: template,",
      "    knownValues: { resource_id: \"<from prior structured results only>\" },",
      "    reduction: {",
      "      select: [\"id\"],",
      "      filterByPrefix: { field: \"name\", value: \"prefix\", trim: true, caseInsensitive: true },",
      "      pagination: { enabled: true, perPage: 100, maxPages: 20 },",
      "      compactResultCap: 50",
      "    },",
      "    query: {},",
      "  });",
      "  if (result?.ok === false) return result;",
      "  return result;",
      "}",
      "```",
      "",
      "Prefer `codemode` when the sandbox defines it; the `arguments[0]` fallback is for Rpc-only hosts.",
      state ? "Workspace: state.* helpers." : "",
      ...appendixBlock,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return { codemode };
}
