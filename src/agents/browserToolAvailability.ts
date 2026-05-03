import type { LanguageModel } from "ai";

export const BROWSER_TOOLS_FALLBACK_RESPONSE =
  "Browser tools are currently disabled in this deployment because ENABLE_BROWSER_TOOLS is set to false. I cannot use browser_search or browser_execute in this run. Please enable the flag and redeploy, then try again.";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function parseBooleanFlag(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

export function shouldIncludeBrowserTools(options: {
  enableBrowserTools: boolean;
  hasBrowserBinding: boolean;
  hasLoaderBinding: boolean;
}): boolean {
  return options.enableBrowserTools && options.hasBrowserBinding && options.hasLoaderBinding;
}

export function hasBrowserToolPair(toolNames: string[]): boolean {
  return toolNames.includes("browser_search") && toolNames.includes("browser_execute");
}

export interface BrowserCapabilityAuditSnapshot {
  rawEnableBrowserTools: string | undefined;
  parsedEnableBrowserTools: boolean;
  finalToolNames: string[];
  browserCapabilityAvailable: boolean;
}

export function buildBrowserCapabilityAuditSnapshot(options: {
  rawEnableBrowserTools: string | undefined;
  parsedEnableBrowserTools: boolean;
  finalToolNames: string[];
}): BrowserCapabilityAuditSnapshot {
  const finalToolNames = [...options.finalToolNames].sort();
  return {
    rawEnableBrowserTools: options.rawEnableBrowserTools,
    parsedEnableBrowserTools: options.parsedEnableBrowserTools,
    finalToolNames,
    browserCapabilityAvailable: hasBrowserToolPair(finalToolNames),
  };
}

export function buildBrowserDisabledWarningLine(snapshot: BrowserCapabilityAuditSnapshot): string {
  return (
    `[EdgeClaw][startup-warning] Browser tools disabled: ENABLE_BROWSER_TOOLS raw=` +
    `${snapshot.rawEnableBrowserTools ?? "(unset)"} parsed=${snapshot.parsedEnableBrowserTools} ` +
    `browserCapabilityAvailable=${snapshot.browserCapabilityAvailable}. ` +
    "Browser requests will be blocked until the flag is enabled and the worker is redeployed."
  );
}

export function isBrowserIntentRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(browser_search|browser_execute|browse|browsing|inspect\s+(a\s+)?(page|site|website)|inspect\s+dom|dom|navigate|navigation|read\s+(the\s+)?page|page\s+content|screenshot|screen\s*shot|capture\s+(a\s+)?screenshot|open\s+(a\s+)?url|visit\s+(a\s+)?url|open\s+https?:\/\/|go\s+to\s+https?:\/\/|record\s+(a\s+)?session|enable\s+recording|with\s+recording|capture\s+(a\s+)?recording|browser\s+(session|automation)|take\s+(a\s+)?(screenshot|photo)|load\s+(a\s+)?(page|url|site)|pause\s+for\s+human|wait\s+for\s+me|let\s+me\s+take\s+over|i\s+will\s+log\s+in|pause\s+on\s+blocker|stop\s+for\s+review|keep\s+(the\s+)?session\s+alive|reuse\s+(the\s+)?session|resume\s+(the\s+)?session)\b/.test(
    normalized
  );
}

export function buildCapabilitiesHint(toolNames: string[]): string {
  const sorted = [...toolNames].sort();
  const hasBrowserTools = hasBrowserToolPair(sorted);
  const browserCapabilityLine = hasBrowserTools
    ? "- Browser tooling available: browser_search, browser_execute"
    : "- Browser tooling unavailable: browser_search, browser_execute";

  return [
    "Capability snapshot for this turn:",
    `- Available tools (${sorted.length}): ${sorted.length > 0 ? sorted.join(", ") : "none"}`,
    browserCapabilityLine,
    "Do not claim unavailable capabilities. If browser tools are unavailable, say so directly and ask the user to enable ENABLE_BROWSER_TOOLS and redeploy.",
    "Never claim that you opened a page, inspected the DOM, or captured a screenshot unless browser_search or browser_execute actually ran successfully in this turn.",
  ].join("\n");
}

export function appendCapabilitiesHint(systemPrompt: string, toolNames: string[]): string {
  const hint = buildCapabilitiesHint(toolNames);
  const trimmed = systemPrompt.trimEnd();
  if (!trimmed) return hint;
  return `${trimmed}\n\n${hint}`;
}

export function decideBrowserRequestGuard(options: {
  userMessage: string;
  availableToolNames: string[];
}): { shouldShortCircuit: boolean; responseText?: string } {
  if (!isBrowserIntentRequest(options.userMessage)) {
    return { shouldShortCircuit: false };
  }

  if (hasBrowserToolPair(options.availableToolNames)) {
    return { shouldShortCircuit: false };
  }

  return {
    shouldShortCircuit: true,
    responseText: BROWSER_TOOLS_FALLBACK_RESPONSE,
  };
}

export function createDeterministicTextModel(text: string): LanguageModel {
  const model = {
    specificationVersion: "v2" as const,
    provider: "edgeclaw-guard",
    modelId: "browser-tools-unavailable",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
        warnings: [],
        response: {
          id: "edgeclaw-browser-tools-guard",
          modelId: "browser-tools-unavailable",
          timestamp: new Date(),
        },
      };
    },
    async doStream() {
      const textId = "guard-text";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "response-metadata",
            id: "edgeclaw-browser-tools-guard",
            modelId: "browser-tools-unavailable",
            timestamp: new Date(),
          });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({ type: "text-delta", id: textId, delta: text });
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: undefined,
              outputTokens: undefined,
              totalTokens: undefined,
            },
          });
          controller.close();
        },
      });

      return { stream };
    },
  };

  return model as unknown as LanguageModel;
}
