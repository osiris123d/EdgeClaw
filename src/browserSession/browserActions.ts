/**
 * Browser Actions
 *
 * Structured action model for multi-step browser automation.
 * Actions are transpiled into page-executable JavaScript for browser_execute.
 *
 * Supported actions:
 * - navigate: load a URL
 * - click: click an element by selector
 * - type: type text into a form field
 * - wait: wait for selector or timeout
 * - screenshot: marker only (actual capture handled by provider/runtime)
 */

import { z } from "zod";

export const NavigateActionSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().url().describe("URL to navigate to"),
  waitUntil: z
    .enum(["load", "domContentLoaded", "networkIdle"])
    .optional()
    .describe("Wait condition: 'load' (default), 'domContentLoaded', or 'networkIdle'"),
});

export const ClickActionSchema = z.object({
  type: z.literal("click"),
  selector: z.string().min(1).describe("CSS selector for element to click"),
  delayMs: z.number().int().min(0).optional().describe("Delay in ms before clicking (default: 0)"),
});

export const TypeActionSchema = z.object({
  type: z.literal("type"),
  selector: z.string().min(1).describe("CSS selector for input field"),
  value: z.string().describe("Text to type into the field"),
  delayMs: z.number().int().min(0).optional().describe("Delay in ms between keystrokes (default: 50)"),
  clearFirst: z.boolean().optional().describe("Clear field before typing (default: false)"),
});

export const WaitActionSchema = z.object({
  type: z.literal("wait"),
  selector: z.string().optional().describe("CSS selector to wait for"),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(60000)
    .optional()
    .describe("Timeout in ms (default: 10000)"),
  waitUntil: z
    .enum(["present", "visible", "hidden"])
    .optional()
    .describe("Wait condition (default: 'present')"),
});

export const ScreenshotActionSchema = z.object({
  type: z.literal("screenshot"),
  fullPage: z.boolean().optional().describe("Capture full page scrollable area (default: false = viewport only)"),
});

export const BrowserActionSchema = z.discriminatedUnion("type", [
  NavigateActionSchema,
  ClickActionSchema,
  TypeActionSchema,
  WaitActionSchema,
  ScreenshotActionSchema,
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;

/**
 * Transpile a single action into a page-executable JavaScript fragment.
 *
 * Each fragment returns the result of the action (e.g. { success: true }, screenshot data, etc.)
 * Exported so the provider adapter can call it for per-action CDP WebSocket execution.
 */
export function actionToCdpScript(action: BrowserAction): string {
  switch (action.type) {
    case "navigate": {
      return `
        const targetUrl = ${JSON.stringify(action.url)};
        const normalizeUrl = (u) => u.replace(/\\/$/, '').toLowerCase();
        const alreadyThere = normalizeUrl(window.location.href) === normalizeUrl(targetUrl);
        if (!alreadyThere) {
          window.location.href = targetUrl;
        }
        return { type: "navigate", success: true, url: targetUrl, alreadyThere };
      `;
    }
    case "click": {
      const delayMs = action.delayMs ?? 0;
      return `
        const selector = ${JSON.stringify(action.selector)};
        const elem = document.querySelector(selector);
        if (${delayMs} > 0) await new Promise((r) => setTimeout(r, ${delayMs}));
        if (elem) elem.click();
        return { type: "click", success: Boolean(elem), selector };
      `;
    }
    case "type": {
      const clearFirst = action.clearFirst ?? false;
      return `
        const selector = ${JSON.stringify(action.selector)};
        const value = ${JSON.stringify(action.value)};
        const elem = document.querySelector(selector);
        if (elem) {
          if (typeof elem.focus === "function") {
            elem.focus();
          }
          if (${clearFirst}) {
            elem.value = "";
          }
          elem.value = value;
          elem.dispatchEvent(new Event("input", { bubbles: true }));
          elem.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { type: "type", success: Boolean(elem), selector, charCount: value.length };
      `;
    }
    case "wait": {
      const selector = action.selector;
      const timeoutMs = action.timeoutMs ?? 10000;
      const waitUntil = action.waitUntil ?? "present";

      if (!selector) {
        // Wait by timeout only
        return `
          await new Promise((r) => setTimeout(r, ${timeoutMs}));
          return { type: "wait", success: true, waited_ms: ${timeoutMs} };
        `;
      }

      // Wait for selector
      return `
        const selector = ${JSON.stringify(selector)};
        const timeoutMs = ${timeoutMs};
        const waitUntil = ${JSON.stringify(waitUntil)};
        await new Promise((resolve, reject) => {
          const start = Date.now();
          const interval = setInterval(() => {
            const elapsed = Date.now() - start;
            const elem = document.querySelector(selector);
            if (waitUntil === "present") {
              if (elem || elapsed > timeoutMs) {
                clearInterval(interval);
                if (elem) resolve();
                else reject(new Error(\`Timeout waiting for selector present: \${selector} (\${timeoutMs}ms)\`));
              }
              return;
            }
            if (waitUntil === "visible") {
              if (elem) {
                const style = getComputedStyle(elem);
                if (style.display !== "none" && style.visibility !== "hidden") {
                  clearInterval(interval);
                  resolve();
                  return;
                }
              }
              if (elapsed > timeoutMs) {
                clearInterval(interval);
                reject(new Error(\`Timeout waiting for selector visible: \${selector} (\${timeoutMs}ms)\`));
              }
              return;
            }
            // hidden
            if (!elem) {
              clearInterval(interval);
              resolve();
              return;
            }
            const style = getComputedStyle(elem);
            if (style.display === "none" || style.visibility === "hidden") {
              clearInterval(interval);
              resolve();
              return;
            }
            if (elapsed > timeoutMs) {
              clearInterval(interval);
              reject(new Error(\`Timeout waiting for selector hidden: \${selector} (\${timeoutMs}ms)\`));
            }
          }, 100);
        });
        return { type: "wait", success: true, selector };
      `;
    }
    case "screenshot": {
      return `
        return { type: "screenshot", success: true, requested: true, fullPage: ${action.fullPage ?? false} };
      `;
    }
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action type: ${_exhaustive}`);
    }
  }
}

/**
 * Transpile an array of actions into page-executable JavaScript.
 * Returns an array of results, one entry per action.
 */
export function actionsToCdpScript(actions: BrowserAction[]): string {
  if (actions.length === 0) {
    return `
      (async () => {
        return [];
      })()
    `;
  }

  const fragments = actions.map((action, index) => {
    const script = actionToCdpScript(action);
    return `
      try {
        const result${index} = await (async () => {
          ${script}
        })();
        results.push({ action: ${index}, ...result${index} });
      } catch (error) {
        results.push({ action: ${index}, success: false, error: error.message });
        throw error;
      }
    `;
  });

  return `
    (async () => {
      const results = [];
      ${fragments.join("\n")}
      return results;
    })()
  `;
}
