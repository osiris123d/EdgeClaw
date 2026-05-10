/**
 * Visible assistant markdown when Codemode fails silently (empty or "Done" only).
 */

export function isAssistantReplySilentAfterCodemodes(textTrimmed: string): boolean {
  const t = textTrimmed.trim();
  return t.length === 0 || /^done\.?$/i.test(t);
}

export function formatCodemodeFailureAssistantMarkdown(errors: string[]): string {
  if (errors.length === 0) return "";
  const joined = errors.join(" ").toLowerCase();
  let hint =
    "**Tip:** Try `codemode.tools_find({ query: \"…\" })`, then **`openapi_search` → `openapi_describe_operation` → `cloudflare_request`** with **`operationPathTemplate`**, **`knownValues`**, and **`query`/`body`**.";
  if (joined.includes("does not implement the method")) {
    hint =
      "**Tip:** Router helpers live on `codemode.*` Rpc methods — prefer `codemode.tools_find({ query })`; pass object arguments (not positional strings).";
  } else if (joined.includes("spec is not defined")) {
    hint =
      "**Tip:** Use **`openapi_search`** / inner MCP (`spec` is inner-only); then **`openapi_describe_operation`** and **`cloudflare_request`** with **`operationPathTemplate`**.";
  } else if (joined.includes("unexpected token")) {
    hint =
      "**Tip:** Pass one `async () => { … }` source to Code Mode, or use **`openapi_search` → `openapi_describe_operation` → `cloudflare_request`**.";
  } else if (
    joined.includes("no_device_match_after_inventory_scan") ||
    joined.includes("candidates=[]") ||
    (joined.includes("device") && joined.includes("inventory scan"))
  ) {
    hint =
      "**Next step:** Confirm enrollment in Zero Trust/DEX dashboards, rerun `codemode.resolve_device_identifier`, then call fleet endpoints using **only** the UUID in `/devices/{device_id}/…` — not the hostname/serial.";
  }

  return [
    "## Codemode error",
    "",
    "The sandboxed codemode step reported failures and returned little or no assistant text:",
    "",
    ...errors.slice(-4).map((e, i) => `${i + 1}. ${e}`),
    "",
    hint,
  ].join("\n");
}
