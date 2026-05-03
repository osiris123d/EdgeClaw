/**
 * browser_session tool
 *
 * An AI SDK tool that routes multi-step / live / HITL-capable browser tasks
 * through the BrowserSessionManager instead of the one-shot browser_execute path.
 *
 * Operations:
 *   launch   — start a new persistent session with recording enabled
 *   step     — execute a CDP script inside an existing session
 *   pause    — transition the session to awaiting_human (HITL); never restarts browser
 *   resume   — reconnect to a disconnected/active session and run a step
 *   complete — finalize the session with a summary; closes the CDP target
 *   abandon  — immediately close and discard the session
 *   status   — read session state without mutation
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { BrowserSessionManager } from "../browserSession/BrowserSessionManager";
import { BrowserActionSchema } from "../browserSession/browserActions";
import {
  mergeBrowserSessionLaunchFromUserText,
  sanitizeLaunchTaskForStorage,
} from "../agents/browserSessionUserMessageMerge";

const BrowserSessionOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("launch"),
    task: z.string().min(1).describe("The task or initial URL to open in the browser session."),
    recordingEnabled: z
      .boolean()
      .optional()
      .default(true)
      .describe("Enable CDP recording/tracing. Default true."),
    sessionMode: z
      .enum(["ephemeral", "reusable"])
      .optional()
      .describe("Use reusable mode to keep the provider session alive for reconnect/live view."),
    keepAliveMs: z
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .optional()
      .describe(
        "Provider session keep-alive in ms when reusable mode is requested. Max 1 hour (3_600_000); the remote service may apply a lower cap."
      ),
    reuseSessionId: z
      .string()
      .optional()
      .describe("Provider-backed reusable session id to reconnect instead of creating a fresh session."),
    pauseForHuman: z
      .boolean()
      .optional()
      .describe("Pause immediately for a human to take over after launch."),
    pauseForHumanOnBlocker: z
      .boolean()
      .optional()
      .describe("Launch in reusable mode and pause when a blocker/login step is expected."),
    actions: z
      .array(BrowserActionSchema)
      .optional()
      .describe("Structured actions to execute after launch: navigate, click, type, wait, screenshot."),
  }),
  z.object({
    operation: z.literal("step"),
    sessionId: z.string().describe("The sessionId returned by a previous launch call."),
    cdpScript: z.string().optional().describe("CDP-compatible JavaScript to evaluate in the browser."),
    actions: z
      .array(BrowserActionSchema)
      .optional()
      .describe("Structured actions to execute: navigate, click, type, wait, screenshot."),
    humanInstructions: z
      .string()
      .optional()
      .describe("If set, pauses the session with these instructions for the human user."),
  }),
  z.object({
    operation: z.literal("resume"),
    sessionId: z.string().describe("The sessionId of an active or disconnected session."),
    cdpScript: z.string().optional().describe("CDP-compatible JavaScript to evaluate on reconnect."),
    actions: z
      .array(BrowserActionSchema)
      .optional()
      .describe("Structured actions to execute after reconnect: navigate, click, type, wait, screenshot."),
    humanInstructions: z
      .string()
      .optional()
      .describe("If set, pauses the session after this step."),
  }),
  z.object({
    operation: z.literal("resume_browser_session"),
    sessionId: z.string().describe("The existing browser_session sessionId to reconnect and refresh."),
  }),
  z.object({
    operation: z.literal("pause"),
    sessionId: z.string().describe("The sessionId to transition to awaiting_human."),
    humanInstructions: z.string().min(1).describe("Instructions for the human user."),
  }),
  z.object({
    operation: z.literal("complete"),
    sessionId: z.string().describe("The sessionId to finalize and close."),
    summary: z.string().describe("Summary of what was accomplished in this session."),
  }),
  z.object({
    operation: z.literal("abandon"),
    sessionId: z.string().describe("The sessionId to abandon and close immediately."),
  }),
  z.object({
    operation: z.literal("status"),
    sessionId: z.string().describe("The sessionId to inspect."),
  }),
]);

/** Optional hooks for launch — Think does not pre-run `beforeToolCall`; merge runs here. */
export type CreateBrowserSessionToolOptions = {
  getLatestUserText?: () => string;
  /**
   * Lazy getter called at tool execute-time (after `beforeTurn` has run) to
   * retrieve the current browser executor strategy chosen by the user.
   * Returns "cdp" (default) or "puppeteer".
   */
  getStepExecutor?: () => "cdp" | "puppeteer";
};

export function createBrowserSessionTool(
  manager: BrowserSessionManager,
  options?: CreateBrowserSessionToolOptions
): ToolSet {
  return {
    browser_session: tool({
      description: [
        "Manage a persistent browser session for multi-step, live, or HITL (human-in-the-loop) browser automation tasks.",
        "The tool supports structured actions (navigate, click, type, wait, screenshot) for reliable automation without CDP script coding.",
        "Always include the operation field. Never omit required fields for that operation.",
        "Use this tool — not browser_execute — when the task requires:",
        "  - Multiple browser steps across LLM turns",
        "  - Structured actions (click buttons, type text, wait for elements, take screenshots)",
        "  - Human review or approval at any intermediate step",
        "  - Recording/tracing for audit or replay",
        "  - Session reconnect/resume after disconnection",
        "",
        "Action object shapes:",
        "  navigate:   { type: \"navigate\", url: string, waitUntil?: \"load\" | \"domContentLoaded\" | \"networkIdle\" }",
        "  click:      { type: \"click\", selector: string, delayMs?: number }",
        "  type:       { type: \"type\", selector: string, value: string, delayMs?: number, clearFirst?: boolean }",
        "  wait:       { type: \"wait\", selector?: string, timeoutMs?: number, waitUntil?: \"present\" | \"visible\" | \"hidden\" }",
        "  screenshot: { type: \"screenshot\", fullPage?: boolean }",
        "",
        "Required argument shapes by operation:",
        "  launch   requires { operation: \"launch\", task: string, actions?: [...] }",
        "  step     requires { operation: \"step\", sessionId: string, actions?: [...] OR cdpScript?: string }",
        "  resume   requires { operation: \"resume\", sessionId: string, actions?: [...] OR cdpScript?: string }",
        "  resume_browser_session requires { operation: \"resume_browser_session\", sessionId: string }",
        "  pause    requires { operation: \"pause\", sessionId: string, humanInstructions: string }",
        "  complete requires { operation: \"complete\", sessionId: string, summary: string }",
        "  abandon  requires { operation: \"abandon\", sessionId: string }",
        "  status   requires { operation: \"status\", sessionId: string }",
        "",
        "Valid examples (structured actions):",
        "  { \"operation\": \"launch\", \"task\": \"Search for backpacks on Amazon\", \"actions\": [",
        "      { \"type\": \"navigate\", \"url\": \"https://amazon.com\" },",
        "      { \"type\": \"type\", \"selector\": \"input#twotabsearchtextbox\", \"value\": \"backpacks\" },",
        "      { \"type\": \"click\", \"selector\": \"button[type=submit]\" },",
        "      { \"type\": \"wait\", \"selector\": \".s-result-item\", \"timeoutMs\": 5000 },",
        "      { \"type\": \"screenshot\", \"fullPage\": false }",
        "    ] }",
        "  { \"operation\": \"step\", \"sessionId\": \"<session-id>\", \"actions\": [",
        "      { \"type\": \"click\", \"selector\": \".a-pagination .a-last\" },",
        "      { \"type\": \"wait\", \"selector\": \".s-result-item\", \"timeoutMs\": 5000 },",
        "      { \"type\": \"screenshot\" }",
        "    ] }",
        "",
        "Valid examples (CDP script fallback for advanced scenarios):",
        "  { \"operation\": \"step\", \"sessionId\": \"<session-id>\", \"cdpScript\": \"return await chrome.Runtime.evaluate({ expression: 'document.title' });\" }",
        "  { \"operation\": \"resume\", \"sessionId\": \"<session-id>\", \"cdpScript\": \"return await chrome.Page.navigate({ url: 'https://example.com/docs' });\" }",
        "  { \"operation\": \"resume_browser_session\", \"sessionId\": \"<session-id>\" }",
        "  { \"operation\": \"pause\", \"sessionId\": \"<session-id>\", \"humanInstructions\": \"Please complete login and confirm when done.\" }",
        "  { \"operation\": \"complete\", \"sessionId\": \"<session-id>\", \"summary\": \"Captured pricing screenshot and verified page title.\" }",
        "  { \"operation\": \"abandon\", \"sessionId\": \"<session-id>\" }",
        "  { \"operation\": \"status\", \"sessionId\": \"<session-id>\" }",
        "",
        "Always complete or abandon the session when the task is done.",
        "Never claim a screenshot was captured unless the session result contains _screenshotDataUrl.",
        "For launch with actions, send actions as structured tool arguments (actions array).",
        "Never restate JSON plans or action syntax inside task text.",
        "If the user says 'exactly once', never issue a second launch call in the same turn.",
        "Prefer structured actions for click/type/wait/navigate/screenshot; use cdpScript only for advanced debugging or custom queries.",
        "For normal browsing tasks, prefer actions over cdpScript.",
        "Do not encode JSON, selectors, or action syntax inside the task string.",
        "Task should be a short summary only (example: 'Search backpacks on Amazon').",
        "Canonical workflow example: launch Amazon + type backpacks + click search + wait + screenshot.",
        "Phrase mapping: 'search for X', 'type X', 'click X', 'wait for X' => use structured actions.",
        "Phrase mapping: 'pause for human', 'wait for me', 'let me take over', 'I will log in', 'stop for review' => launch with pauseForHuman=true, sessionMode='reusable', and keepAliveMs.",
        "Phrase mapping: 'pause on blocker' => launch with pauseForHumanOnBlocker=true and sessionMode='reusable'.",
        "Phrase mapping: 'record this session', 'enable recording', 'with recording' => launch with recordingEnabled=true.",
        "Phrase mapping: 'keep this session alive', 'reuse later', 'resume existing session' => use reusable mode and, when reconnecting, prefer resume_browser_session or reuseSessionId.",
      ].join("\n"),

      inputSchema: zodSchema(BrowserSessionOperationSchema),

      execute: async (args: z.infer<typeof BrowserSessionOperationSchema>) => {
        const executor = options?.getStepExecutor?.() ?? "cdp";
        console.info(
          `[BrowserSession][tool-execute] op=${args.operation} executor=${executor} ` +
            `actionsCount=${(args as { actions?: unknown[] }).actions?.length ?? 0}`
        );
        switch (args.operation) {
          case "launch": {
            const hadNoActions = !args.actions || args.actions.length === 0;
            const record = { ...(args as object) } as Record<string, unknown>;
            let merged = options?.getLatestUserText
              ? mergeBrowserSessionLaunchFromUserText(options.getLatestUserText(), record)
              : record;
            let launch = merged as (typeof args & { operation: "launch" });

            if (hadNoActions && Array.isArray(launch.actions) && launch.actions.length > 0) {
              console.info(
                `[browser-grounding] merged ${launch.actions.length} launch actions from user message (model omitted empty actions).`
              );
            }

            // Auto-inject a screenshot action when the user asked for a screenshot but the
            // model omitted it. The browser already navigates to the right URL on launch;
            // adding a screenshot action ensures an image is actually captured and returned.
            const userT = options?.getLatestUserText?.() ?? "";
            const allText = ((launch.task ?? "") + " " + userT).toLowerCase();
            const wantsScreenshot =
              allText.includes("screenshot") ||
              allText.includes("take a picture") ||
              allText.includes("capture the page") ||
              allText.includes("capture a photo");
            const hasScreenshotAction = (launch.actions ?? []).some(
              (a) => a.type === "screenshot"
            );

            if (wantsScreenshot && !hasScreenshotAction) {
              const injected = { type: "screenshot" as const, fullPage: false };
              launch = { ...launch, actions: [...(launch.actions ?? []), injected] };
              console.info(
                `[browser-grounding] auto-injected screenshot action (task/user text mentions screenshot, model omitted it).`
              );
            }

            const task = sanitizeLaunchTaskForStorage(launch.task, userT || undefined);
            return manager.launch({
              task,
              recordingEnabled: launch.recordingEnabled,
              sessionMode: launch.sessionMode,
              keepAliveMs: launch.keepAliveMs,
              reuseSessionId: launch.reuseSessionId,
              pauseForHuman: launch.pauseForHuman,
              pauseForHumanOnBlocker: launch.pauseForHumanOnBlocker,
              actions: launch.actions,
              executorStrategy: options?.getStepExecutor?.(),
            });
          }

          case "step":
            return manager.resume(args.sessionId, {
              cdpScript: args.cdpScript,
              actions: args.actions,
              humanInstructions: args.humanInstructions,
              executorStrategy: options?.getStepExecutor?.(),
            });

          case "resume":
            return manager.resume(args.sessionId, {
              cdpScript: args.cdpScript,
              actions: args.actions,
              humanInstructions: args.humanInstructions,
            });

          case "resume_browser_session":
            return manager.reconnect(args.sessionId);

          case "pause":
            return manager.pause(args.sessionId, args.humanInstructions);

          case "complete":
            return manager.complete(args.sessionId, args.summary);

          case "abandon":
            return manager.abandon(args.sessionId);

          case "status": {
            return manager.status(args.sessionId);
          }

          default:
            return {
              schema: "edgeclaw.browser-session-result" as const,
              schemaVersion: 1 as const,
              sessionId: "unknown",
              status: "abandoned" as const,
              recordingEnabled: false,
              summary: "Unknown operation.",
            };
        }
      },
    }),
  };
}
