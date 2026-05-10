/**
 * Classify sandbox/Rpc plumbing failures that indicate the Codemode router surface is broken,
 * distinct from ordinary user code/tool errors inside codemode.
 */

const PLUMBING_FRAGMENTS = [
  "rpc receiver",
  "does not implement method",
  "does not implement the method",
  "codemode is undefined",
  "codemode_undefined",
  "referenceerror: codemode",
  "'codemode' is not defined",
  "tools_find is not a function",
  "openapi_search is not a function",
  "tools_find_not_a_function",
  "openapi_search_not_a_function",
] as const;

export function isCodemodeRouterPlumbingFailureMessage(message: string): boolean {
  const m = message.toLowerCase();

  const matchesReceiver =
    m.includes("rpc receiver") &&
    (m.includes("implement") || m.includes("does not expose"));

  const matchesCodemodeUndef =
    m.includes("codemode") &&
    (m.includes("undefined") || m.includes("not defined"));

  const nf =
    m.includes("_not_a_function") ||
    m.includes("is not a function");
  const mentionsRouterTool =
    m.includes("tools_find") ||
    m.includes("openapi_search") ||
    m.includes("tools_call") ||
    m.includes("resolve_device_identifier") ||
    m.includes("cloudflare_request");

  const matchesTypedCheck = nf && mentionsRouterTool;

  if (matchesReceiver) return true;
  if (matchesCodemodeUndef) return true;
  if (matchesTypedCheck) return true;

  for (const f of PLUMBING_FRAGMENTS) {
    if (m.includes(f.toLowerCase())) return true;
  }

  return false;
}
