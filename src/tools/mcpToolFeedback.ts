/**
 * mcpToolFeedback.ts
 *
 * Generic MCP tool feedback parser.
 *
 * Parses tool descriptions, input schemas, and error strings emitted by ANY MCP server
 * to extract structured invocation guidance — no provider-specific assumptions.
 *
 * Detects patterns like:
 *   - "Please specify the <param> parameter"
 *   - "pass it as the <param> parameter"
 *   - "<param> variable will be set based on the <param> parameter"
 *   - "Available <resources>: A, B, C"
 *   - JSON Schema `required` arrays + `enum` values
 *
 * Used by `tools_call` for one bounded retry when the corrected value is unambiguous,
 * and for structured clarification feedback when it is not.
 *
 * Node-testable — no Workers / Cloudflare-specific imports.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpToolFeedback {
  kind: "missing_required_tool_input";
  /** Name of the required parameter that is missing or misplaced. */
  parameter: string;
  /** Known-good candidate values extracted from descriptions or error text. Empty when unknown. */
  candidates: string[];
  /** Where the feedback was detected. */
  source: "tool_description" | "tool_error" | "schema";
  /** Missing input belongs to native tool invocation arguments, not API query/path payload. */
  inputLevel?: "tool";
}

export interface McpToolFeedbackOpts {
  /** Tool description text (from tools_describe). */
  description?: string;
  /** Raw error message from a failed tool invocation. */
  errorMessage?: string;
  /** JSON Schema `inputSchema` / `parameters` object from the tool definition. */
  schema?: unknown;
}

const REQUIRED_TOP_LEVEL_INPUTS = new Set([
  "account_id",
  "organization_id",
  "project_id",
  "workspace_id",
  "region",
  "tenant_id",
]);

const PARAM_ALIASES: Record<string, string[]> = {
  account_id: ["accountId", "account", "accountID"],
  organization_id: ["organizationId", "org_id", "orgId", "organization"],
  project_id: ["projectId", "project", "projectID"],
  workspace_id: ["workspaceId", "workspace", "workspaceID"],
  region: ["regionId", "location", "zone"],
  tenant_id: ["tenantId", "tenant", "tenantID"],
};

function isToolLevelRequiredInput(parameter: string): boolean {
  return REQUIRED_TOP_LEVEL_INPUTS.has(parameter.trim().toLowerCase());
}

function extractDescriptionRequiredInput(text: string): string | null {
  for (const param of REQUIRED_TOP_LEVEL_INPUTS) {
    const escaped = param.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const topLevelPattern = new RegExp(
      String.raw`(?:specify|provide|pass)[^\n]{0,100}\b${escaped}\b[^\n]{0,100}(?:parameter|top-level|top level|tool input)|\b${escaped}\b[^\n]{0,100}(?:parameter\s+is\s+required|required\s+parameter)` ,
      "i"
    );
    if (topLevelPattern.test(text)) return param;
  }
  return null;
}

// ── Candidate extraction helpers ──────────────────────────────────────────────

/**
 * Parse a comma/semicolon-separated list that follows "Available X: ..." or "Options: ..."
 * Returns up to 20 trimmed non-empty values.
 */
function extractCandidateList(text: string): string[] {
  // Match: "Available <word>s?: <values>" or "Options?: <values>"
  const listMatch = /(?:available\s+\w+s?\s*:|options?\s*:)\s*([^\n.;]{2,200})/i.exec(text);
  if (!listMatch) return [];
  const raw = listMatch[1];
  // Split on comma or semicolon, strip surrounding quotes/brackets
  return raw
    .split(/[,;]/)
    .map((s) => s.trim().replace(/^["'\[({`]+|["'\])}`,]+$/g, "").trim())
    .filter((s) => s.length > 0 && s.length <= 128)
    .slice(0, 20);
}

/**
 * Extract enum values from a JSON Schema property.
 */
function extractEnumCandidates(schema: unknown, paramName: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;

  // Walk properties / $defs
  const props = s.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const propDef = (props as Record<string, unknown>)[paramName];
    if (propDef && typeof propDef === "object") {
      const pd = propDef as Record<string, unknown>;
      if (Array.isArray(pd.enum)) {
        return pd.enum.filter((v): v is string => typeof v === "string").slice(0, 20);
      }
    }
  }
  return [];
}

/**
 * Extract `required` fields from a JSON Schema object.
 */
function extractSchemaRequiredFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.required)) {
    return s.required.filter((v): v is string => typeof v === "string");
  }
  return [];
}

// ── Parameter name detectors ──────────────────────────────────────────────────

/**
 * Patterns that identify a required parameter name from prose text.
 * Each returns the first capturing group as the parameter name.
 */
const PARAM_NAME_PATTERNS: RegExp[] = [
  // "Please specify the project_id parameter"
  /please\s+specify\s+(?:the\s+|a\s+|an\s+)?(\w+)\s+parameter/i,
  // "pass it as the project_id parameter" / "pass project_id as the project_id parameter"
  /pass\s+(?:it\s+|[\w_]+\s+)?as\s+(?:the\s+|a\s+|an\s+)?(\w+)\s+parameter/i,
  // "project_id variable will be set based on the project_id parameter"
  /(\w+)\s+(?:variable\s+)?will\s+be\s+(?:set|determined|resolved|obtained)\s+(?:based\s+on|from|via|using)\s+(?:the\s+)?(\w+)\s+parameter/i,
  // "the project_id parameter is required"
  /the\s+(\w+)\s+parameter\s+is\s+required/i,
  // "missing required parameter: project_id" / "required parameter 'project_id'"
  /(?:missing\s+)?required\s+parameter[:\s'"]+(\w+)/i,
  // "provide a project_id" / "provide the project_id"
  /provide\s+(?:a\s+|the\s+)?(\w+)(?:\s+parameter)?/i,
];

/**
 * Extract a parameter name from text using the detection patterns.
 * Returns the first match or null.
 */
function detectParamName(text: string): string | null {
  for (const re of PARAM_NAME_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Some patterns have two groups — prefer the second (more specific) group when both exist.
      const name = m[2] ?? m[1];
      if (name && /^\w+$/.test(name) && name.length <= 64) return name;
    }
  }
  return null;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse MCP tool metadata and/or an error message to extract structured invocation feedback.
 *
 * Returns `null` when no actionable parameter requirement is detected.
 */
export function parseMcpToolFeedback(opts: McpToolFeedbackOpts): McpToolFeedback | null {
  const texts: Array<{ text: string; source: McpToolFeedback["source"] }> = [];

  if (opts.description) {
    texts.push({ text: opts.description, source: "tool_description" });
  }
  if (opts.errorMessage) {
    texts.push({ text: opts.errorMessage, source: "tool_error" });
  }

  // Try parameter + candidate extraction from prose sources.
  // Keep all hits so we can choose the most informative one rather than returning
  // the first match (which may be a description without candidate values).
  const proseHits: McpToolFeedback[] = [];
  for (const { text, source } of texts) {
    const paramName = detectParamName(text) ?? extractDescriptionRequiredInput(text);
    if (!paramName) continue;

    const candidates = extractCandidateList(text);
    const schemaCandidates = extractEnumCandidates(opts.schema, paramName);
    const allCandidates = [...new Set([...candidates, ...schemaCandidates])];

    proseHits.push({
      kind: "missing_required_tool_input",
      parameter: paramName,
      candidates: allCandidates,
      source,
      ...(isToolLevelRequiredInput(paramName) ? { inputLevel: "tool" as const } : {}),
    });
  }

  if (proseHits.length > 0) {
    // Prefer the hit with candidate values (enables automatic retry).
    // On ties, prefer tool_error over tool_description because runtime guidance
    // is usually more specific than generic tool descriptions.
    proseHits.sort((a, b) => {
      const byCandidates = b.candidates.length - a.candidates.length;
      if (byCandidates !== 0) return byCandidates;
      const aError = a.source === "tool_error" ? 1 : 0;
      const bError = b.source === "tool_error" ? 1 : 0;
      return bError - aError;
    });
    return proseHits[0];
  }

  // Fallback: schema-only — if schema has required fields NOT supplied in the call context
  if (opts.schema) {
    const required = extractSchemaRequiredFields(opts.schema);

    // First: explicitly recognize known tool-level required inputs even without enum candidates.
    for (const field of required) {
      if (isToolLevelRequiredInput(field)) {
        return {
          kind: "missing_required_tool_input",
          parameter: field,
          candidates: extractEnumCandidates(opts.schema, field),
          source: "schema",
          inputLevel: "tool",
        };
      }
    }

    // Only actionable when we also have candidates from the schema (enum)
    for (const field of required) {
      const enumCandidates = extractEnumCandidates(opts.schema, field);
      if (enumCandidates.length > 0) {
        return {
          kind: "missing_required_tool_input",
          parameter: field,
          candidates: enumCandidates,
          source: "schema",
          ...(isToolLevelRequiredInput(field) ? { inputLevel: "tool" as const } : {}),
        };
      }
    }
  }

  return null;
}

// ── Retry input resolver ──────────────────────────────────────────────────────

/**
 * Given the original tool input and detected feedback, attempt to build a corrected input
 * for a single automatic retry — without requiring user interaction.
 *
 * Returns `null` when:
 * - The parameter is already present in input (nothing to fix).
 * - Multiple candidates exist and none match an existing input value (needs user choice).
 * - Feedback kind is unrecognised.
 *
 * Returns a corrected input Record when:
 * - Exactly one candidate exists (unambiguous).
 * - An existing input value (under any key) matches one of the candidates.
 *   This handles the case where the user supplied the right value under a wrong key name.
 */
export function resolveMcpToolRetryInput(
  input: Record<string, unknown>,
  feedback: McpToolFeedback
): Record<string, unknown> | null {
  if (feedback.kind !== "missing_required_tool_input") return null;
  const { parameter, candidates } = feedback;

  // Already has the target parameter — nothing to correct.
  if (input[parameter] !== undefined) return null;

  // Promote common alias keys into the required top-level native parameter.
  const aliases = PARAM_ALIASES[parameter] ?? [];
  for (const alias of aliases) {
    const v = input[alias];
    if (typeof v === "string" && v.trim().length > 0) {
      return { ...input, [parameter]: v.trim() };
    }
  }

  // Check if any existing input value (string) matches a candidate.
  if (candidates.length > 0) {
    for (const val of Object.values(input)) {
      if (typeof val === "string" && candidates.includes(val)) {
        return { ...input, [parameter]: val };
      }
    }
  }

  // Exactly one candidate: use it automatically (unambiguous).
  if (candidates.length === 1) {
    return { ...input, [parameter]: candidates[0] };
  }

  // Multiple candidates with no user-supplied match → needs clarification.
  return null;
}

// ── Helper: extract description from an AI SDK tool entry ─────────────────────

/**
 * Extract the description string from an `ai` SDK ToolSet entry.
 * Returns empty string when not present.
 */
export function getToolEntryDescription(toolEntry: unknown): string {
  if (!toolEntry || typeof toolEntry !== "object" || Array.isArray(toolEntry)) return "";
  const obj = toolEntry as Record<string, unknown>;
  return typeof obj.description === "string" ? obj.description : "";
}

/**
 * Extract the inputSchema/parameters from an `ai` SDK ToolSet entry.
 * Returns null when not present.
 */
export function getToolEntrySchema(toolEntry: unknown): unknown | null {
  if (!toolEntry || typeof toolEntry !== "object" || Array.isArray(toolEntry)) return null;
  const obj = toolEntry as Record<string, unknown>;
  if (obj.parameters !== undefined) return obj.parameters;
  if (obj.inputSchema !== undefined) return obj.inputSchema;
  return null;
}
