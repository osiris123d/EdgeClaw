import type { ToolSet } from "ai";

/**
 * Rough proxy for tool-schema footprint in LLM prompts (characters / 4).
 * Avoids zod-to-json conversion; uses reflective JSON where possible.
 */
export function estimateToolSchemaTokens(tool: unknown): number {
  if (!tool || typeof tool !== "object") return 32;
  const t = tool as Record<string, unknown>;
  let chars = 48;
  if (typeof t.description === "string") {
    chars += t.description.length;
  }
  if ("parameters" in t && t.parameters !== undefined) {
    try {
      chars += JSON.stringify(t.parameters).length;
    } catch {
      chars += 400;
    }
  } else if ("inputSchema" in t && t.inputSchema !== undefined) {
    try {
      chars += JSON.stringify(t.inputSchema).length + 120;
    } catch {
      chars += 400;
    }
  } else if ("schema" in t && t.schema !== undefined) {
    try {
      chars += JSON.stringify(t.schema).length;
    } catch {
      chars += 400;
    }
  }
  return Math.max(32, Math.ceil(chars / 4));
}

/** Sum approximate schema tokens across a merged tool registry. */
export function estimateMergedToolSurfaceTokens(tools: ToolSet): number {
  let sum = 0;
  for (const def of Object.values(tools)) {
    sum += estimateToolSchemaTokens(def);
  }
  return sum;
}

/** Approximate footprint for tools remaining visible after `activeTools` filtering. */
export function estimateActiveToolSurfaceTokens(
  tools: ToolSet,
  activeNames: string[]
): number {
  let sum = 0;
  for (const name of activeNames) {
    const def = tools[name];
    if (def) sum += estimateToolSchemaTokens(def);
  }
  return sum;
}
