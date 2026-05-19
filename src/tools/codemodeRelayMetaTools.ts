/**
 * Codemode relay meta-tools (tools_find, openapi_search, cloudflare_request, …).
 * Node-testable — does not import @cloudflare/think sandbox / cloudflare: workers.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z, type ZodRawShape, ZodError } from "zod";
import {
  assertValidAsyncArrowSource,
  buildCloudflareRequestInnerCode,
  buildOpenApiDescribeOperationInnerCode,
  buildOpenapiSearchInnerCode,
  DEFAULT_DEVICE_LIST_PATH_TEMPLATES,
  injectAccountIntoApiPath,
  codemodeWireRawErrorMessage,
  codemodeWireSafeErrorMessage,
  codemodeWireIsInternalSerializationNoise,
  edgeClawOpenapiRelayToolFailure,
  ensureJsonSafeForCodemodeRelay,
  isCodemodeWireDebugEnabled,
  logCodemodeOpenapiRelayFailure,
  logCodemodeWireDelegatedBoundary,
  matchDeviceNeedle,
  pathUsesHostnameAsDeviceIdSegment,
  pathUsesLikelyHostnameAsDeviceSegment,
  pickDeviceRowsFromCloudflarePayload,
  pickWrappedToolName,
  toDelegatedMcpRpcWireValue,
  toolsFindByDescription,
  truncateCodemodeDebugJson,
  tryParseJsonFromMcpToolResult,
} from "./codemodeRouterHelpers";
import {
  buildOpenApiExecutionPlan,
  normalizeOpenApiPathTemplate,
  pathnameTemplateParams,
  validateOpenApiExecutionPlan,
} from "./codemodeOpenApiExecutionPlan";
import {
  bumpOpenapiSearchInvocation,
  diagnoseMissingOpenApiDescribe,
  getCodemodeRouterInvocationDebugSnapshot,
  getCapturedOpenApiOperation,
  hasOpenApiSearchConfirmedEndpoint,
  markOpenApiDescribeFailed,
  markOpenApiDescribeSucceeded,
  markToolsDescribeSucceeded,
  openapiDescribeCacheKey,
  recordOpenApiSearchEndpoints,
  resolveOpenApiPlannerCacheHit,
  schemaLookupGateSatisfied,
  setCapturedOpenApiOperation,
  tryGetCodemodeRouterInvocationStore,
} from "./codemodeRouterInvocation";
import {
  parseMcpToolFeedback,
  resolveMcpToolRetryInput,
  getToolEntryDescription,
  getToolEntrySchema,
} from "./mcpToolFeedback";

async function invokeToolExecute(
  t: ToolSet[string],
  input: Record<string, unknown>,
  dbg?: { helperMethod: string; delegatedToolName?: string }
): Promise<unknown> {
  const exec = (t as { execute?: (inp: unknown) => unknown | Promise<unknown> }).execute;
  if (typeof exec !== "function") {
    throw new Error("Tool is missing execute()");
  }
  if (!dbg || !isCodemodeWireDebugEnabled()) {
    return exec(input);
  }
  try {
    const raw = await exec(input);
    const rawCtor =
      raw !== null && raw !== undefined && typeof raw === "object"
        ? ((raw as object).constructor?.name ?? "Object")
        : typeof raw;
    logCodemodeWireDelegatedBoundary({
      boundaryLabel: `invokeToolExecute:resolved:${dbg.helperMethod}`,
      helperMethod: dbg.helperMethod,
      delegatedMcpToolName: dbg.delegatedToolName,
      rawExecuteResolved: true,
      rawConstructorName: rawCtor,
    });
    return raw;
  } catch (e) {
    logCodemodeWireDelegatedBoundary({
      boundaryLabel: `invokeToolExecute:threw:${dbg.helperMethod}`,
      helperMethod: dbg.helperMethod,
      delegatedMcpToolName: dbg.delegatedToolName,
      rawExecuteResolved: false,
      errorBeforeNeutralize: codemodeWireRawErrorMessage(e),
    });
    throw e;
  }
}

function stringifyToolBrief(name: string, def: ToolSet[string]): Record<string, unknown> {
  if (!def || typeof def !== "object") {
    return { name, description: "(unknown)", schema: {} };
  }
  const obj = def as Record<string, unknown>;
  const description =
    typeof obj.description === "string" ? obj.description : "";
  let schemaUnknown: Record<string, unknown> = {};

  function replacerSafe(_k: string, v: unknown): unknown {
    if (typeof v === "function") return "(function)";
    return v;
  }

  if ("parameters" in obj && obj.parameters && typeof obj.parameters === "object") {
    schemaUnknown = obj.parameters as Record<string, unknown>;
  } else if ("inputSchema" in obj && obj.inputSchema !== undefined) {
    try {
      schemaUnknown =
        typeof obj.inputSchema === "object"
          ? (JSON.parse(JSON.stringify(obj.inputSchema, replacerSafe)) as Record<string, unknown>)
          : { note: typeof obj.inputSchema };
    } catch {
      schemaUnknown = { note: "(inputSchema unavailable)" };
    }
  }

  return { name, description, schema: schemaUnknown };
}

const toolsDescribeSchema = z.object({
  toolName: z.string().min(1).describe("Tool id from tools_list()"),
});

const toolsCallSchema = z.object({
  toolName: z.string().min(1).describe("Target tool identifier"),
  input: z
    .record(z.string(), z.unknown())
    .describe("Arguments for that tool — match tools_describe"),
});

const toolsFindSchema = z.object({
  query: z.string().min(1).describe("Free-text query matched against tool descriptions (not opaque ids)."),
});

const toolsCallCodeSchema = z.object({
  toolName: z.string().min(1),
  code: z.string().min(1).describe("One async arrow function source (validated on host)."),
});

const openapiSearchSchema = z.object({
  product: z.string().optional(),
  tag: z.string().optional(),
  pathIncludes: z.string().optional(),
  summaryIncludes: z.string().optional(),
});

const cloudflareRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .min(1)
    .describe("Resolved or templated path; `{account_id}` is filled from explicit target account context."),
  /** Optional target account id for API execution context (not runtime gateway account inference). */
  account_id: z.string().min(1).optional(),
  /** OpenAPI `paths` key when it differs from the literal `path` sent to MCP execute. */
  operationPathTemplate: z.string().min(1).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])).optional(),
  body: z.unknown().optional(),
  intent: z.string().optional(),
  /** Prior resolved router partials (`resource identifiers`, inventories, …) — fills required slots before user literals. */
  knownValues: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional reduction plan for list/search responses.
   * When omitted, list payloads are still compacted by default to avoid raw payload leakage.
   */
  reduction: z
    .object({
      select: z.array(z.string().min(1)).max(64).optional(),
      filterByPrefix: z
        .object({
          field: z.string().min(1),
          value: z.string().optional(),
          prefix: z.string().optional(),
          caseInsensitive: z.boolean().optional(),
          trim: z.boolean().optional(),
        })
        .optional(),
      normalize: z
        .object({
          trimStrings: z.boolean().optional(),
          caseInsensitiveFields: z.array(z.string().min(1)).max(64).optional(),
          lowercaseFields: z.array(z.string().min(1)).max(64).optional(),
        })
        .optional(),
      pagination: z
        .object({
          enabled: z.boolean().optional(),
          pageParam: z.string().min(1).optional(),
          perPageParam: z.string().min(1).optional(),
          perPage: z.number().int().min(1).max(5000).optional(),
          maxPages: z.number().int().min(1).max(200).optional(),
          pageSize: z.number().int().min(1).max(5000).optional(),
          cursorParam: z.string().min(1).optional(),
          cursorPath: z.string().min(1).optional(),
        })
        .optional(),
      compactResultCap: z.number().int().min(1).max(500).optional(),
    })
    .optional(),
});

type CloudflareRequestInput = z.infer<typeof cloudflareRequestSchema>;

function extractErrorTextFromParsedResult(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.error === "string" && rec.error.trim().length > 0) return rec.error;
  if (rec.ok === false) return JSON.stringify(parsed);
  return null;
}

function classifySemanticKeyFromErrorText(errorText: string): string | null {
  if (!errorText) return null;
  if (/\bconflicting_tool_input\b|mcp-required-input-inject-conflict/i.test(errorText)) {
    return "conflicting_tool_input:top_level_identifier_mismatch";
  }
  if (/\b(?:forbidden|permission denied|not authorized|authorization error|insufficient permissions?)\b|\b403\b/i.test(errorText)) {
    return "permission_error:provider_access_denied";
  }
  if (/Cloudflare API error:\s*10000|Authentication error|\b401\b|Unauthorized|auth(?:entication)?\s+(?:failed|error|invalid)/i.test(errorText)) {
    return "auth_error:provider_auth_failed";
  }
  if (/missing_required_tool_input|missing[_\s-]?(account|organization|project|workspace|tenant|region)[_\s-]?id|please specify[^\n]{0,80}parameter|multiple accounts?/i.test(errorText)) {
    return "missing_tool_input:required_parameter";
  }
  if (/spec is not defined|unknown_helper_argument|wrong tool api|spec_not_defined_in_execute_tool/i.test(errorText)) {
    return "wrong_tool_api:invalid_execution_context";
  }
  if (/invalid[_\s-]?tool[_\s-]?input|unrecognized_keys|schema validation|invalid_input|zod/i.test(errorText)) {
    return "invalid_tool_input:schema_validation_failed";
  }
  if (/timeout|timed out|tool_agent_delegation_timeout/i.test(errorText)) {
    return "timeout:delegated_tool_execution";
  }
  return null;
}

async function invokeToolExecuteWithToolLevelFeedbackRetry(args: {
  t: ToolSet[string];
  baseInput: Record<string, unknown>;
  helperMethod: string;
  delegatedToolName: string;
  sourceHelperName: string;
  configuredAccountId?: string;
  requestedAccountId?: string;
}): Promise<
  | {
      ok: true;
      raw: unknown;
      parsed: unknown;
      retriedWithFeedback?: boolean;
      retriedDirectNative?: boolean;
      semanticKey?: string;
    }
  | {
      ok: false;
      error: string;
      retriedWithFeedback?: boolean;
      retrySuppressed?: boolean;
      semanticKey?: string;
      feedback?: {
        kind: "missing_required_tool_input";
        parameter: string;
        inputLevel: "tool";
        candidates: string[];
        source: "tool_description" | "tool_error" | "schema";
      };
    }
> {
  const toolDescription = getToolEntryDescription(args.t);
  const toolSchema = getToolEntrySchema(args.t);

  const accountIdFallback =
    typeof args.requestedAccountId === "string" && args.requestedAccountId.trim().length > 0
      ? args.requestedAccountId.trim()
      : typeof args.configuredAccountId === "string" && args.configuredAccountId.trim().length > 0
        ? args.configuredAccountId.trim()
        : undefined;

  const attemptToolLevelFeedbackRetry = async (
    errorMsg: string
  ): Promise<
    | {
        handled: false;
      }
    | {
        handled: true;
        result:
          | {
              ok: true;
              raw: unknown;
              parsed: unknown;
              retriedWithFeedback: true;
              retriedDirectNative: true;
              semanticKey: string;
            }
          | {
              ok: false;
              error: string;
              retriedWithFeedback?: boolean;
              retrySuppressed: true;
              semanticKey: string;
              feedback?: {
                kind: "missing_required_tool_input";
                parameter: string;
                inputLevel: "tool";
                candidates: string[];
                source: "tool_description" | "tool_error" | "schema";
              };
            };
      }
  > => {
    const feedback = parseMcpToolFeedback({
      description: toolDescription || undefined,
      errorMessage: errorMsg,
      schema: toolSchema ?? undefined,
    });
    if (!feedback) return { handled: false };
    if (feedback.kind !== "missing_required_tool_input") return { handled: false };
    if (feedback.inputLevel !== "tool") return { handled: false };

    let correctedInput = resolveMcpToolRetryInput(args.baseInput, feedback);
    if (!correctedInput && feedback.parameter === "account_id" && accountIdFallback) {
      correctedInput = { ...args.baseInput, account_id: accountIdFallback };
    }

    if (!correctedInput) {
      return {
        handled: true,
        result: {
          ok: false,
          error: errorMsg,
          semanticKey:
            classifySemanticKeyFromErrorText(errorMsg) ?? `missing_tool_input:${feedback.parameter}`,
          retrySuppressed: true,
          feedback: {
            kind: feedback.kind,
            parameter: feedback.parameter,
            inputLevel: "tool",
            candidates: feedback.candidates,
            source: feedback.source,
          },
        },
      };
    }

    console.info(
      `[tool-agent-feedback-retry] direct_native_retry tool=${args.delegatedToolName} ` +
        `parameter=${feedback.parameter} inputLevel=tool source=${args.sourceHelperName}`
    );

    try {
      const raw2 = await invokeToolExecute(args.t, correctedInput, {
        helperMethod: `${args.helperMethod}:feedback_retry_direct_native`,
        delegatedToolName: args.delegatedToolName,
      });
      const parsed2 = tryParseJsonFromMcpToolResult(raw2);
      const retryErrorLike = extractErrorTextFromParsedResult(parsed2);
      if (retryErrorLike) {
        const staleKey = `missing_tool_input:${feedback.parameter}`;
        const overrideKey = classifySemanticKeyFromErrorText(retryErrorLike);
        if (overrideKey && overrideKey !== staleKey) {
          console.info(
            `[EdgeClaw][tool-agent-feedback] stale_semantic_override old=${staleKey} new=${overrideKey} ` +
              `tool=${args.delegatedToolName} helper=${args.sourceHelperName}`
          );
        }
        return {
          handled: true,
          result: {
            ok: false,
            error: retryErrorLike,
            retriedWithFeedback: true,
            semanticKey: overrideKey ?? staleKey,
            retrySuppressed: true,
          },
        };
      }
      return {
        handled: true,
        result: {
          ok: true,
          raw: raw2,
          parsed: parsed2,
          retriedWithFeedback: true,
          retriedDirectNative: true,
          semanticKey: `missing_tool_input:${feedback.parameter}`,
        },
      };
    } catch (e2) {
      const retryErrMsg = codemodeWireSafeErrorMessage(
        e2,
        0,
        `${args.helperMethod}:feedback_retry_direct_native_catch`
      );
      return {
        handled: true,
        result: {
          ok: false,
          error: retryErrMsg,
          retriedWithFeedback: true,
          semanticKey:
            classifySemanticKeyFromErrorText(retryErrMsg) ?? `missing_tool_input:${feedback.parameter}`,
          retrySuppressed: true,
        },
      };
    }
  };

  try {
    const raw = await invokeToolExecute(args.t, args.baseInput, {
      helperMethod: args.helperMethod,
      delegatedToolName: args.delegatedToolName,
    });
    const parsed = tryParseJsonFromMcpToolResult(raw);
    const errorLike = extractErrorTextFromParsedResult(parsed);
    if (errorLike) {
      const retry = await attemptToolLevelFeedbackRetry(errorLike);
      if (retry.handled) return retry.result;
      const semanticKey = classifySemanticKeyFromErrorText(errorLike);
      return {
        ok: false,
        error: errorLike,
        retrySuppressed: true,
        ...(semanticKey ? { semanticKey } : {}),
      };
    }
    return { ok: true, raw, parsed };
  } catch (e) {
    const msg = codemodeWireSafeErrorMessage(e, 0, `${args.helperMethod}:invoke_execute_catch`);
    const retry = await attemptToolLevelFeedbackRetry(msg);
    if (retry.handled) return retry.result;
    throw e;
  }
}

const openapiDescribeOperationSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).describe("Exact OpenAPI path template (`/pets/{petId}`), same key as spec.paths."),
});

const resolveDeviceIdentifierSchema = z.object({
  hostnameOrSerial: z.string().min(2).describe("Hostname, serial, or display name token to resolve to a Cloudflare device UUID."),
});

const toolsListSchema = z.object({}).strict();

function parseCodemodeRouterInput<S extends ZodRawShape>(
  schema: z.ZodObject<S>,
  input: unknown
): { ok: true; value: z.infer<z.ZodObject<S>> } | { ok: false; invalidKeys: string[] } {
  try {
    const value = schema.strict().parse(input);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ZodError) {
      const keys = new Set<string>();
      for (const issue of e.issues) {
        const rec = issue as { code?: string; keys?: string[] };
        if (rec.code === "unrecognized_keys" && Array.isArray(rec.keys)) {
          for (const k of rec.keys) keys.add(k);
        }
      }
      if (keys.size > 0) return { ok: false, invalidKeys: [...keys].sort() };
      const fallbacks = e.issues.map((i) => (i.path?.length ? i.path.join(".") : i.code)).slice(0, 12);
      return { ok: false, invalidKeys: fallbacks.length > 0 ? fallbacks : ["(validation)"] };
    }
    return { ok: false, invalidKeys: ["(invalid_input)"] };
  }
}

function unknownHelperArgument(invalidKeys: string[]): Record<string, unknown> {
  return { ok: false, error: "unknown_helper_argument", details: { invalidKeys } };
}

function inferOpenapiMirrorFailureKind(err: unknown): string {
  const m = codemodeWireRawErrorMessage(err);
  if (m.includes("[mirror-rpc-throw]")) return "toolAgent_mirror_rpc_stub_throw";
  if (m.includes("[mirror:rpc_ok_false]")) return "toolAgent_mirror_rpc_returned_ok_false";
  if (m.includes("[mirror:resultWire_JSON_parse]")) return "toolAgent_resultWire_JSON_parse";
  if (m.includes("[mirror:wire_sanitize]")) return "toolAgent_mirror_post_rpc_wire_clone";
  if (m.includes("[rpcExecuteDelegatedMcpTool:")) return "mainAgent_rpc_delegate_labeled_failure";
  if (m.includes("MainAgent rpcExecuteDelegatedMcpTool is not available")) return "toolAgent_rpc_missing_callable";
  return "delegated_mirror_invoke_throw";
}

/**
 * Errors that must not be retried — the same call with the same arguments will always fail.
 * Patterns are provider-agnostic: match on semantic message content, not vendor error codes.
 * Return a `{ kind, reason }` descriptor or `null` when the error is potentially transient.
 */
export function classifyNonRetryableToolError(
  errMessage: string
): { kind: string; reason: string } | null {
  const m = errMessage;
  // Discovery global (spec, schema, catalog, …) accessed in an execute-tool context where it is not defined.
  if (/\b(spec|schema|catalog|manifest)\s+is\s+not\s+defined\b/i.test(m)) {
    return {
      kind: "discovery_global_not_in_execute_scope",
      reason: "A discovery global (spec, schema, catalog) only exists in the search/spec tool environment. Use dedicated search or describe helpers instead of execute tools for schema introspection.",
    };
  }
  // Named resource does not exist in the target account or service.
  if (/does not exist on your account/i.test(m) || /resource does not exist/i.test(m) || /not found on (your )?account/i.test(m)) {
    return {
      kind: "resource_not_found_on_account",
      reason: "The named resource does not exist in the target account or service. Verify the identifier before retrying.",
    };
  }
  // Authentication or authorization failure — retrying the same call will not help.
  if (/authentication error/i.test(m) || /\b(401|Unauthorized)\b/.test(m) || /auth(entication)?\s+(failed|error|invalid)/i.test(m)) {
    return {
      kind: "api_authentication_error",
      reason: "API token is invalid or lacks permissions for this endpoint.",
    };
  }
  return null;
}

/**
 * Patterns that indicate codemode sandbox code is attempting to access `spec` directly,
 * which only exists in the MCP search tool environment (not execute).
 * Used to short-circuit before RPC invocation.
 */
const SPEC_INSPECTION_PATTERNS = [
  /\bspec\s*\.\s*paths\b/,
  /\bspec\s*\.\s*components\b/,
  /\bspec\s*\.\s*info\b/,
  /\bspec\s*\.\s*openapi\b/,
  /\bObject\s*\.\s*keys\s*\(\s*spec\b/,
  /\bJSON\s*\.\s*stringify\s*\(\s*spec\b/,
  /\breturn\s+spec\b/,
  /\bconsole\s*\.\s*log\s*\(\s*spec\b/,
];

function codeAppearsToInspectSpec(code: string): boolean {
  return SPEC_INSPECTION_PATTERNS.some((re) => re.test(code));
}

/** Map legacy `{ arguments }` → `{ input }` so sandbox callers match strict schema. */
function normalizeToolsCallIncoming(inputUnknown: unknown): unknown {
  if (!inputUnknown || typeof inputUnknown !== "object" || Array.isArray(inputUnknown)) {
    return inputUnknown;
  }
  const r = { ...(inputUnknown as Record<string, unknown>) };
  if (
    r.input === undefined &&
    "arguments" in r &&
    r.arguments !== undefined &&
    typeof r.arguments === "object" &&
    !Array.isArray(r.arguments)
  ) {
    r.input = r.arguments as Record<string, unknown>;
    delete r.arguments;
  }
  return r;
}

function maybeCoerceHttpRelayArgsOnce(
  req: CloudflareRequestInput
): CloudflareRequestInput | null {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const hasQueryKeys =
    req.query &&
    typeof req.query === "object" &&
    !Array.isArray(req.query) &&
    Object.keys(req.query).length > 0;

  const paramsNest = b.params;
  if (!hasQueryKeys && paramsNest && typeof paramsNest === "object" && !Array.isArray(paramsNest)) {
    const query: Record<string, string | number | boolean | undefined> = {};
    for (const [key, raw] of Object.entries(paramsNest as Record<string, unknown>)) {
      if (raw === undefined) continue;
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") query[key] = raw;
      else query[key] = JSON.stringify(raw);
    }
    return { ...req, query, body: undefined };
  }
  return null;
}

function unwrapCloudflareApiEnvelope(data: unknown): { success: boolean; payload: unknown; errors?: unknown } {
  if (!data || typeof data !== "object") return { success: true, payload: data };
  const rec = data as { success?: boolean; result?: unknown; errors?: unknown };
  if (typeof rec.success === "boolean" && rec.success === false) {
    return { success: false, payload: data, errors: rec.errors };
  }
  if ("result" in rec && rec.result !== undefined) return { success: true, payload: rec.result };
  return { success: true, payload: data };
}

function sanitizeInvalidControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function tryParseJsonWithSanitization(raw: unknown): { value: unknown; sanitized: boolean } {
  if (typeof raw !== "string") return { value: raw, sanitized: false };
  const trimmed = raw.trim();
  if (!trimmed) return { value: raw, sanitized: false };
  try {
    return { value: JSON.parse(trimmed), sanitized: false };
  } catch {
    const cleaned = sanitizeInvalidControlChars(trimmed);
    if (cleaned !== trimmed) {
      try {
        return { value: JSON.parse(cleaned), sanitized: true };
      } catch {
        return { value: raw, sanitized: false };
      }
    }
    return { value: raw, sanitized: false };
  }
}

function normalizeOpenApiTargetPathVariants(pathRaw: string): string[] {
  const norm = normalizeOpenApiPathTemplate(pathRaw);
  const canon = norm.replace(/\/accounts\/([a-f0-9]{32})(?=\/|$)/gi, "/accounts/{account_id}");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [norm, canon]) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function tryParseJsonStringOnce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function pickOperationFromPathItem(pathItem: Record<string, unknown>, method: string): Record<string, unknown> | null {
  const op = pathItem[method.toLowerCase()];
  if (op && typeof op === "object" && !Array.isArray(op)) return op as Record<string, unknown>;
  return null;
}

function coerceDescribeOperation(value: unknown): Record<string, unknown> | null {
  const parsed = tryParseJsonStringOnce(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  
  // Direct operation object
  if (rec.operation && typeof rec.operation === "object" && !Array.isArray(rec.operation)) {
    return rec.operation as Record<string, unknown>;
  }

  // Operation as stringified field
  const operationFromString = tryParseJsonStringOnce(rec.operation);
  if (
    operationFromString &&
    typeof operationFromString === "object" &&
    !Array.isArray(operationFromString)
  ) {
    return operationFromString as Record<string, unknown>;
  }

  // Live MCP pattern: { code, result: JSON.stringify({ok: true, operation: {...}}), logs }
  // Parse result field and extract operation from it
  if (typeof rec.result === "string") {
    const resultParsed = tryParseJsonStringOnce(rec.result);
    if (resultParsed && typeof resultParsed === "object" && !Array.isArray(resultParsed)) {
      const resultRec = resultParsed as Record<string, unknown>;
      // Check for operation in parsed result
      if (resultRec.operation && typeof resultRec.operation === "object" && !Array.isArray(resultRec.operation)) {
        return resultRec.operation as Record<string, unknown>;
      }
      // Check if parsed result itself is an operation shape
      const looksLikeOperationShape =
        "parameters" in resultRec ||
        "requestBody" in resultRec ||
        "responses" in resultRec ||
        "summary" in resultRec ||
        "description" in resultRec ||
        "tags" in resultRec;
      if (looksLikeOperationShape) {
        return resultRec;
      }
    }
  }

  // Direct operation shape check
  const looksLikeOperationShape =
    "parameters" in rec ||
    "requestBody" in rec ||
    "responses" in rec ||
    "summary" in rec ||
    "description" in rec ||
    "tags" in rec;
  if (looksLikeOperationShape) {
    return rec;
  }
  return null;
}

// ── Diagnostic helpers for openapi_describe_operation ────────────────────────
// These are temporary; do NOT edit routing, fallback, or cloudflare_request.

function redactSecretsForDiagnostic(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/"authorization"\s*:\s*"[^"]{0,4096}"/gi, '"authorization":"[REDACTED]"')
    .replace(/"cf-aig-authorization"\s*:\s*"[^"]{0,4096}"/gi, '"cf-aig-authorization":"[REDACTED]"')
    .replace(/"cookie"\s*:\s*"[^"]{0,4096}"/gi, '"cookie":"[REDACTED]"')
    .replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[EMAIL_REDACTED]")
    .replace(/"(?:api_?token|api_?key|token|secret)"\s*:\s*"[^"]{0,4096}"/gi, (m) =>
      m.replace(/"[^"]{0,4096}"$/, '"[REDACTED]"')
    );
}

interface DescribeNormalizerFailureDiagnostic {
  marker: "[EdgeClaw][describe-normalizer-debug-v3]";
  cacheKey: string;
  method: string;
  path: string;
  parsedType: string;
  parsedKeys: string[];
  parsedPreview: string;
  normalizedErrorText: string;
  normalizedShapeKeys: string[];
  candidateType: string;
  candidateKeys: string[];
  candidatePreview: string;
  unwrapDepth: number;
  parseAttempts: boolean;
  hasTopLevelOperation: boolean;
  hasNestedResult: boolean;
  nestedResultType: string;
  nestedResultKeys: string[];
  nestedResultHasOperation: boolean;
  reason: string;
}

function buildDescribeNormalizerFailureDiagnostic(args: {
  cacheKey: string;
  method: string;
  path: string;
  parsed: unknown;
  normalized: { ok: false; errorText: string; shapeKeys: string[] };
}): DescribeNormalizerFailureDiagnostic {
  const { cacheKey, method, path, parsed, normalized } = args;

  // Raw
  const parsedType = typeof parsed;
  const parsedKeys: string[] =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).slice(0, 30)
      : [];
  let rawStr: string;
  try {
    rawStr = typeof parsed === "string" ? parsed : JSON.stringify(parsed) ?? "";
  } catch {
    rawStr = String(parsed ?? "");
  }
  const parsedPreview = redactSecretsForDiagnostic(rawStr.slice(0, 4000));

  // Inspect top-level object fields
  const parsedRec =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const hasTopLevelOperation =
    parsedRec !== null &&
    "operation" in parsedRec &&
    typeof parsedRec.operation === "object" &&
    parsedRec.operation !== null;
  const hasNestedResult = parsedRec !== null && "result" in parsedRec;
  const nestedResultType =
    parsedRec !== null && hasNestedResult ? typeof parsedRec.result : "undefined";

  // Parse .result if string
  let parsedResult: unknown = parsedRec !== null && hasNestedResult ? parsedRec.result : undefined;
  let parseAttempts = false;
  if (typeof parsedResult === "string") {
    parseAttempts = true;
    try {
      parsedResult = JSON.parse(parsedResult);
    } catch {
      // keep as string
    }
  }
  const nestedResultKeys: string[] =
    parsedResult !== null && typeof parsedResult === "object" && !Array.isArray(parsedResult)
      ? Object.keys(parsedResult as Record<string, unknown>).slice(0, 30)
      : [];
  const nestedResultHasOperation =
    parsedResult !== null &&
    typeof parsedResult === "object" &&
    !Array.isArray(parsedResult) &&
    "operation" in (parsedResult as Record<string, unknown>);

  // Candidate: follow .result chain once, else fall back to string-parse of raw
  let candidate: unknown = parsed;
  let unwrapDepth = 0;
  if (typeof parsed === "string") {
    parseAttempts = true;
    try {
      candidate = JSON.parse(parsed);
      unwrapDepth = 1;
    } catch {
      // leave candidate as parsed string
    }
  } else if (parsedRec !== null && hasNestedResult) {
    candidate = parsedResult;
    unwrapDepth = parseAttempts ? 1 : 0;
  }

  const candidateType = typeof candidate;
  const candidateKeys: string[] =
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? Object.keys(candidate as Record<string, unknown>).slice(0, 30)
      : [];
  let candidateStr: string;
  try {
    candidateStr =
      typeof candidate === "string" ? candidate : JSON.stringify(candidate) ?? "";
  } catch {
    candidateStr = String(candidate ?? "");
  }
  const candidatePreview = redactSecretsForDiagnostic(candidateStr.slice(0, 4000));

  // Human-readable reason
  const reason =
    parsedType === "string"
      ? "parsed was a raw string — not JSON-parsed before describe (likely MCP text wrapper not extracted)"
      : hasNestedResult && nestedResultType === "string" && !nestedResultHasOperation
      ? "has .result string field but parsed result lacks .operation — MCP wrapper result may contain non-operation shape"
      : hasNestedResult && nestedResultHasOperation
      ? "has .result with .operation but normalizer still rejected — operation shape may be missing parameters/responses/summary/tags"
      : hasTopLevelOperation
      ? "has top-level .operation but normalizer still rejected — operation may be invalid shape"
      : `parsedType=${parsedType} parsedKeys=${JSON.stringify(parsedKeys.slice(0, 8))} — no recognisable operation, paths, pathItem, or result wrapper found`;

  return {
    marker: "[EdgeClaw][describe-normalizer-debug-v3]",
    cacheKey,
    method,
    path,
    parsedType,
    parsedKeys,
    parsedPreview,
    normalizedErrorText: normalized.errorText,
    normalizedShapeKeys: normalized.shapeKeys,
    candidateType,
    candidateKeys,
    candidatePreview,
    unwrapDepth,
    parseAttempts,
    hasTopLevelOperation,
    hasNestedResult,
    nestedResultType,
    nestedResultKeys,
    nestedResultHasOperation,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the value of the `"operation"` key from a raw JSON string using brace
 * matching, without requiring the entire string to be valid JSON.
 *
 * Needed because the MCP spec mirror can return a very large JSON string that
 * contains `$circular` placeholders or other non-standard constructs after the
 * operation object — making full `JSON.parse` fail at position ~24000 while the
 * operation object itself (starting near position 30) is perfectly valid.
 */
function extractOperationObjectFromRawString(raw: string): unknown | null {
  const idx = raw.indexOf('"operation"');
  if (idx < 0) return null;

  const colon = raw.indexOf(":", idx);
  if (colon < 0) return null;

  const start = raw.indexOf("{", colon);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      const candidate = raw.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function normalizeDescribePayload(args: {
  parsed: unknown;
  method: string;
  path: string;
}):
  | { ok: true; operation: Record<string, unknown>; shapeKeys: string[] }
  | { ok: false; errorText: string; shapeKeys: string[] } {
  console.log("[EdgeClaw][describe-normalizer-version] accepts_top_level_operation_string=v1");
  const methodLower = args.method.trim().toLowerCase();
  const targetPathVariants = normalizeOpenApiTargetPathVariants(args.path);
  const shapeKeys = new Set<string>();
  let firstError = "describe_parse_failed";

  const rememberKeys = (rec: Record<string, unknown>): void => {
    for (const key of Object.keys(rec)) {
      if (shapeKeys.size >= 40) break;
      shapeKeys.add(key);
    }
  };

  const looksLikeOperationShape = (rec: Record<string, unknown>): boolean =>
    "parameters" in rec ||
    "requestBody" in rec ||
    "responses" in rec ||
    "summary" in rec ||
    "description" in rec ||
    "tags" in rec;

  // Unwrap layers: iteratively parse stringified wrappers until reaching operation
  const unwrap = (value: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 20) return null; // Prevent infinite loops
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return unwrap(parsed, depth + 1);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const rec = value as Record<string, unknown>;
    rememberKeys(rec);

    // Check for direct operation
    if (rec.operation && typeof rec.operation === "object" && !Array.isArray(rec.operation)) {
      return rec.operation as Record<string, unknown>;
    }

    // Check for stringified operation field
    if (typeof rec.operation === "string") {
      const opUnwrapped = unwrap(rec.operation, depth + 1);
      if (opUnwrapped) return opUnwrapped;
    }

    // Check for result field containing stringified payload
    if (typeof rec.result === "string") {
      const resultUnwrapped = unwrap(rec.result, depth + 1);
      if (resultUnwrapped) {
        rememberKeys(resultUnwrapped);
        // If result unwraps to object with operation, extract it
        if (resultUnwrapped.operation && typeof resultUnwrapped.operation === "object" && !Array.isArray(resultUnwrapped.operation)) {
          return resultUnwrapped.operation as Record<string, unknown>;
        }
        // If result itself is operation-shaped, return it
        if (looksLikeOperationShape(resultUnwrapped)) {
          return resultUnwrapped;
        }
      }
    }

    // Check if this object is operation-shaped
    if (looksLikeOperationShape(rec)) {
      return rec;
    }

    return null;
  };

  // Step 0: Eagerly resolve top-level string to object.
  // The live MCP relay delivers parsed content as a raw JSON string rather than
  // an already-parsed object. JSON.parse inside unwrap() uses untrimmed input
  // which can silently fail for strings with BOM or leading whitespace.
  // Resolve up to 5 string layers here using trimmed JSON.parse before unwrap.
  let rootParsed: unknown = args.parsed;
  for (let si = 0; si < 5 && typeof rootParsed === "string"; si++) {
    const trimmed = rootParsed.trim();
    if (!trimmed) break;
    console.warn(JSON.stringify({
      marker: "[EdgeClaw][describe-root-parse-attempt-v1]",
      si,
      beforeType: typeof rootParsed,
      rawLength: rootParsed.length,
      trimmedLength: trimmed.length,
      firstChars: Array.from(rootParsed.slice(0, 20)).map((ch) => (ch as string).charCodeAt(0)),
      startsWith: trimmed.slice(0, 20),
    }));
    try {
      rootParsed = JSON.parse(trimmed);
      console.warn(JSON.stringify({
        marker: "[EdgeClaw][describe-root-parse-success-v1]",
        si,
        afterType: typeof rootParsed,
        afterKeys:
          rootParsed !== null && typeof rootParsed === "object" && !Array.isArray(rootParsed)
            ? Object.keys(rootParsed as Record<string, unknown>).slice(0, 20)
            : [],
      }));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      const posMatch = errorMessage.match(/position (\d+)/);
      const pos = posMatch ? Number(posMatch[1]) : -1;
      console.warn(JSON.stringify({
        marker: "[EdgeClaw][describe-root-parse-failed-v1]",
        si,
        errorName: e instanceof Error ? e.name : typeof e,
        errorMessage,
        firstChars: Array.from(trimmed.slice(0, 20)).map((ch) => (ch as string).charCodeAt(0)),
        preview: trimmed.slice(0, 500),
      }));
      if (pos >= 0) {
        console.warn(JSON.stringify({
          marker: "[EdgeClaw][describe-root-parse-error-window-v1]",
          pos,
          before: trimmed.slice(Math.max(0, pos - 300), pos),
          at: trimmed.slice(pos, pos + 300),
          charCodesAt: Array.from(trimmed.slice(Math.max(0, pos - 20), pos + 20)).map(
            (ch) => (ch as string).charCodeAt(0)
          ),
        }));
      }
      // Full-string JSON.parse failed. Try to extract the "operation" object
      // using brace matching — the operation value itself is valid JSON even
      // when the surrounding wrapper string is not (e.g. $circular, truncation).
      const extracted = extractOperationObjectFromRawString(trimmed);
      if (extracted !== null) {
        rootParsed = { ok: true as const, operation: extracted };
        console.warn(JSON.stringify({
          marker: "[EdgeClaw][describe-root-parse-brace-extract-v1]",
          si,
          extractedType: typeof extracted,
          extractedKeys:
            extracted !== null && typeof extracted === "object" && !Array.isArray(extracted)
              ? Object.keys(extracted as Record<string, unknown>).slice(0, 20)
              : [],
        }));
      }
      break;
    }
  }

  // Candidate v4 diagnostic — logged unconditionally so it appears in tail
  // regardless of whether unwrap succeeds or fails.
  {
    const rpType = typeof rootParsed;
    const rpIsObj = rpType === "object" && rootParsed !== null && !Array.isArray(rootParsed);
    const rpKeys = rpIsObj ? Object.keys(rootParsed as Record<string, unknown>).slice(0, 20) : [];
    const rpRec = rpIsObj ? (rootParsed as Record<string, unknown>) : null;
    const rpOp = rpRec !== null ? rpRec.operation : undefined;
    const rpOpType = typeof rpOp;
    const rpOpIsObj = rpOp !== null && rpOp !== undefined && typeof rpOp === "object" && !Array.isArray(rpOp);
    const rpOpKeys = rpOpIsObj ? Object.keys(rpOp as Record<string, unknown>).slice(0, 20) : [];
    const rpOpRec = rpOpIsObj ? (rpOp as Record<string, unknown>) : null;
    const operationShapeCheck = {
      hasParameters: rpOpRec !== null && "parameters" in rpOpRec,
      hasRequestBody: rpOpRec !== null && "requestBody" in rpOpRec,
      hasResponses: rpOpRec !== null && "responses" in rpOpRec,
      hasSummary: rpOpRec !== null && "summary" in rpOpRec,
      hasDescription: rpOpRec !== null && "description" in rpOpRec,
      hasTags: rpOpRec !== null && "tags" in rpOpRec,
    };
    const rootShapeCheck = {
      hasParameters: rpRec !== null && "parameters" in rpRec,
      hasRequestBody: rpRec !== null && "requestBody" in rpRec,
      hasResponses: rpRec !== null && "responses" in rpRec,
      hasSummary: rpRec !== null && "summary" in rpRec,
      hasDescription: rpRec !== null && "description" in rpRec,
      hasTags: rpRec !== null && "tags" in rpRec,
    };
    // Rejection reason for operation field
    let opRejectionReason = "none";
    if (rpRec !== null && "operation" in rpRec) {
      if (rpOp === null || rpOp === undefined) opRejectionReason = "operation_is_null_or_undefined";
      else if (Array.isArray(rpOp)) opRejectionReason = "operation_is_array";
      else if (typeof rpOp !== "object") opRejectionReason = `operation_is_${typeof rpOp}`;
      else if (!Object.values(operationShapeCheck).some(Boolean)) opRejectionReason = "operation_has_no_shape_fields";
      else opRejectionReason = "operation_looks_valid";
    } else if (rpRec !== null) {
      opRejectionReason = "no_operation_key_on_root";
    } else {
      opRejectionReason = `root_not_object_type=${rpType}`;
    }
    console.warn(JSON.stringify({
      marker: "[EdgeClaw][describe-normalizer-candidate-v4]",
      rootParsedType: rpType,
      rootParsedKeys: rpKeys,
      rootShapeCheck,
      hasOperationKey: rpRec !== null && "operation" in rpRec,
      operationType: rpOpType,
      operationKeys: rpOpKeys,
      operationShapeCheck,
      opRejectionReason,
      coerceDescribeOnRootResult: coerceDescribeOperation(rootParsed) !== null ? "hit" : "null",
      looksLikeOpShapeOnRoot: rpRec !== null && looksLikeOperationShape(rpRec),
      looksLikeOpShapeOnOp: rpOpRec !== null && looksLikeOperationShape(rpOpRec),
    }));
  }

  // Try unwrapping first
  const unwrapped = unwrap(rootParsed);
  if (unwrapped) {
    return { ok: true, operation: unwrapped, shapeKeys: [...shapeKeys].sort() };
  }

  // Fallback: queue-based traversal for complex nested structures
  const queue: unknown[] = [rootParsed];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const raw = queue.shift();
    if (raw === undefined || raw === null) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    const parsed = tryParseJsonStringOnce(raw);
    if (parsed !== raw && !seen.has(parsed)) {
      queue.push(parsed);
      continue;
    }

    if (Array.isArray(parsed)) {
      let endpointMatched = false;
      for (const item of parsed) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          rememberKeys(rec);
          const methodMatches =
            typeof rec.method === "string" && rec.method.trim().toLowerCase() === methodLower;
          const pathMatches =
            typeof rec.path === "string" &&
            targetPathVariants.includes(normalizeOpenApiPathTemplate(rec.path));
          if (methodMatches && pathMatches) endpointMatched = true;
        }
        queue.push(item);
      }
      if (endpointMatched) {
        return { ok: true, operation: { parameters: [] }, shapeKeys: [...shapeKeys].sort() };
      }
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    rememberKeys(rec);

    if (typeof rec.error === "string" && rec.error.trim()) {
      firstError = rec.error.trim();
    }

    if (rec.ok === false && typeof rec.error !== "string") {
      firstError = "describe_failed";
    }

    const opFromEnvelope = coerceDescribeOperation(rec);
    if (opFromEnvelope) {
      return { ok: true, operation: opFromEnvelope, shapeKeys: [...shapeKeys].sort() };
    }

    if (rec.pathItem && typeof rec.pathItem === "object" && !Array.isArray(rec.pathItem)) {
      const op = pickOperationFromPathItem(rec.pathItem as Record<string, unknown>, methodLower);
      if (op) return { ok: true, operation: op, shapeKeys: [...shapeKeys].sort() };
    }

    if (rec.paths && typeof rec.paths === "object" && !Array.isArray(rec.paths)) {
      const paths = rec.paths as Record<string, unknown>;
      for (const variant of targetPathVariants) {
        const pathItemRaw = paths[variant];
        if (pathItemRaw && typeof pathItemRaw === "object" && !Array.isArray(pathItemRaw)) {
          const op = pickOperationFromPathItem(pathItemRaw as Record<string, unknown>, methodLower);
          if (op) return { ok: true, operation: op, shapeKeys: [...shapeKeys].sort() };
        }
      }
    }

    const maybeDirectOp = rec[methodLower];
    if (maybeDirectOp && typeof maybeDirectOp === "object" && !Array.isArray(maybeDirectOp)) {
      return { ok: true, operation: maybeDirectOp as Record<string, unknown>, shapeKeys: [...shapeKeys].sort() };
    }

    const wrapperKeys = ["result", "data", "payload", "response", "output", "value", "body", "content"];
    const hasKnownWrapper = wrapperKeys.some((key) => key in rec);
    if (
      rec.ok === true &&
      typeof rec.error !== "string" &&
      !hasKnownWrapper
    ) {
      return { ok: true, operation: { parameters: [] }, shapeKeys: [...shapeKeys].sort() };
    }

    for (const key of wrapperKeys) {
      if (key in rec) queue.push(rec[key]);
    }
    if (Array.isArray(rec.content)) {
      for (const part of rec.content) {
        if (part && typeof part === "object" && "text" in (part as Record<string, unknown>)) {
          queue.push((part as Record<string, unknown>).text);
        }
      }
    }
  }

  return { ok: false, errorText: firstError, shapeKeys: [...shapeKeys].sort() };
}

function isReadOnlyListFallbackEligible(req: CloudflareRequestInput): boolean {
  if (req.method !== "GET") return false;
  const pathTemplate = normalizeOpenApiPathTemplate((req.operationPathTemplate ?? req.path).trim());
  const nonHostSlots = pathnameTemplateParams(pathTemplate).filter((name) => !isHostInjectedPathOrAccountSlot(name));
  return nonHostSlots.length === 0;
}

function isHostInjectedPathOrAccountSlot(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "account_id" || n === "zone_id";
}

function getAtPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function getCollectionItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rec = payload as Record<string, unknown>;
  const keys = ["result", "results", "items", "data", "records", "entries", "objects"];
  for (const key of keys) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

function inferDefaultSelectFields(items: unknown[]): string[] {
  const first = items.find((it) => it && typeof it === "object" && !Array.isArray(it));
  if (!first) return ["id"];
  const keys = Object.keys(first as Record<string, unknown>);
  const underscoreIds = keys.filter((k) => /_id$/i.test(k));
  if (underscoreIds.length > 0) return [underscoreIds.sort()[0]!];
  if (keys.includes("id")) return ["id"];
  if (keys.includes("uuid")) return ["uuid"];
  const fallback = ["id", "name", "status", "type"].filter((k) => keys.includes(k));
  return fallback.length > 0 ? fallback : keys.slice(0, 4);
}

function normalizeItemForReduction(
  item: Record<string, unknown>,
  normalize: CloudflareRequestInput["reduction"] extends { normalize?: infer N } ? N : unknown
): Record<string, unknown> {
  if (!normalize || typeof normalize !== "object") return item;
  const trimStrings = Boolean((normalize as { trimStrings?: boolean }).trimStrings);
  const lowercaseFields = new Set(
    [
      ...(Array.isArray((normalize as { lowercaseFields?: unknown }).lowercaseFields)
        ? ((normalize as { lowercaseFields?: unknown[] }).lowercaseFields
            ?.filter((v): v is string => typeof v === "string")
            .map((v) => v.trim()) ?? [])
        : []),
      ...(Array.isArray((normalize as { caseInsensitiveFields?: unknown }).caseInsensitiveFields)
        ? ((normalize as { caseInsensitiveFields?: unknown[] }).caseInsensitiveFields
            ?.filter((v): v is string => typeof v === "string")
            .map((v) => v.trim()) ?? [])
        : []),
    ]
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    let next = trimStrings ? v.trim() : v;
    if (lowercaseFields.has(k)) next = next.toLowerCase();
    out[k] = next;
  }
  return out;
}

function reducePageItems(args: {
  items: unknown[];
  request: CloudflareRequestInput;
  matched: Array<Record<string, unknown>>;
  scannedCount: number;
  matchedCount: number;
  cap: number;
}): { matched: Array<Record<string, unknown>>; scannedCount: number; matchedCount: number } {
  const reduction = args.request.reduction;
  const explicitSelect = Array.isArray(reduction?.select)
    ? reduction.select.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const select = explicitSelect.length > 0 ? explicitSelect : inferDefaultSelectFields(args.items);
  const prefix = reduction?.filterByPrefix;
  const prefixValue = prefix?.value ?? prefix?.prefix;

  let scannedCount = args.scannedCount;
  let matchedCount = args.matchedCount;
  const matched = args.matched;

  for (const rawItem of args.items) {
    scannedCount += 1;
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const normalized = normalizeItemForReduction(rawItem as Record<string, unknown>, reduction?.normalize);

    if (prefix && typeof prefixValue === "string") {
      const rawField = normalized[prefix.field];
      if (typeof rawField !== "string") continue;
      const source = prefix.trim ? rawField.trim() : rawField;
      const lhs = prefix.caseInsensitive ? source.toLowerCase() : source;
      const rhs = prefix.caseInsensitive ? prefixValue.toLowerCase() : prefixValue;
      if (!lhs.startsWith(rhs)) continue;
    }

    const out: Record<string, unknown> = {};
    for (const key of select) {
      if (key in normalized) out[key] = normalized[key];
    }
    if (Object.keys(out).length === 0) continue;

    if (matched.length < args.cap) {
      matched.push(out);
    }
    matchedCount += 1;
  }

  return { matched, scannedCount, matchedCount };
}

function resolveNextCursorFromPayload(args: {
  payload: unknown;
  cursorPath?: string;
}): string | number | undefined {
  if (!args.payload || typeof args.payload !== "object" || Array.isArray(args.payload)) return undefined;
  if (args.cursorPath) {
    const v = getAtPath(args.payload, args.cursorPath);
    if (typeof v === "string" || typeof v === "number") return v;
  }
  const candidates = [
    "result_info.cursor",
    "result_info.next_cursor",
    "result_info.cursors.after",
    "result_info.next_page",
    "next_cursor",
    "nextCursor",
    "cursor",
    "next_page",
    "nextPage",
    "after",
  ];
  for (const path of candidates) {
    const v = getAtPath(args.payload, path);
    if (typeof v === "string" || typeof v === "number") return v;
  }
  return undefined;
}

/** Codemode relay helpers must return JSON-safe data before crossing Rpc/codemode (structuredClone). */
function sanitizeRelayHelperReturn(method: string, raw: unknown): Record<string, unknown> {
  const typeofResult = typeof raw;
  const constructorName =
    raw !== null && typeof raw === "object"
      ? ((raw as object).constructor?.name ?? "Object")
      : typeofResult;

  try {
    const out = toDelegatedMcpRpcWireValue(raw) as Record<string, unknown>;
    const withDebug =
      isCodemodeWireDebugEnabled() && out && typeof out === "object" && !Array.isArray(out)
        ? {
            ...out,
            ...getCodemodeRouterInvocationDebugSnapshot(),
          }
        : out;
    if (isCodemodeWireDebugEnabled() && typeof structuredClone === "function") {
      try {
        structuredClone(withDebug);
      } catch {
        logCodemodeWireDelegatedBoundary({
          boundaryLabel: "sanitizeRelayHelperReturn:structured_clone_failed_after_wire",
          helperMethod: method,
          rawConstructorName: constructorName,
          sanitizedConstructorName:
            withDebug !== null && typeof withDebug === "object"
              ? ((withDebug as object).constructor?.name ?? "Object")
              : typeof withDebug,
          jsonStringifyRoundTripOk: true,
          structuredCloneOk: false,
        });
      }
    }
    return withDebug;
  } catch (e) {
    const preview = codemodeWireRawErrorMessage(e).slice(0, 480);
    if (method === "openapi_search" || method === "openapi_describe_operation") {
      logCodemodeOpenapiRelayFailure({
        boundaryLabel: `sanitizeRelayHelperReturn:${method}`,
        helper: method,
        failureKind: "sanitize_toDelegated_wire_or_clone_probe_failed",
        errorPreviewRaw: preview,
      });
    } else if (isCodemodeWireDebugEnabled()) {
      logCodemodeWireDelegatedBoundary({
        boundaryLabel: "sanitizeRelayHelperReturn:catch",
        helperMethod: method,
        rawConstructorName: constructorName,
        jsonStringifyRoundTripOk: false,
        structuredCloneOk: false,
        errorBeforeNeutralize: preview,
        convertedByCodemodeWireSafeErrorMessage:
          e instanceof Error && codemodeWireIsInternalSerializationNoise(e.message ?? ""),
      });
    }
    try {
      const fallback = toDelegatedMcpRpcWireValue({
        ok: false,
        error: `[EdgeClaw][sanitizeRelayHelperReturn:${method}] kind=sanitize_toDelegated_wire: ${preview}`,
        boundary: `sanitizeRelayHelperReturn:${method}`,
        helper: method,
        failureKind: "sanitize_outer",
        errorPreviewRaw: preview.slice(0, 400),
      }) as Record<string, unknown>;
      if (isCodemodeWireDebugEnabled()) {
        return {
          ...fallback,
          ...getCodemodeRouterInvocationDebugSnapshot(),
        };
      }
      return fallback;
    } catch {
      const fallback = {
        ok: false,
        error: `[EdgeClaw][sanitizeRelayHelperReturn:${method}:fatal] sanitize_double_fault`,
        boundary: `sanitizeRelayHelperReturn:${method}`,
        helper: method,
        failureKind: "sanitize_fatal",
      };
      if (isCodemodeWireDebugEnabled()) {
        return {
          ...fallback,
          ...getCodemodeRouterInvocationDebugSnapshot(),
        };
      }
      return fallback;
    }
  }
}

export interface CodemodeRelayMetaToolSetArgs {
  relay: ToolSet;
  /** Runtime account id for mirrored MCP execute / gateway context (not the target API account). */
  cloudflareAccountId?: string;
}

/** Keys exposed as both host tools and `{namespace}.{_key}` Rpc methods on EdgeClawToolDispatcher. Keep in sync with {@link createCodemodeRelayMetaToolSet}. */
export const CODEMODE_RELAYER_ROUTING_TOOL_IDS = [
  "tools_find",
  "openapi_search",
  "openapi_describe_operation",
  "cloudflare_request",
  "resolve_device_identifier",
  "tools_call_code",
  "tools_list",
  "tools_describe",
  "tools_call",
] as const;

/** Host-callable Codemode router tools (same surface as inside the sandbox); use for integration tests without LOADER. */
export function createCodemodeRelayMetaToolSet(args: CodemodeRelayMetaToolSetArgs): ToolSet {
  const { relay } = args;
  const accountId = args.cloudflareAccountId?.trim();

  async function relayHttpRequest(
    req: CloudflareRequestInput
  ): Promise<Record<string, unknown>> {
    return sanitizeRelayHelperReturn(
      "relayHttpRequest",
      await (async (): Promise<Record<string, unknown>> => {
        const execName = pickWrappedToolName(relay, "execute");
        if (!execName) return { ok: false, error: "no_wrapped_execute_tool" };
        const t = relay[execName];
        if (!t) return { ok: false, error: "execute_tool_missing" };
        if (!accountId) {
          return { ok: false, error: "cloudflare_account_id_not_configured" };
        }

        const rawPathTemplateOrConcrete = req.operationPathTemplate ?? req.path;
        let plannerHit = resolveOpenApiPlannerCacheHit(req.method, rawPathTemplateOrConcrete.trim());
        let cachedOpMaybe = plannerHit?.operation;
        let usedReadOnlyDescribeFallback = false;
        if (!plannerHit || !cachedOpMaybe) {
          const diag = diagnoseMissingOpenApiDescribe(req.method, rawPathTemplateOrConcrete.trim());
          const endpointConfirmedBySearch = hasOpenApiSearchConfirmedEndpoint(
            req.method,
            rawPathTemplateOrConcrete.trim()
          );
          const allowReadOnlyFallback =
            isReadOnlyListFallbackEligible(req) && endpointConfirmedBySearch;

          if (!allowReadOnlyFallback && diag.reason === "called_but_failed") {
            return {
              ok: false,
              error: "openapi_describe_failed_same_invocation",
              semanticKey: "wrong_tool_api:describe_failed_same_invocation",
              nonRetryable: true,
              nonRetryableKind: "openapi_describe_failed_same_invocation",
              describeStatus: diag.reason,
              cacheKey: diag.cacheKey,
              ...(diag.delegatedMcpTool ? { delegatedMcpTool: diag.delegatedMcpTool } : {}),
              ...(diag.error ? { describeError: diag.error } : {}),
              hint:
                "openapi_describe_operation was called in this invocation but failed. Fix describe failure first, then call cloudflare_request.",
            };
          }
          if (!allowReadOnlyFallback) {
            return {
              ok: false,
              error: "missing_openapi_describe_same_invocation",
              semanticKey: "wrong_tool_api:missing_same_invocation_describe",
              nonRetryable: true,
              nonRetryableKind: "openapi_describe_required_same_invocation",
              describeStatus: diag.reason,
              cacheKey: diag.cacheKey,
              hint:
                diag.reason === "cache_key_mismatched"
                  ? "openapi_describe_operation succeeded in this invocation, but for a different cache key/path variant. Ensure method/path and operationPathTemplate align with the describe call."
                  : "Call openapi_describe_operation({ method, path }) earlier in the SAME codemode invocation before cloudflare_request. The describe cache is invocation-local and does not persist across codemode calls.",
            };
          }
          usedReadOnlyDescribeFallback = true;
          plannerHit = undefined;
          cachedOpMaybe = undefined;
        }
        const templateKey =
          plannerHit?.planningPathTemplate ??
          normalizeOpenApiPathTemplate(rawPathTemplateOrConcrete.trim());

        let workingPathRaw = req.path.trim();
        let workingQuery: Record<string, string | number | boolean | undefined> | undefined = req.query
          ? { ...req.query }
          : undefined;
        let workingBody: unknown = req.body;
        /** `strict`: validated plan drove path/query/body merge; `skipped`: cache missing or planner shape unusable */
        let executionPlannerMode: "strict" | "skipped" | undefined;

        if (cachedOpMaybe && typeof cachedOpMaybe === "object" && !Array.isArray(cachedOpMaybe)) {
          const planned =
            Object.keys(cachedOpMaybe).length > 0
              ? buildOpenApiExecutionPlan({
                  method: req.method,
                  path: templateKey,
                  intent: req.intent,
                  knownValues:
                    typeof req.knownValues === "object" && req.knownValues !== null
                      ? (req.knownValues as Record<string, unknown>)
                      : undefined,
                  proposedQuery: req.query,
                  proposedBody: req.body,
                  operation: cachedOpMaybe,
                })
              : null;

          if (planned && planned.ok === false) {
            return {
              ok: false,
              error: planned.error,
              details: planned.details,
            };
          }

          if (planned && planned.ok === true) {
            const vd = validateOpenApiExecutionPlan({ plan: planned, operation: cachedOpMaybe });
            if (vd.ok === false) {
              return {
                ok: false,
                error: "api_validation_error",
                details: {
                  operation: { method: req.method, path: templateKey },
                  issues: vd.issues,
                },
              };
            }

            workingPathRaw = planned.renderedPath;
            executionPlannerMode = "strict";

            workingQuery = {
              ...planned.query,
              ...(typeof req.query === "object" && req.query !== null ? req.query : {}),
            };

            const pb =
              planned.body !== undefined && typeof planned.body === "object" && !Array.isArray(planned.body)
                ? { ...(planned.body as Record<string, unknown>) }
                : {};

            workingBody =
              req.body !== undefined && typeof req.body === "object" && !Array.isArray(req.body)
                ? {
                    ...pb,
                    ...(req.body as Record<string, unknown>),
                  }
                : Object.keys(pb).length > 0
                  ? pb
                  : req.body;
          } else {
            executionPlannerMode = "skipped";
          }
        }

        const knownValues =
          typeof req.knownValues === "object" && req.knownValues !== null
            ? (req.knownValues as Record<string, unknown>)
            : undefined;
        const knownAccountId =
          typeof knownValues?.account_id === "string" && knownValues.account_id.trim().length > 0
            ? knownValues.account_id.trim()
            : undefined;
        const pathAccountMatch = req.path.match(/\/accounts\/([^/{}]+)(?:\/|$)/i);
        const pathAccountId =
          pathAccountMatch && pathAccountMatch[1] ? pathAccountMatch[1].trim() : undefined;
        const targetAccountId =
          typeof req.account_id === "string" && req.account_id.trim().length > 0
            ? req.account_id.trim()
            : knownAccountId ?? pathAccountId;
        const needsAccountTemplate = pathnameTemplateParams(workingPathRaw).includes("account_id");

        if (needsAccountTemplate && !targetAccountId) {
          return {
            ok: false,
            error: "missing_required_parameter",
            details: {
              operation: { method: req.method, path: workingPathRaw },
              missing: [{ location: "path", name: "account_id" }],
            },
          };
        }

        const pathForExec = targetAccountId
          ? injectAccountIntoApiPath(workingPathRaw, targetAccountId)
          : workingPathRaw;
        if (pathUsesLikelyHostnameAsDeviceSegment(pathForExec)) {
          return {
            ok: false,
            error:
              "invalid_path_identifier — use inventory / resolution helpers before placing hostnames or labels in path segments that require stable resource ids.",
          };
        }

        try {
          const reduction = req.reduction;
          if (reduction && req.method !== "GET") {
            return {
              ok: false,
              error: "mutation_not_allowed_with_reduction",
              nonRetryable: true,
              nonRetryableKind: "reduction_mode_requires_read_operation",
              semanticKey: "wrong_tool_api:mutation_not_allowed_with_reduction",
            };
          }

          const pagination = reduction?.pagination;
          const maxPages = pagination?.maxPages ?? 10;
          const pageEnabled = pagination?.enabled === true;
          const pageParam = pagination?.pageParam?.trim() || "page";
          const perPageParam = pagination?.perPageParam?.trim() || "per_page";
          const pageSize = pagination?.perPage ?? pagination?.pageSize;
          const cursorParam = pagination?.cursorParam?.trim() || "cursor";
          const cursorPath = pagination?.cursorPath?.trim();
          const compactCap = reduction?.compactResultCap ?? 50;

          let pageCount = 0;
          let scannedCount = 0;
          let matchedCount = 0;
          const matched: Array<Record<string, unknown>> = [];
          let lastPayload: unknown = undefined;
          let currentQuery =
            workingQuery && typeof workingQuery === "object" && !Array.isArray(workingQuery)
              ? { ...workingQuery }
              : undefined;
          if (pageSize && pageSize > 0) {
            currentQuery = { ...(currentQuery ?? {}), [perPageParam]: pageSize };
          }
          if (pageEnabled) {
            const q = currentQuery?.[pageParam];
            const cur = typeof q === "number" ? q : typeof q === "string" ? Number(q) : 1;
            currentQuery = { ...(currentQuery ?? {}), [pageParam]: Number.isFinite(cur) && cur > 0 ? cur : 1 };
          }

          while (pageCount < maxPages) {
            pageCount += 1;
            // When reduction is present, push select/filterByPrefix into the sandbox
            // so the response is already compact before crossing the MCP wire.
            const sandboxReduction = reduction
              ? {
                  select: Array.isArray(reduction.select)
                    ? reduction.select.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
                    : undefined,
                  filterByPrefix: reduction.filterByPrefix,
                  compactResultCap: compactCap,
                }
              : undefined;
            const pageInner = buildCloudflareRequestInnerCode({
              method: req.method,
              path: pathForExec,
              query: currentQuery && Object.keys(currentQuery).length > 0 ? currentQuery : undefined,
              body: workingBody !== undefined ? workingBody : undefined,
              reduction: sandboxReduction,
            });
            const execResult = await invokeToolExecuteWithToolLevelFeedbackRetry({
              t,
              baseInput: { code: pageInner },
              helperMethod: "relayHttpRequest",
              delegatedToolName: execName,
              sourceHelperName: "cloudflare_request",
              requestedAccountId: targetAccountId,
            });
            if (!execResult.ok) {
              return {
                ok: false,
                error: execResult.error,
                ...(execResult.semanticKey ? { semanticKey: execResult.semanticKey } : {}),
                ...(execResult.retrySuppressed ? { retrySuppressed: true } : {}),
              };
            }

            const parsedSafe = tryParseJsonWithSanitization(execResult.parsed);
            // The provider may double-encode its response. If the first parse still
            // yields a string, try one more JSON.parse layer before giving up.
            let parsedValue = parsedSafe.value;
            if (typeof parsedValue === "string") {
              try {
                const inner = JSON.parse(parsedValue);
                if (inner && typeof inner === "object") {
                  parsedValue = inner;
                }
              } catch {
                // genuinely unparseable — fall through to error
              }
            }
            if (typeof parsedValue === "string") {
              return {
                ok: false,
                error: "provider_response_parse_failed",
                nonRetryable: true,
                semanticKey: "provider_response_parse_failed",
                evidence: truncateCodemodeDebugJson(parsedValue),
              };
            }
            const unwrapped = unwrapCloudflareApiEnvelope(parsedValue);
            // If the sandbox already applied reduction (_reduced === true), use pre-reduced items directly.
            const sandboxPreReduced =
              parsedValue &&
              typeof parsedValue === "object" &&
              !Array.isArray(parsedValue) &&
              (parsedValue as Record<string, unknown>)._reduced === true;
            if (sandboxPreReduced) {
              const sr = parsedValue as {
                _apiError?: boolean;
                errors?: unknown;
                items?: unknown[];
                scannedCount?: number;
                matchedCount?: number;
                resultInfo?: Record<string, unknown>;
              };
              if (sr._apiError) {
                return {
                  ok: false,
                  error: "cloudflare_api_error",
                  details: sr.errors,
                };
              }
              const pageItems = Array.isArray(sr.items) ? sr.items : [];
              for (const it of pageItems) {
                if (it && typeof it === "object" && !Array.isArray(it) && matched.length < compactCap) {
                  matched.push(it as Record<string, unknown>);
                }
              }
              scannedCount += typeof sr.scannedCount === "number" ? sr.scannedCount : pageItems.length;
              matchedCount += typeof sr.matchedCount === "number" ? sr.matchedCount : pageItems.length;
              lastPayload = sr.resultInfo ?? pageItems;

              if (matched.length >= compactCap) break;

              // Use resultInfo for pagination decisions.
              if (pageEnabled && sr.resultInfo) {
                const totalPagesRaw = sr.resultInfo.total_pages;
                const totalPages =
                  typeof totalPagesRaw === "number"
                    ? totalPagesRaw
                    : typeof totalPagesRaw === "string"
                      ? Number(totalPagesRaw)
                      : undefined;
                const q = currentQuery?.[pageParam];
                const curPage =
                  typeof q === "number" ? q : typeof q === "string" ? Number(q) : pageCount;
                if (typeof totalPages === "number" && Number.isFinite(totalPages) && curPage >= totalPages) {
                  break;
                }
                const effectivePageSize =
                  typeof currentQuery?.[perPageParam] === "number"
                    ? (currentQuery?.[perPageParam] as number)
                    : typeof currentQuery?.[perPageParam] === "string"
                      ? Number(currentQuery?.[perPageParam])
                      : pageSize;
                if (
                  typeof effectivePageSize === "number" &&
                  Number.isFinite(effectivePageSize) &&
                  effectivePageSize > 0 &&
                  (sr.scannedCount ?? pageItems.length) < effectivePageSize
                ) {
                  break;
                }
                if (pageCount >= maxPages) break;
                const nextPage = Number.isFinite(curPage) ? curPage + 1 : pageCount + 1;
                currentQuery = { ...(currentQuery ?? {}), [pageParam]: nextPage };
                continue;
              }

              // No pagination or no result_info — single page, break.
              break;
            }
            if (!unwrapped.success) {
              return {
                ok: false,
                error: "cloudflare_api_error",
                details: unwrapped.errors,
                receivedPreview: truncateCodemodeDebugJson(parsedSafe.value),
              };
            }
            lastPayload = unwrapped.payload;
            const items = getCollectionItems(unwrapped.payload);

            const shouldReduce = Array.isArray(items) && items.length > 0;
            if (shouldReduce) {
              const reduced = reducePageItems({
                items,
                request: req,
                matched,
                scannedCount,
                matchedCount,
                cap: compactCap,
              });
              scannedCount = reduced.scannedCount;
              matchedCount = reduced.matchedCount;

              if (matched.length >= compactCap) break;

              if (pageEnabled) {
                const totalPagesRaw = getAtPath(unwrapped.payload, "result_info.total_pages");
                const totalPages =
                  typeof totalPagesRaw === "number"
                    ? totalPagesRaw
                    : typeof totalPagesRaw === "string"
                      ? Number(totalPagesRaw)
                      : undefined;
                const q = currentQuery?.[pageParam];
                const curPage =
                  typeof q === "number"
                    ? q
                    : typeof q === "string"
                      ? Number(q)
                      : pageCount;
                if (typeof totalPages === "number" && Number.isFinite(totalPages) && curPage >= totalPages) {
                  break;
                }
                const effectivePageSize =
                  typeof currentQuery?.[perPageParam] === "number"
                    ? (currentQuery?.[perPageParam] as number)
                    : typeof currentQuery?.[perPageParam] === "string"
                      ? Number(currentQuery?.[perPageParam])
                      : pageSize;
                if (
                  typeof effectivePageSize === "number" &&
                  Number.isFinite(effectivePageSize) &&
                  effectivePageSize > 0 &&
                  items.length < effectivePageSize
                ) {
                  break;
                }
                if (pageCount >= maxPages) break;
                const nextPage = Number.isFinite(curPage) ? curPage + 1 : pageCount + 1;
                currentQuery = { ...(currentQuery ?? {}), [pageParam]: nextPage };
                continue;
              }

              const nextCursor = resolveNextCursorFromPayload({
                payload: unwrapped.payload,
                cursorPath,
              });
              if (nextCursor !== undefined && nextCursor !== null && `${nextCursor}`.trim().length > 0) {
                currentQuery = { ...(currentQuery ?? {}), [cursorParam]: nextCursor };
                continue;
              }

              // Metadata may be unavailable; continue conservatively when page size suggests more pages.
              const effectivePageSize =
                typeof currentQuery?.[perPageParam] === "number"
                  ? (currentQuery?.[perPageParam] as number)
                  : typeof currentQuery?.[perPageParam] === "string"
                    ? Number(currentQuery?.[perPageParam])
                    : pageSize;
              const canInferMoreFromCount =
                typeof effectivePageSize === "number" && effectivePageSize > 0 && items.length >= effectivePageSize;
              if (canInferMoreFromCount && pageCount < maxPages) {
                const curPageRaw = currentQuery?.[pageParam];
                const curPage =
                  typeof curPageRaw === "number"
                    ? curPageRaw
                    : typeof curPageRaw === "string"
                      ? Number(curPageRaw)
                      : 1;
                currentQuery = {
                  ...(currentQuery ?? {}),
                  [pageParam]: Number.isFinite(curPage) ? curPage + 1 : 2,
                };
                continue;
              }

              break;
            }

            // Non-list payload: return once (read-by-id style call).
            break;
          }

          if (reduction) {
            return {
              ok: true,
              scannedCount,
              matchedCount,
              matched,
              // Alias: models often access `result` or `data` instead of `matched`.
              result: matched,
            };
          }

          const envelope: Record<string, unknown> = {
            ok: true,
            result: lastPayload,
          };

          if (executionPlannerMode === "skipped") {
            envelope.executionPlannerNote =
              "cached operation lacked parameters/requestBody usable by planner — relay used raw query/body as provided";
          }
          if (usedReadOnlyDescribeFallback) {
            envelope.executionPlannerNote =
              "describe_unavailable_readonly_fallback: openapi_search confirmed endpoint; proceeding with read-only GET list relay via execute mirror";
          }

          return envelope;
        } catch (e) {
          const msg = codemodeWireSafeErrorMessage(e, 0, "relayHttpRequest:invoke_execute_catch");
          const nonRetryable = classifyNonRetryableToolError(codemodeWireRawErrorMessage(e));
          if (nonRetryable) {
            console.warn(
              `[EdgeClaw][tool-agent-nonretryable] kind=${nonRetryable.kind} tool=${execName} reason=${nonRetryable.reason}`
            );
            return {
              ok: false,
              error: msg,
              nonRetryable: true,
              nonRetryableKind: nonRetryable.kind,
              nonRetryableReason: nonRetryable.reason,
            };
          }
          return { ok: false, error: msg };
        }
      })()
    );
  }

  const metaTools: ToolSet = {
    tools_find: tool({
      description:
        "Search wrapped tools by **description text** (and id substring). Opaque `tool_*` ids are not meaningful alone — use descriptions. Allowed args: `{ query }` only.",
      inputSchema: toolsFindSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "tools_find",
          await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(toolsFindSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            return { matches: toolsFindByDescription(p.value.query, relay) };
          })()
        );
      },
    }),

    tools_call_code: tool({
      description:
        "Invoke a wrapped Code Mode / MCP tool with `{ toolName, code }` only — **`code` must be a string** holding one async arrow source (validated on host). Never pass a JavaScript `Function` object (Codemode cannot serialize it). Prefer `openapi_search` / `cloudflare_request` over ad-hoc inner code. **Never reference `spec` — it is undefined in the execute tool environment.**",
      inputSchema: toolsCallCodeSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "tools_call_code",
          await (async (): Promise<Record<string, unknown>> => {
            if (
              inputUnknown &&
              typeof inputUnknown === "object" &&
              !Array.isArray(inputUnknown) &&
              typeof (inputUnknown as { code?: unknown }).code === "function"
            ) {
              return {
                ok: false,
                error: "tools_call_code_invalid_code_type",
                details:
                  "Pass `code` as an async arrow source string. Codemode cannot serialize Function values across the sandbox boundary.",
              };
            }
            const p = parseCodemodeRouterInput(toolsCallCodeSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            const { toolName, code } = p.value;
            // Guard: reject spec-inspection code sent to execute relay tools.
            // `spec` is only defined in the _search_ tool environment, not in `_execute` tools.
            const toolNameIsExecuteRelay =
              /^tool_[A-Za-z0-9]+_execute$/.test(toolName) || toolName.endsWith("_execute");
            if (toolNameIsExecuteRelay && codeAppearsToInspectSpec(code)) {
              const nonRetryableKind = "spec_not_defined_in_execute_tool";
              console.warn(
                `[EdgeClaw][tool-agent-nonretryable] kind=${nonRetryableKind} tool=${toolName} reason=spec_reference_in_execute_code_blocked_before_rpc`
              );
              return {
                ok: false,
                error:
                  "[EdgeClaw] spec is not defined in the execute tool environment. Use openapi_search and openapi_describe_operation for schema discovery instead of reading spec.paths directly.",
                nonRetryable: true,
                nonRetryableKind,
              };
            }
            const t = relay[toolName];
            if (!t) {
              return { ok: false, toolName, error: `Unknown wrapped tool "${toolName}"` };
            }
            const toolDescription = getToolEntryDescription(t);
            const toolSchema = getToolEntrySchema(t);
            try {
              const validated = assertValidAsyncArrowSource(code);
              const baseInput: Record<string, unknown> = { code: validated };

              const attemptToolLevelFeedbackRetry = async (
                errorMsg: string
              ): Promise<Record<string, unknown> | null> => {
                const feedback = parseMcpToolFeedback({
                  description: toolDescription || undefined,
                  errorMessage: errorMsg,
                  schema: toolSchema ?? undefined,
                });
                if (!feedback) return null;
                if (feedback.kind !== "missing_required_tool_input") return null;
                if (feedback.inputLevel !== "tool") return null;

                console.info(
                  `[EdgeClaw][tool-agent-feedback] kind=${feedback.kind} parameter=${feedback.parameter} ` +
                    `inputLevel=${feedback.inputLevel} candidates=${feedback.candidates.length} source=${feedback.source} ` +
                    `tool=${toolName} helper=tools_call_code`
                );

                let correctedInput = resolveMcpToolRetryInput(baseInput, feedback);

                // Deterministic native retry fallback: inject configured account id when account_id
                // is required at tool level and no unambiguous candidate was discovered.
                if (!correctedInput && feedback.parameter === "account_id" && accountId) {
                  correctedInput = { ...baseInput, account_id: accountId };
                }

                if (!correctedInput) {
                  return {
                    ok: false as const,
                    toolName,
                    error: errorMsg,
                    semanticKey:
                      classifySemanticKeyFromErrorText(errorMsg) ?? `missing_tool_input:${feedback.parameter}`,
                    retrySuppressed: true,
                    feedback: {
                      kind: feedback.kind,
                      parameter: feedback.parameter,
                      inputLevel: feedback.inputLevel,
                      candidates: feedback.candidates,
                      source: feedback.source,
                      guidance:
                        feedback.candidates.length > 1
                          ? `Retry native tool invocation with top-level input.${feedback.parameter} set to one candidate, or ask user to choose.`
                          : `Retry native tool invocation with top-level input.${feedback.parameter} provided.`,
                    },
                  };
                }

                try {
                  console.info(
                    `[tool-agent-feedback-retry] direct_native_retry ` +
                      `tool=${toolName} parameter=${feedback.parameter} ` +
                      `inputLevel=${feedback.inputLevel} source=tools_call_code`
                  );
                  const raw2 = await invokeToolExecute(t, correctedInput, {
                    helperMethod: "tools_call_code:feedback_retry_direct_native",
                    delegatedToolName: toolName,
                  });
                  const parsed2 = tryParseJsonFromMcpToolResult(raw2);
                  const retryError = extractErrorTextFromParsedResult(parsed2);
                  if (retryError) {
                    const staleKey = `missing_tool_input:${feedback.parameter}`;
                    const overrideKey = classifySemanticKeyFromErrorText(retryError);
                    if (overrideKey && overrideKey !== staleKey) {
                      console.info(
                        `[EdgeClaw][tool-agent-feedback] stale_semantic_override old=${staleKey} new=${overrideKey} ` +
                          `tool=${toolName} helper=tools_call_code`
                      );
                    }
                    return {
                      ok: false as const,
                      toolName,
                      error: retryError,
                      retriedWithFeedback: true,
                      semanticKey: overrideKey ?? staleKey,
                      retrySuppressed: true,
                    };
                  }
                  return {
                    ok: true as const,
                    toolName,
                    result: parsed2,
                    retriedWithFeedback: true,
                    retriedDirectNative: true,
                    semanticKey: `missing_tool_input:${feedback.parameter}`,
                  };
                } catch (e2) {
                  const retryMsg = codemodeWireSafeErrorMessage(
                    e2,
                    0,
                    "tools_call_code:feedback_retry_direct_native_catch"
                  );
                  return {
                    ok: false as const,
                    toolName,
                    error: retryMsg,
                    retriedWithFeedback: true,
                    semanticKey:
                      classifySemanticKeyFromErrorText(retryMsg) ?? `missing_tool_input:${feedback.parameter}`,
                    retrySuppressed: true,
                  };
                }
              };

              const raw = await invokeToolExecute(t, baseInput, {
                helperMethod: "tools_call_code",
                delegatedToolName: toolName,
              });
              const parsed = tryParseJsonFromMcpToolResult(raw);

              const isErrorLike =
                parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed) &&
                (typeof (parsed as Record<string, unknown>).error === "string" ||
                  (parsed as Record<string, unknown>).ok === false);

              if (isErrorLike) {
                const embeddedError =
                  typeof (parsed as Record<string, unknown>).error === "string"
                    ? ((parsed as Record<string, unknown>).error as string)
                    : JSON.stringify(parsed ?? "");
                const retryResult = await attemptToolLevelFeedbackRetry(embeddedError);
                if (retryResult) return retryResult;
                return { ok: false, toolName, error: embeddedError };
              }

              return {
                ok: true,
                toolName,
                result: parsed,
              };
            } catch (e) {
              const rawMsg = codemodeWireRawErrorMessage(e);
              const msg = codemodeWireSafeErrorMessage(e, 0, "tools_call_code:invoke_execute_catch");

              const retryResult = await (async (): Promise<Record<string, unknown> | null> => {
                const feedback = parseMcpToolFeedback({
                  description: toolDescription || undefined,
                  errorMessage: msg,
                  schema: toolSchema ?? undefined,
                });
                if (!feedback) return null;
                if (feedback.kind !== "missing_required_tool_input") return null;
                if (feedback.inputLevel !== "tool") return null;

                let correctedInput = resolveMcpToolRetryInput({ code }, feedback);
                if (!correctedInput && feedback.parameter === "account_id" && accountId) {
                  correctedInput = { code, account_id: accountId };
                }
                if (!correctedInput) {
                  return {
                    ok: false as const,
                    toolName,
                    error: msg,
                    semanticKey:
                      classifySemanticKeyFromErrorText(msg) ?? `missing_tool_input:${feedback.parameter}`,
                    retrySuppressed: true,
                  };
                }

                try {
                  console.info(
                    `[tool-agent-feedback-retry] direct_native_retry ` +
                      `tool=${toolName} parameter=${feedback.parameter} ` +
                      `inputLevel=${feedback.inputLevel} source=tools_call_code`
                  );
                  const raw2 = await invokeToolExecute(t, correctedInput, {
                    helperMethod: "tools_call_code:feedback_retry_direct_native",
                    delegatedToolName: toolName,
                  });
                  const parsed2 = tryParseJsonFromMcpToolResult(raw2);
                  const retryError = extractErrorTextFromParsedResult(parsed2);
                  if (retryError) {
                    const staleKey = `missing_tool_input:${feedback.parameter}`;
                    const overrideKey = classifySemanticKeyFromErrorText(retryError);
                    if (overrideKey && overrideKey !== staleKey) {
                      console.info(
                        `[EdgeClaw][tool-agent-feedback] stale_semantic_override old=${staleKey} new=${overrideKey} ` +
                          `tool=${toolName} helper=tools_call_code`
                      );
                    }
                    return {
                      ok: false as const,
                      toolName,
                      error: retryError,
                      retriedWithFeedback: true,
                      semanticKey: overrideKey ?? staleKey,
                      retrySuppressed: true,
                    };
                  }
                  return {
                    ok: true as const,
                    toolName,
                    result: parsed2,
                    retriedWithFeedback: true,
                    retriedDirectNative: true,
                    semanticKey: `missing_tool_input:${feedback.parameter}`,
                  };
                } catch (e2) {
                  return {
                    ok: false as const,
                    toolName,
                    error: codemodeWireSafeErrorMessage(
                      e2,
                      0,
                      "tools_call_code:feedback_retry_direct_native_catch"
                    ),
                    retriedWithFeedback: true,
                    semanticKey:
                      classifySemanticKeyFromErrorText(codemodeWireRawErrorMessage(e2)) ??
                      `missing_tool_input:${feedback.parameter}`,
                    retrySuppressed: true,
                  };
                }
              })();
              if (retryResult) return retryResult;

              const nonRetryable = classifyNonRetryableToolError(rawMsg);
              if (nonRetryable) {
                console.warn(
                  `[EdgeClaw][tool-agent-nonretryable] kind=${nonRetryable.kind} tool=${toolName} reason=${nonRetryable.reason}`
                );
                return {
                  ok: false,
                  toolName,
                  error: msg,
                  nonRetryable: true,
                  nonRetryableKind: nonRetryable.kind,
                  nonRetryableReason: nonRetryable.reason,
                };
              }
              return { ok: false, toolName, error: msg };
            }
          })()
        );
      },
    }),

    openapi_search: tool({
      description:
        "Host-side OpenAPI/MCP **search** helper (no outer `spec`). Allowed: `product?`, `tag?`, `pathIncludes?`, `summaryIncludes?`. Returns `{ ok, endpoints?, error? }`.",
      inputSchema: openapiSearchSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        const _innerOpenApiSearch = await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(openapiSearchSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            bumpOpenapiSearchInvocation();
            const filters = p.value;
            const searchName = pickWrappedToolName(relay, "search");
            if (!searchName) {
              return { ok: false, error: "no_wrapped_search_tool" };
            }
            const t = relay[searchName];
            if (!t) return { ok: false, error: "search_tool_missing" };
            const inner = buildOpenapiSearchInnerCode(filters);
            try {
              const raw = await invokeToolExecute(t, { code: inner }, {
                helperMethod: "openapi_search",
                delegatedToolName: searchName,
              });
              const parsed = tryParseJsonFromMcpToolResult(raw);
              recordOpenApiSearchEndpoints(parsed);
              let endpointsUnknown: unknown;
              try {
                endpointsUnknown = ensureJsonSafeForCodemodeRelay(parsed);
              } catch (wireEndpointsErr) {
                return edgeClawOpenapiRelayToolFailure({
                  helper: "openapi_search",
                  boundarySuffix: "openapi_search:endpoints_json_roundtrip",
                  delegatedMcpTool: searchName,
                  failureKind: "parsed_endpoints_wire_failed",
                  err: wireEndpointsErr,
                });
              }
              const successPayload = { ok: true as const, endpoints: endpointsUnknown };
              return ensureJsonSafeForCodemodeRelay(successPayload) as Record<string, unknown>;
            } catch (e) {
              const rawMessage = codemodeWireSafeErrorMessage(e, 0, "openapi_search:delegated_invoke");
              const hasExecuteMirror = Boolean(pickWrappedToolName(relay, "execute"));
              if (hasExecuteMirror && codemodeWireIsInternalSerializationNoise(rawMessage)) {
                return {
                  ok: false,
                  error: "Delegated tool returned a non-serializable value (internal).",
                };
              }
              return edgeClawOpenapiRelayToolFailure({
                helper: "openapi_search",
                boundarySuffix: "openapi_search:delegated_invoke",
                delegatedMcpTool: searchName,
                failureKind: inferOpenapiMirrorFailureKind(e),
                err: e,
              });
            }
        })();
        const _searchSnap = getCodemodeRouterInvocationDebugSnapshot();
        const _searchSanitized = sanitizeRelayHelperReturn("openapi_search", _innerOpenApiSearch);
        return {
          ..._searchSanitized,
          _chainEvidence: {
            tool: "openapi_search",
            called: true as const,
            invocationStorePresent: _searchSnap.invocationStorePresent,
            invocationStoreId: _searchSnap.invocationStoreId ?? null,
          },
        };
      },
    }),

    openapi_describe_operation: tool({
      description:
        "**Required** in the router flow after **openapi_search** and before **cloudflare_request** whenever the HTTP target has an OpenAPI operation. Loads `parameters` / `requestBody` from `spec.paths[path][method]` (exact template, e.g. `/pets/{petId}`). Allowed: `{ method, path }`. Caches schema for strict **cloudflare_request** planning in this invocation. This helper is schema/spec-only and must run through the MCP **search/spec mirror** (`tool_*_search`), never `tool_*_execute`.",
      inputSchema: openapiDescribeOperationSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        const _innerDescribeOp = await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(openapiDescribeOperationSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            bumpOpenapiSearchInvocation();
            const cacheKey = openapiDescribeCacheKey(p.value.method, p.value.path);

            const searchName = pickWrappedToolName(relay, "search");
            const executeName = pickWrappedToolName(relay, "execute");
            const looksLikeExecuteMirror = (name: string | undefined): boolean =>
              typeof name === "string" && /_execute$/i.test(name);
            if (!searchName || looksLikeExecuteMirror(searchName) || (executeName && searchName === executeName)) {
              const error = "openapi_describe_wrong_mirror_execute";
              markOpenApiDescribeFailed({
                method: p.value.method,
                operationPathTemplate: p.value.path,
                error,
              });
              console.warn(
                `[EdgeClaw][openapi-describe-failed] helper=openapi_describe_operation delegatedMcpTool=${searchName ?? "(unset)"} cacheKey=${cacheKey} error=${error}`
              );
              return {
                ok: false,
                error,
                semanticKey: "wrong_tool_api:describe_must_use_search_mirror",
                nonRetryable: true,
              };
            }
            const t = relay[searchName];
            if (!t) return { ok: false, error: "search_tool_missing" };

            const inner = buildOpenApiDescribeOperationInnerCode({
              method: p.value.method,
              path: p.value.path,
            });
            try {
              const execResult = await invokeToolExecuteWithToolLevelFeedbackRetry({
                t,
                baseInput: { code: inner },
                helperMethod: "openapi_describe_operation",
                delegatedToolName: searchName,
                sourceHelperName: "openapi_describe_operation",
                configuredAccountId: accountId,
              });
              if (!execResult.ok) {
                const wrongMirror = /spec is not defined/i.test(execResult.error);
                const error = wrongMirror
                  ? "openapi_describe_wrong_mirror_execute"
                  : execResult.error;
                markOpenApiDescribeFailed({
                  method: p.value.method,
                  operationPathTemplate: p.value.path,
                  error,
                  delegatedMcpTool: searchName,
                });
                console.warn(
                  `[EdgeClaw][openapi-describe-failed] helper=openapi_describe_operation delegatedMcpTool=${searchName} cacheKey=${cacheKey} error=${error.slice(0, 500)}`
                );
                return ensureJsonSafeForCodemodeRelay({
                  ...(wrongMirror
                    ? {
                        ok: false,
                        error,
                        semanticKey: "wrong_tool_api:describe_must_use_search_mirror",
                        nonRetryable: true,
                      }
                    : {
                        ok: false,
                        error: execResult.error,
                        ...(execResult.semanticKey ? { semanticKey: execResult.semanticKey } : {}),
                        ...(execResult.retrySuppressed ? { retrySuppressed: true } : {}),
                      }),
                }) as Record<string, unknown>;
              }
              const parsed = execResult.parsed;
              {
                let parsedPreviewStr: string;
                try {
                  parsedPreviewStr = typeof parsed === "string"
                    ? parsed
                    : JSON.stringify(parsed) ?? "";
                } catch {
                  parsedPreviewStr = String(parsed ?? "");
                }
                console.warn(JSON.stringify({
                  marker: "[EdgeClaw][describe-normalizer-input-v1]",
                  cacheKey,
                  method: p.value.method,
                  path: p.value.path,
                  parsedType: typeof parsed,
                  parsedKeys:
                    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                      ? Object.keys(parsed as Record<string, unknown>).slice(0, 30)
                      : [],
                  parsedPreview: redactSecretsForDiagnostic(parsedPreviewStr.slice(0, 12000)),
                }));
              }
              const normalized = normalizeDescribePayload({
                parsed,
                method: p.value.method,
                path: p.value.path,
              });
              if (!normalized.ok)
                return ensureJsonSafeForCodemodeRelay((() => {
                  const error =
                    "[EdgeClaw][openapi_describe_operation:inner_parse] kind=describe_parse_failed shape_missing_object";
                  const normDiag = buildDescribeNormalizerFailureDiagnostic({
                    cacheKey,
                    method: p.value.method,
                    path: p.value.path,
                    parsed,
                    normalized,
                  });
                  markOpenApiDescribeFailed({
                    method: p.value.method,
                    operationPathTemplate: p.value.path,
                    error,
                    delegatedMcpTool: searchName,
                  });
                  console.warn(
                    `[EdgeClaw][openapi-describe-failed] helper=openapi_describe_operation delegatedMcpTool=${searchName} cacheKey=${cacheKey} error=${error}`
                  );
                  console.warn(JSON.stringify(normDiag));
                  return {
                    ok: false,
                    error,
                    shapeKeys: normalized.shapeKeys,
                    normalizedFailure: normalized.errorText,
                    boundary: "openapi_describe_operation:inner_parse",
                    helper: "openapi_describe_operation",
                    failureKind: "describe_parse_failed",
                    delegatedMcpTool: searchName,
                    receivedPreview: truncateCodemodeDebugJson(parsed),
                    normalizerDiagnostic: normDiag,
                  };
                })()) as Record<string, unknown>;

              // normalized.ok is true here, so success - cache the operation and return
              const op = normalized.operation;
              console.warn(JSON.stringify({
                marker: "[EdgeClaw][describe-normalizer-return-v1]",
                cacheKey,
                method: p.value.method,
                path: p.value.path,
                opKeys: Object.keys(op).slice(0, 20),
                paramCount: Array.isArray(op.parameters) ? op.parameters.length : 0,
              }));
              setCapturedOpenApiOperation(p.value.method, p.value.path, op);
              markOpenApiDescribeSucceeded({
                method: p.value.method,
                operationPathTemplate: p.value.path,
                delegatedMcpTool: searchName,
              });

              const paramCount = Array.isArray(op.parameters) ? op.parameters.length : 0;
              const rb =
                typeof op.requestBody === "object" &&
                op.requestBody !== null &&
                typeof (op.requestBody as Record<string, unknown>).content === "object"
                  ? 1
                  : 0;

              const successPayload = {
                ok: true as const,
                path: normalizeOpenApiPathTemplate(p.value.path),
                method: String(p.value.method).toUpperCase(),
                openapiParameterSlots: paramCount,
                openapiRequestBodies: rb,
              };
              return ensureJsonSafeForCodemodeRelay(successPayload) as Record<string, unknown>;
            } catch (e) {
              const error = codemodeWireSafeErrorMessage(
                e,
                0,
                "openapi_describe_operation:delegated_invoke"
              );
              markOpenApiDescribeFailed({
                method: p.value.method,
                operationPathTemplate: p.value.path,
                error,
                delegatedMcpTool: searchName,
              });
              console.warn(
                `[EdgeClaw][openapi-describe-failed] helper=openapi_describe_operation delegatedMcpTool=${searchName} cacheKey=${cacheKey} error=${error.slice(0, 500)}`
              );
              return edgeClawOpenapiRelayToolFailure({
                helper: "openapi_describe_operation",
                boundarySuffix: "openapi_describe_operation:delegated_invoke",
                delegatedMcpTool: searchName,
                failureKind: inferOpenapiMirrorFailureKind(e),
                err: e,
              });
            }
        })();
        const _describeSnap = getCodemodeRouterInvocationDebugSnapshot();
        const _describeStore = tryGetCodemodeRouterInvocationStore();
        let _describeStatus = "not_attempted";
        if (_describeStore && _describeSnap.describeStateKeys.length > 0) {
          const _describeStates = _describeSnap.describeStateKeys.map(
            (k) => _describeStore.openapiDescribeStateByKey[k]
          );
          if (_describeStates.some((s) => s?.succeeded)) _describeStatus = "succeeded";
          else if (_describeStates.some((s) => s?.attempted && !s.succeeded))
            _describeStatus = "failed";
        }
        const _describeSanitized = sanitizeRelayHelperReturn("openapi_describe_operation", _innerDescribeOp);
        return {
          ..._describeSanitized,
          _chainEvidence: {
            tool: "openapi_describe_operation",
            called: true as const,
            invocationStorePresent: _describeSnap.invocationStorePresent,
            invocationStoreId: _describeSnap.invocationStoreId ?? null,
            describeStatus: _describeStatus,
            describeStateKeys: _describeSnap.describeStateKeys,
          },
        };
      },
    }),

    cloudflare_request: tool({
      description:
        "HTTP relay via MCP execute. **Planner-required:** for any HTTP/API call with OpenAPI coverage, call **openapi_describe_operation({ method, path })** earlier in the SAME codemode invocation; invocation-local cache is mandatory. Then pass **operationPathTemplate**, **knownValues**, and allowed **query/body** fields. Provide target account via `account_id` or `knownValues.account_id` (runtime `CLOUDFLARE_ACCOUNT_ID` is gateway context only). For list/search workloads, use `reduction` (`select`, `filterByPrefix`, `normalize`, `pagination`, `compactResultCap`) so the relay returns compact structured output (`scannedCount`, `matchedCount`, `matched`) and never raw list payloads.",
      inputSchema: cloudflareRequestSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        const _cfParsed = parseCodemodeRouterInput(cloudflareRequestSchema, inputUnknown ?? {});
        const _innerCfRequest = await (async (): Promise<Record<string, unknown>> => {
            const p = _cfParsed;
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            if (!schemaLookupGateSatisfied()) {
              return {
                ok: false,
                error: "missing_schema_lookup",
                hint: "Use openapi_search({...}) or tools_describe({ toolName }) before HTTP relay helpers in the same invocation.",
              };
            }
            let out = await relayHttpRequest(p.value);
            if (!out.ok) {
              // Non-retryable errors must not trigger the coerce-and-retry path.
              if (out.nonRetryable) {
                return out;
              }
              const rawGate = (p.value.operationPathTemplate ?? p.value.path).trim();
              const cachedPlannerGate = getCapturedOpenApiOperation(p.value.method, rawGate);
              const hasStrictPlannerCache =
                cachedPlannerGate !== undefined &&
                typeof cachedPlannerGate === "object" &&
                !Array.isArray(cachedPlannerGate) &&
                Object.keys(cachedPlannerGate).length > 0;
              if (!hasStrictPlannerCache) {
                const alt = maybeCoerceHttpRelayArgsOnce(p.value);
                if (alt) out = await relayHttpRequest(alt);
              }
            }
            return out;
        })();
        const _cfSnap = getCodemodeRouterInvocationDebugSnapshot();
        const _cfStore = tryGetCodemodeRouterInvocationStore();
        let _cfDescribeStatus = "not_attempted";
        if (_cfStore && _cfSnap.describeStateKeys.length > 0) {
          const _cfStates = _cfSnap.describeStateKeys.map(
            (k) => _cfStore.openapiDescribeStateByKey[k]
          );
          if (_cfStates.some((s) => s?.succeeded)) _cfDescribeStatus = "succeeded";
          else if (_cfStates.some((s) => s?.attempted && !s.succeeded))
            _cfDescribeStatus = "failed";
        }
        const _cfSanitized = sanitizeRelayHelperReturn("cloudflare_request", _innerCfRequest);
        const _cfErrorCode =
          typeof _cfSanitized.error === "string" ? _cfSanitized.error : undefined;
        return {
          ..._cfSanitized,
          _chainEvidence: {
            tool: "cloudflare_request",
            called: true as const,
            invocationStorePresent: _cfSnap.invocationStorePresent,
            invocationStoreId: _cfSnap.invocationStoreId ?? null,
            describeStatus: _cfDescribeStatus,
            describeStateKeys: _cfSnap.describeStateKeys,
            method: _cfParsed.ok ? _cfParsed.value.method : undefined,
            path: _cfParsed.ok ? _cfParsed.value.path : undefined,
            operationPathTemplate: _cfParsed.ok
              ? (_cfParsed.value.operationPathTemplate ?? _cfParsed.value.path)
              : undefined,
            ...(_cfErrorCode !== undefined ? { errorCode: _cfErrorCode } : {}),
          },
        };
      },
    }),

    resolve_device_identifier: tool({
      description:
        "Resolve a hostname / serial / label to **resource UUID candidates** via configurable list endpoints. Allowed: `{ hostnameOrSerial }` only. Prefer stable ids from `candidates[].deviceId` in subsequent paths.",
      inputSchema: resolveDeviceIdentifierSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        const p = parseCodemodeRouterInput(resolveDeviceIdentifierSchema, inputUnknown ?? {});
        if (!p.ok) return unknownHelperArgument(p.invalidKeys);
        const { hostnameOrSerial } = p.value;
        if (!accountId) {
          return { ok: false, error: "cloudflare_account_id_not_configured" };
        }
        const execName = pickWrappedToolName(relay, "execute");
        if (!execName) return { ok: false, error: "no_wrapped_execute_tool" };
        const t = relay[execName];
        if (!t) return { ok: false, error: "execute_tool_missing" };

        const tried: string[] = [];
        const failures: string[] = [];

        for (const template of DEFAULT_DEVICE_LIST_PATH_TEMPLATES) {
          const path = injectAccountIntoApiPath(template, accountId);
          if (pathUsesHostnameAsDeviceIdSegment(path, hostnameOrSerial)) {
            return {
              ok: false,
              error: "refused_path_hostname_as_segment",
              path,
              hint: "Inventory paths must list devices — never embed the hostname as a path segment UUID.",
            };
          }
          const inner = buildCloudflareRequestInnerCode({
            method: "GET",
            path,
            query: { per_page: 100 },
          });
          tried.push(path);
          try {
            const execResult = await invokeToolExecuteWithToolLevelFeedbackRetry({
              t,
              baseInput: { code: inner },
              helperMethod: "resolve_device_identifier",
              delegatedToolName: execName,
              sourceHelperName: "resolve_device_identifier",
              configuredAccountId: accountId,
            });
            if (!execResult.ok) {
              failures.push(`${path}: ${execResult.error}`);
              continue;
            }
            const parsed = execResult.parsed;
            const unwrapped = unwrapCloudflareApiEnvelope(parsed);
            if (!unwrapped.success) {
              failures.push(`${path}: ${truncateCodemodeDebugJson(unwrapped.errors, 800)}`);
              continue;
            }
            const rows = pickDeviceRowsFromCloudflarePayload(unwrapped.payload);
            const candidates = matchDeviceNeedle(rows, hostnameOrSerial);
            if (candidates.length > 0) {
              return {
                ok: true,
                needle: hostnameOrSerial,
                matchedFromPath: path,
                candidates,
              };
            }
            failures.push(`${path}: no_row_match_or_empty_list`);
          } catch (e) {
            const msg = codemodeWireSafeErrorMessage(e, 0, "resolve_device_identifier:invoke_execute_catch");
            failures.push(`${path}: ${msg}`);
          }
        }

        return {
          ok: true,
          needle: hostnameOrSerial,
          candidates: [],
          triedPaths: tried,
          note: "no_device_match_after_inventory_scan",
          failures,
        };
      },
    }),

    tools_list: tool({
      description:
        "Return sorted string[] of wrapped tool ids. Allowed args: `{}` only — no extra keys. Prefer tools_find for discovery.",
      inputSchema: toolsListSchema,
      execute: async (inputUnknown?: unknown): Promise<string[]> => {
        const p = parseCodemodeRouterInput(toolsListSchema, inputUnknown ?? {});
        if (!p.ok)
          throw new Error(`unknown_helper_argument: invalidKeys=${p.invalidKeys.join(",")}`);
        return Object.keys(relay).sort();
      },
    }),

    tools_describe: tool({
      description:
        "Describe one wrapped MCP tool `{ name, description, schema snapshot }`. Allowed: `{ toolName }`. Counts toward schema-discovery gate.",
      inputSchema: toolsDescribeSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "tools_describe",
          await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(toolsDescribeSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            const { toolName } = p.value;
            const t = relay[toolName];
            if (!t) {
              return { ok: false, error: "unknown_wrapped_tool", toolName };
            }
            markToolsDescribeSucceeded();
            return stringifyToolBrief(toolName, t);
          })()
        );
      },
    }),

    tools_call: tool({
      description:
        "Low-level invoke with JSON `{ toolName, input }` only — match tools_describe. " +
        "Legacy alias: `arguments` is treated like `input` when `input` is omitted. " +
        "Prefer openapi_search → openapi_describe_operation → cloudflare_request when possible.",
      inputSchema: toolsCallSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "tools_call",
          await (async (): Promise<Record<string, unknown>> => {
            const normalized = normalizeToolsCallIncoming(inputUnknown);
            const p = parseCodemodeRouterInput(toolsCallSchema, normalized ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            const { toolName, input } = p.value;
            const t = relay[toolName];
            if (!t) {
              return { ok: false, toolName, error: `Unknown wrapped tool "${toolName}"` };
            }

            const toolDescription = getToolEntryDescription(t);
            const toolSchema = getToolEntrySchema(t);

            // Helper: attempt one bounded retry when structured feedback resolves to an
            // unambiguous corrected input. Returns the retry result or null when not applicable.
            const attemptFeedbackRetry = async (
              errorMsg: string
            ): Promise<Record<string, unknown> | null> => {
              const feedback = parseMcpToolFeedback({
                description: toolDescription || undefined,
                errorMessage: errorMsg,
                schema: toolSchema ?? undefined,
              });
              if (!feedback) return null;

              console.info(
                `[EdgeClaw][tool-agent-feedback] kind=${feedback.kind} parameter=${feedback.parameter} ` +
                  `inputLevel=${feedback.inputLevel ?? "unknown"} candidates=${feedback.candidates.length} ` +
                  `source=${feedback.source} tool=${toolName}`
              );

              const correctedInput = resolveMcpToolRetryInput(input, feedback);
              const correctedWithFallback =
                !correctedInput && feedback.parameter === "account_id" && accountId
                  ? { ...input, account_id: accountId }
                  : correctedInput;
              if (!correctedWithFallback) {
                // Multiple candidates and no unambiguous resolution — surface feedback to LLM.
                return {
                  ok: false as const,
                  toolName,
                  error: errorMsg,
                  semanticKey:
                    classifySemanticKeyFromErrorText(errorMsg) ?? `missing_tool_input:${feedback.parameter}`,
                  feedback: {
                    kind: feedback.kind,
                    parameter: feedback.parameter,
                    inputLevel: feedback.inputLevel ?? "tool",
                    candidates: feedback.candidates,
                    source: feedback.source,
                    guidance:
                      feedback.candidates.length > 1
                        ? `Retry native tool invocation with top-level input.${feedback.parameter} set to one candidate, or ask user to choose.`
                        : `Retry native tool invocation with top-level input.${feedback.parameter} provided.`,
                  },
                };
              }

              // One bounded retry with the corrected input.
              try {
                console.info(
                  `[tool-agent-feedback-retry] direct_native_retry tool=${toolName} ` +
                    `parameter=${feedback.parameter} inputLevel=${feedback.inputLevel ?? "tool"} source=tools_call`
                );
                const raw2 = await invokeToolExecute(t, correctedWithFallback, {
                  helperMethod: "tools_call:feedback_retry",
                  delegatedToolName: toolName,
                });
                const parsed2 = tryParseJsonFromMcpToolResult(raw2);
                const retryError = extractErrorTextFromParsedResult(parsed2);
                if (retryError) {
                  const staleKey = `missing_tool_input:${feedback.parameter}`;
                  const overrideKey = classifySemanticKeyFromErrorText(retryError);
                  if (overrideKey && overrideKey !== staleKey) {
                    console.info(
                      `[EdgeClaw][tool-agent-feedback] stale_semantic_override old=${staleKey} new=${overrideKey} ` +
                        `tool=${toolName} helper=tools_call`
                    );
                  }
                  return {
                    ok: false as const,
                    toolName,
                    error: retryError,
                    retriedWithFeedback: true,
                    semanticKey: overrideKey ?? staleKey,
                    retrySuppressed: true,
                  };
                }
                return {
                  ok: true as const,
                  toolName,
                  result: parsed2,
                  retriedWithFeedback: true,
                  semanticKey: `missing_tool_input:${feedback.parameter}`,
                  retriedDirectNative: true,
                };
              } catch (e2) {
                const retryMsg = codemodeWireSafeErrorMessage(
                  e2,
                  0,
                  "tools_call:feedback_retry_catch"
                );
                return {
                  ok: false as const,
                  toolName,
                  error: retryMsg,
                  retriedWithFeedback: true,
                  semanticKey:
                    classifySemanticKeyFromErrorText(retryMsg) ?? `missing_tool_input:${feedback.parameter}`,
                  retrySuppressed: true,
                };
              }
            };

            try {
              const raw = await invokeToolExecute(t, input, {
                helperMethod: "tools_call",
                delegatedToolName: toolName,
              });
              const parsed = tryParseJsonFromMcpToolResult(raw);

              // Check whether the successful-looking result contains embedded error guidance.
              const resultStr =
                typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "");
              const isErrorLike =
                parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed) &&
                (typeof (parsed as Record<string, unknown>).error === "string" ||
                  (parsed as Record<string, unknown>).ok === false);

              if (isErrorLike) {
                const embeddedError =
                  typeof (parsed as Record<string, unknown>).error === "string"
                    ? ((parsed as Record<string, unknown>).error as string)
                    : resultStr;
                const retryResult = await attemptFeedbackRetry(embeddedError);
                if (retryResult) return retryResult;
              }

              return { ok: true, toolName, result: parsed };
            } catch (e) {
              const msg = codemodeWireSafeErrorMessage(e, 0, "tools_call:invoke_execute_catch");

              const retryResult = await attemptFeedbackRetry(msg);
              if (retryResult) return retryResult;

              return { ok: false, toolName, error: msg };
            }
          })()
        );
      },
    }),
  };

  for (const key of CODEMODE_RELAYER_ROUTING_TOOL_IDS) {
    if (!(key in metaTools)) {
      throw new Error(
        `[Codemode relay] CODEMODE_RELAYER_ROUTING_TOOL_IDS out of sync: missing meta tool "${key}"`
      );
    }
  }

  return metaTools;
}
