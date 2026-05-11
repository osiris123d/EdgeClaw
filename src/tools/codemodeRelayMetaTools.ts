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
  validateOpenApiExecutionPlan,
} from "./codemodeOpenApiExecutionPlan";
import {
  bumpOpenapiSearchInvocation,
  getCapturedOpenApiOperation,
  markToolsDescribeSucceeded,
  resolveOpenApiPlannerCacheHit,
  schemaLookupGateSatisfied,
  setCapturedOpenApiOperation,
} from "./codemodeRouterInvocation";

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
  path: z.string().min(1).describe("Resolved or templated path; `{account_id}` replaced server-side."),
  /** OpenAPI `paths` key when it differs from the literal `path` sent to MCP execute. */
  operationPathTemplate: z.string().min(1).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])).optional(),
  body: z.unknown().optional(),
  intent: z.string().optional(),
  /** Prior resolved router partials (`resource identifiers`, inventories, …) — fills required slots before user literals. */
  knownValues: z.record(z.string(), z.unknown()).optional(),
});

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
  req: z.infer<typeof cloudflareRequestSchema>
): z.infer<typeof cloudflareRequestSchema> | null {
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

/** Codemode relay helpers must return JSON-safe data before crossing Rpc/codemode (structuredClone). */
function sanitizeRelayHelperReturn(method: string, raw: unknown): Record<string, unknown> {
  const typeofResult = typeof raw;
  const constructorName =
    raw !== null && typeof raw === "object"
      ? ((raw as object).constructor?.name ?? "Object")
      : typeofResult;

  try {
    const out = toDelegatedMcpRpcWireValue(raw) as Record<string, unknown>;
    if (isCodemodeWireDebugEnabled() && typeof structuredClone === "function") {
      try {
        structuredClone(out);
      } catch {
        logCodemodeWireDelegatedBoundary({
          boundaryLabel: "sanitizeRelayHelperReturn:structured_clone_failed_after_wire",
          helperMethod: method,
          rawConstructorName: constructorName,
          sanitizedConstructorName:
            out !== null && typeof out === "object"
              ? ((out as object).constructor?.name ?? "Object")
              : typeof out,
          jsonStringifyRoundTripOk: true,
          structuredCloneOk: false,
        });
      }
    }
    return out;
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
      return toDelegatedMcpRpcWireValue({
        ok: false,
        error: `[EdgeClaw][sanitizeRelayHelperReturn:${method}] kind=sanitize_toDelegated_wire: ${preview}`,
        boundary: `sanitizeRelayHelperReturn:${method}`,
        helper: method,
        failureKind: "sanitize_outer",
        errorPreviewRaw: preview.slice(0, 400),
      }) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: `[EdgeClaw][sanitizeRelayHelperReturn:${method}:fatal] sanitize_double_fault`,
        boundary: `sanitizeRelayHelperReturn:${method}`,
        helper: method,
        failureKind: "sanitize_fatal",
      };
    }
  }
}

export interface CodemodeRelayMetaToolSetArgs {
  relay: ToolSet;
  /** Injected into paths — models should call cloudflare_request instead of embedding ids. */
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
    req: z.infer<typeof cloudflareRequestSchema>
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
        const plannerHit = resolveOpenApiPlannerCacheHit(req.method, rawPathTemplateOrConcrete.trim());
        const cachedOpMaybe = plannerHit?.operation;
        const templateKey =
          plannerHit?.planningPathTemplate ??
          normalizeOpenApiPathTemplate(rawPathTemplateOrConcrete.trim());
        const hadOpenApiPlannerCache = cachedOpMaybe !== undefined;

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

        const pathForExec = injectAccountIntoApiPath(workingPathRaw, accountId);
        if (pathUsesLikelyHostnameAsDeviceSegment(pathForExec)) {
          return {
            ok: false,
            error:
              "invalid_path_identifier — use inventory / resolution helpers before placing hostnames or labels in path segments that require stable resource ids.",
          };
        }

        const inner = buildCloudflareRequestInnerCode({
          method: req.method,
          path: pathForExec,
          query: workingQuery && Object.keys(workingQuery).length > 0 ? workingQuery : undefined,
          body: workingBody !== undefined ? workingBody : undefined,
        });

        try {
          const raw = await invokeToolExecute(t, { code: inner }, { helperMethod: "relayHttpRequest", delegatedToolName: execName });
          const parsed = tryParseJsonFromMcpToolResult(raw);
          const unwrapped = unwrapCloudflareApiEnvelope(parsed);
          if (!unwrapped.success) {
            return {
              ok: false,
              error: "cloudflare_api_error",
              details: unwrapped.errors,
              receivedPreview: truncateCodemodeDebugJson(parsed),
            };
          }
          const envelope: Record<string, unknown> = {
            ok: true,
            result: unwrapped.payload,
          };

          if (executionPlannerMode === "strict") {
            /* quiet success — schema-driven planner already validated */
          } else if (!hadOpenApiPlannerCache) {
            envelope.executionPlannerNote =
              "no cached OpenAPI operation for this template — call openapi_describe_operation({ method, path }) for schema-aware routing";
          } else if (executionPlannerMode === "skipped") {
            envelope.executionPlannerNote =
              "cached operation lacked parameters/requestBody usable by planner — relay used raw query/body as provided";
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
        const p = parseCodemodeRouterInput(toolsFindSchema, inputUnknown ?? {});
        if (!p.ok) return unknownHelperArgument(p.invalidKeys);
        return { matches: toolsFindByDescription(p.value.query, relay) };
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
            try {
              const validated = assertValidAsyncArrowSource(code);
              const raw = await invokeToolExecute(t, { code: validated }, { helperMethod: "tools_call_code", delegatedToolName: toolName });
              return {
                ok: true,
                toolName,
                result: tryParseJsonFromMcpToolResult(raw),
              };
            } catch (e) {
              const rawMsg = codemodeWireRawErrorMessage(e);
              const nonRetryable = classifyNonRetryableToolError(rawMsg);
              if (nonRetryable) {
                console.warn(
                  `[EdgeClaw][tool-agent-nonretryable] kind=${nonRetryable.kind} tool=${toolName} reason=${nonRetryable.reason}`
                );
                return {
                  ok: false,
                  toolName,
                  error: codemodeWireSafeErrorMessage(e, 0, "tools_call_code:invoke_execute_catch"),
                  nonRetryable: true,
                  nonRetryableKind: nonRetryable.kind,
                  nonRetryableReason: nonRetryable.reason,
                };
              }
              const msg = codemodeWireSafeErrorMessage(e, 0, "tools_call_code:invoke_execute_catch");
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
        return sanitizeRelayHelperReturn(
          "openapi_search",
          await (async (): Promise<Record<string, unknown>> => {
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
              return edgeClawOpenapiRelayToolFailure({
                helper: "openapi_search",
                boundarySuffix: "openapi_search:delegated_invoke",
                delegatedMcpTool: searchName,
                failureKind: inferOpenapiMirrorFailureKind(e),
                err: e,
              });
            }
          })()
        );
      },
    }),

    openapi_describe_operation: tool({
      description:
        "**Required** in the router flow after **openapi_search** and before **cloudflare_request** whenever the HTTP target has an OpenAPI operation. Loads `parameters` / `requestBody` from `spec.paths[path][method]` (exact template, e.g. `/pets/{petId}`). Allowed: `{ method, path }`. Caches schema for strict **cloudflare_request** planning in this invocation.",
      inputSchema: openapiDescribeOperationSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "openapi_describe_operation",
          await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(openapiDescribeOperationSchema, inputUnknown ?? {});
            if (!p.ok) return unknownHelperArgument(p.invalidKeys);
            bumpOpenapiSearchInvocation();

            const execName = pickWrappedToolName(relay, "execute");
            if (!execName) return { ok: false, error: "no_wrapped_execute_tool" };
            const t = relay[execName];
            if (!t) return { ok: false, error: "execute_tool_missing" };

            const inner = buildOpenApiDescribeOperationInnerCode({
              method: p.value.method,
              path: p.value.path,
            });
            try {
              const raw = await invokeToolExecute(t, { code: inner }, {
                helperMethod: "openapi_describe_operation",
                delegatedToolName: execName,
              });
              const parsed = tryParseJsonFromMcpToolResult(raw);
              let rec: Record<string, unknown> | null = null;
              if (parsed && typeof parsed === "object") {
                const uw = unwrapCloudflareApiEnvelope(parsed);
                if (
                  typeof uw.payload === "object" &&
                  uw.payload !== null &&
                  !Array.isArray(uw.payload)
                ) {
                  rec = uw.payload as Record<string, unknown>;
                } else {
                  rec = parsed as Record<string, unknown>;
                }
              }
              if (!rec || typeof rec !== "object" || Array.isArray(rec))
                return ensureJsonSafeForCodemodeRelay({
                  ok: false,
                  error:
                    "[EdgeClaw][openapi_describe_operation:inner_parse] kind=describe_parse_failed shape_missing_object",
                  boundary: "openapi_describe_operation:inner_parse",
                  helper: "openapi_describe_operation",
                  failureKind: "describe_parse_failed",
                  delegatedMcpTool: execName,
                  receivedPreview: truncateCodemodeDebugJson(parsed),
                }) as Record<string, unknown>;

              const okDescribe = typeof rec.ok === "boolean" ? rec.ok : false;
              if (!okDescribe) {
                const errTxt = typeof rec.error === "string" ? rec.error : "describe_failed";
                return ensureJsonSafeForCodemodeRelay({
                  ok: false,
                  error: `[EdgeClaw][openapi_describe_operation:inner_parse] kind=describe_returned_ok_false (${errTxt})`,
                  boundary: "openapi_describe_operation:inner_parse",
                  helper: "openapi_describe_operation",
                  failureKind: "describe_execute_ok_false",
                  delegatedMcpTool: execName,
                  receivedPreview: truncateCodemodeDebugJson(parsed),
                }) as Record<string, unknown>;
              }

              const opUnknown = rec.operation;
              if (!opUnknown || typeof opUnknown !== "object" || Array.isArray(opUnknown)) {
                return ensureJsonSafeForCodemodeRelay({
                  ok: false,
                  error:
                    "[EdgeClaw][openapi_describe_operation:inner_parse] kind=operation_missing_after_describe",
                  boundary: "openapi_describe_operation:inner_parse",
                  helper: "openapi_describe_operation",
                  failureKind: "operation_missing_after_describe",
                  delegatedMcpTool: execName,
                  receivedPreview: truncateCodemodeDebugJson(parsed),
                }) as Record<string, unknown>;
              }

              const op = opUnknown as Record<string, unknown>;
              setCapturedOpenApiOperation(p.value.method, p.value.path, op);

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
              return edgeClawOpenapiRelayToolFailure({
                helper: "openapi_describe_operation",
                boundarySuffix: "openapi_describe_operation:delegated_invoke",
                delegatedMcpTool: execName,
                failureKind: inferOpenapiMirrorFailureKind(e),
                err: e,
              });
            }
          })()
        );
      },
    }),

    cloudflare_request: tool({
      description:
        "HTTP relay via MCP execute. **Planner-required:** when OpenAPI is available, call **openapi_describe_operation** first; then pass **operationPathTemplate** (same template as describe), **knownValues** from prior structured results, plus **query** / **body**. The host blocks the call until required schema slots are satisfied — do not retry blindly. If no operation can be cached, legacy degraded relay may still run (see `executionPlannerNote`). Requires `openapi_search` or `tools_describe` discovery gate in the same invocation.",
      inputSchema: cloudflareRequestSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        return sanitizeRelayHelperReturn(
          "cloudflare_request",
          await (async (): Promise<Record<string, unknown>> => {
            const p = parseCodemodeRouterInput(cloudflareRequestSchema, inputUnknown ?? {});
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
          })()
        );
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
            const raw = await invokeToolExecute(t, { code: inner }, {
              helperMethod: "resolve_device_identifier",
              delegatedToolName: execName,
            });
            const parsed = tryParseJsonFromMcpToolResult(raw);
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
        const p = parseCodemodeRouterInput(toolsDescribeSchema, inputUnknown ?? {});
        if (!p.ok) return unknownHelperArgument(p.invalidKeys);
        const { toolName } = p.value;
        const t = relay[toolName];
        if (!t) {
          return { ok: false, error: "unknown_wrapped_tool", toolName };
        }
        markToolsDescribeSucceeded();
        return stringifyToolBrief(toolName, t);
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
            try {
              const raw = await invokeToolExecute(t, input, {
                helperMethod: "tools_call",
                delegatedToolName: toolName,
              });
              const parsed = tryParseJsonFromMcpToolResult(raw);
              return { ok: true, toolName, result: parsed };
            } catch (e) {
              const msg = codemodeWireSafeErrorMessage(e, 0, "tools_call:invoke_execute_catch");
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
