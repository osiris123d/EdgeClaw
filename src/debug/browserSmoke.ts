/**
 * Lightweight Browser Tools smoke prompts.
 *
 * These prompts are designed for manual validation in chat and intentionally
 * force the recommended sequence:
 *   1) browser_search to discover the relevant CDP command
 *   2) browser_execute to run it against a live page
 */

export interface BrowserSmokePrompts {
  titlePrompt: string;
  headingPrompt: string;
}

export function buildBrowserSmokePrompts(targetUrl = "https://example.com"): BrowserSmokePrompts {
  const safeUrl = targetUrl.trim() || "https://example.com";

  return {
    titlePrompt:
      "Browser tools smoke test: Use browser_search first to find the right CDP command(s) " +
      "for opening a page and evaluating JavaScript. Then use browser_execute to open " +
      `${safeUrl} and read document.title. Return JSON only with keys: ` +
      '{"ok": boolean, "url": string, "title": string, "toolsUsed": string[]}.',

    headingPrompt:
      "Browser tools smoke test: Use browser_search first to identify the CDP calls needed " +
      "to query DOM content after navigation. Then use browser_execute to open " +
      `${safeUrl} and extract the first visible H1 text (fallback to H2 if no H1 exists). ` +
      "If supported by your configured browser tool output, also include a screenshot capture result. " +
      "Return JSON only with keys: " +
      '{"ok": boolean, "url": string, "heading": string | null, "screenshot": string | null, "toolsUsed": string[]}.',
  };
}
