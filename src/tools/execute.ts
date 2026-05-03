/**
 * Sandboxed Code Execution Tool
 *
 * Wraps `@cloudflare/think/tools/execute` (createExecuteTool) to give the LLM
 * the ability to write and run JavaScript in an isolated Worker sandbox via
 * Cloudflare's WorkerLoader binding.
 *
 * Security model
 * ──────────────
 * - Code runs inside a freshly created Worker isolate for every call — there
 *   is no shared state between executions.
 * - Outbound network access is blocked by default (`globalOutbound: null`).
 *   Pass a custom `Fetcher` through `outboundFetcher` only when you explicitly
 *   need fetch() inside the sandbox.
 * - Only tools passed via the `tools` option are accessible; the LLM cannot
 *   import other modules or access the host Worker's bindings directly.
 * - eval / new Function are NOT used — code is compiled & executed through
 *   Cloudflare's supported WorkerLoader mechanism.
 *
 * State backend (optional)
 * ────────────────────────
 * When `workspace` is provided, the sandbox also receives a `state.*` API
 * (readFile, writeFile, glob, planEdits, searchFiles, replaceInFiles, …) via
 * `createWorkspaceStateBackend` from `@cloudflare/shell`.
 * This is the preferred way to give the LLM coordinated multi-file access.
 * Without `workspace`, only `codemode.*` tool calls are available.
 *
 * Required wrangler.jsonc binding
 * ─────────────────────────────────
 * "worker_loaders": [{ "binding": "LOADER" }]
 *
 * Required Cloudflare account features
 * ─────────────────────────────────────
 * Workers for Platforms (WorkerLoader):
 * https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
 */

import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceStateBackend } from "@cloudflare/shell";
import type { Workspace } from "@cloudflare/shell";
import type { ToolSet } from "ai";
import type { Tool } from "ai";

/** The single tool returned by this module, keyed as `execute`. */
export type ExecuteToolEntry = { execute: Tool };

export interface CodeExecutionOptions {
  /**
   * WorkerLoader binding for creating the sandboxed Worker isolate.
   * Requires `"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc.
   */
  loader?: WorkerLoader;

  /**
   * AI SDK ToolSet accessible inside the sandbox as `codemode.*` functions.
   *
   * Pass your domain tools here — the LLM can call them within generated code.
   * Workspace file tools (read, write, glob, …) are covered by `workspace`
   * via the `state.*` API and do not need to be duplicated here.
   */
  tools?: ToolSet;

  /**
   * Think Workspace instance (from `this.workspace` in a Think agent).
   *
   * When provided, the sandbox gains access to the full `state.*` filesystem
   * API (readFile, writeFile, planEdits, searchFiles, replaceInFiles, …) via
   * `createWorkspaceStateBackend`. Omit to keep the sandbox filesystem-free.
   */
  workspace?: Workspace;

  /**
   * Execution timeout in milliseconds. Defaults to 30 000 ms.
   */
  timeoutMs?: number;

  /**
   * Controls outbound network from sandboxed code.
   * - `null` (default): fetch() throws — fully isolated.
   * - A `Fetcher`: routes all outbound requests through this handler.
   */
  outboundFetcher?: Fetcher | null;

  /**
   * Custom description for the `execute` tool, shown to the LLM.
   * Include `{{types}}` to have the available type signatures injected.
   */
  description?: string;
}

/**
 * Create the sandboxed `execute` tool entry when a WorkerLoader binding is
 * available. Returns `undefined` when the `loader` binding is absent so the
 * caller can skip spreading it into `getTools()`.
 *
 * @example
 *   // In MainAgent.getTools() — already wired automatically:
 *   const entry = createCodeExecutionTool({
 *     loader: this.env.LOADER,
 *     workspace: this.workspace,      // enables state.* inside sandbox
 *     tools: myDomainToolSet,         // enables codemode.* inside sandbox
 *   });
 *   if (entry) return { ...baseTools, ...entry };
 */
export function createCodeExecutionTool(
  options: CodeExecutionOptions
): ExecuteToolEntry | undefined {
  const {
    loader,
    tools = {},
    workspace,
    timeoutMs = 30_000,
    outboundFetcher = null,
    description,
  } = options;

  if (!loader) {
    console.warn(
      "[EdgeClaw] Code execution tool is disabled: LOADER binding is not configured. " +
        "See the 'Code Execution' section in README.md for setup instructions."
    );
    return undefined;
  }

  const state = workspace
    ? createWorkspaceStateBackend(workspace)
    : undefined;

  const executeTool = createExecuteTool({
    tools,
    ...(state ? { state } : {}),
    loader,
    timeout: timeoutMs,
    globalOutbound: outboundFetcher,
    ...(description ? { description } : {}),
  });

  return { execute: executeTool };
}
