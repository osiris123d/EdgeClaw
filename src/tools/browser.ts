/**
 * Browser Tools
 *
 * Wraps `@cloudflare/think/tools/browser` (createBrowserTools) so the rest of
 * the codebase never imports from the deep package path directly.
 *
 * Tools provided when browser bindings are present:
 *   - browser_search  — query the Chrome DevTools Protocol spec for commands /
 *                       events / types to discover before automating.
 *   - browser_execute — run CDP JavaScript against a live browser session via
 *                       Cloudflare Browser Rendering.
 *
 * Both tools are optional: if the BROWSER or LOADER bindings are absent the
 * factory returns an empty ToolSet and records a warning in the console so
 * the agent still starts cleanly without browser support configured.
 *
 * Required Cloudflare account features:
 *   - Browser Rendering (open beta) — https://developers.cloudflare.com/browser-rendering/
 *   - Workers for Platforms WorkerLoader — worker_loaders binding in wrangler.jsonc
 *
 * Required wrangler.jsonc bindings:
 *   "browser": { "binding": "BROWSER" }
 *   "worker_loaders": [{ "binding": "LOADER" }]
 */

import { createBrowserTools } from "@cloudflare/think/tools/browser";
import type { ToolSet } from "ai";
import { normalizeBrowserToolOutput } from "./browserArtifacts";

export interface BrowserToolsBindings {
  /** Cloudflare Browser Rendering binding. Set via `"browser": { "binding": "BROWSER" }`. */
  browser?: Fetcher;
  /**
   * WorkerLoader binding for sandboxed code execution.
   * Set via `"worker_loaders": [{ "binding": "LOADER" }]`.
   */
  loader?: WorkerLoader;
}

/**
 * Create browser automation tools when bindings are available.
 *
 * Returns the full `browser_search` + `browser_execute` ToolSet when both
 * the `browser` and `loader` bindings are present. Returns an empty ToolSet
 * and emits a console.warn if either binding is missing, so the agent
 * degrades gracefully when browser tooling is not configured.
 *
 * @param bindings - The BROWSER and LOADER bindings from the Worker env.
 * @param timeoutMs - CDP execution timeout in milliseconds (default 30 000).
 *
 * @example
 *   // In MainAgent.getTools() — already wired automatically:
 *   import { createAgentBrowserTools } from "../tools/browser";
 *   const browserTools = createAgentBrowserTools({
 *     browser: this.env.BROWSER,
 *     loader:  this.env.LOADER,
 *   });
 *   return { ...baseTools, ...browserTools };
 */
export function createAgentBrowserTools(
  bindings: BrowserToolsBindings,
  timeoutMs = 30_000
): ToolSet {
  const { browser, loader } = bindings;

  if (!browser || !loader) {
    console.warn(
      "[EdgeClaw] Browser tools are disabled: BROWSER or LOADER binding is not configured. " +
        "See the 'Browser Tools' section in README.md for setup instructions."
    );
    return {};
  }

  const baseTools = createBrowserTools({ browser, loader, timeout: timeoutMs });

  return Object.fromEntries(
    Object.entries(baseTools).map(([toolName, toolDef]) => {
      const candidate = toolDef as typeof toolDef & {
        execute?: (args: unknown) => Promise<unknown>;
      };

      if (!candidate.execute) {
        return [toolName, toolDef];
      }

      return [
        toolName,
        {
          ...toolDef,
          execute: async (args: unknown) => {
            const output = await candidate.execute?.(args);
            return normalizeBrowserToolOutput(toolName, output);
          },
        },
      ];
    })
  ) as ToolSet;
}
