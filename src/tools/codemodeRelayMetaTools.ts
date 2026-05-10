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
  matchDeviceNeedle,
  pathUsesHostnameAsDeviceIdSegment,
  pathUsesLikelyHostnameAsDeviceSegment,
  pickDeviceRowsFromCloudflarePayload,
  pickWrappedToolName,
  toolsFindByDescription,
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
  input: Record<string, unknown>
): Promise<unknown> {
  const exec = (t as { execute?: (inp: unknown) => unknown | Promise<unknown> }).execute;
  if (typeof exec !== "function") {
    throw new Error("Tool is missing execute()");
  }
  return exec(input);
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
      const raw = await invokeToolExecute(t, { code: inner });
      const parsed = tryParseJsonFromMcpToolResult(raw);
      const unwrapped = unwrapCloudflareApiEnvelope(parsed);
      if (!unwrapped.success) {
        return { ok: false, error: "cloudflare_api_error", details: unwrapped.errors, raw: parsed };
      }
      const envelope: Record<string, unknown> = { ok: true, result: unwrapped.payload };

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
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
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
        "Invoke a wrapped Code Mode / MCP tool with `{ toolName, code }` only — one async arrow source. Allowed keys: `toolName`, `code`. Prefer `openapi_search` / `cloudflare_request` over ad-hoc inner code.",
      inputSchema: toolsCallCodeSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
        const p = parseCodemodeRouterInput(toolsCallCodeSchema, inputUnknown ?? {});
        if (!p.ok) return unknownHelperArgument(p.invalidKeys);
        const { toolName, code } = p.value;
        const t = relay[toolName];
        if (!t) {
          return { ok: false, toolName, error: `Unknown wrapped tool "${toolName}"` };
        }
        try {
          const validated = assertValidAsyncArrowSource(code);
          const raw = await invokeToolExecute(t, { code: validated });
          return { ok: true, toolName, result: tryParseJsonFromMcpToolResult(raw) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, toolName, error: msg };
        }
      },
    }),

    openapi_search: tool({
      description:
        "Host-side OpenAPI/MCP **search** helper (no outer `spec`). Allowed: `product?`, `tag?`, `pathIncludes?`, `summaryIncludes?`. Returns `{ ok, endpoints?, error? }`.",
      inputSchema: openapiSearchSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
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
          const raw = await invokeToolExecute(t, { code: inner });
          const parsed = tryParseJsonFromMcpToolResult(raw);
          return { ok: true, endpoints: parsed };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, error: msg };
        }
      },
    }),

    openapi_describe_operation: tool({
      description:
        "**Required** in the router flow after **openapi_search** and before **cloudflare_request** whenever the HTTP target has an OpenAPI operation. Loads `parameters` / `requestBody` from `spec.paths[path][method]` (exact template, e.g. `/pets/{petId}`). Allowed: `{ method, path }`. Caches schema for strict **cloudflare_request** planning in this invocation.",
      inputSchema: openapiDescribeOperationSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
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
          const raw = await invokeToolExecute(t, { code: inner });
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
            return { ok: false, error: "describe_parse_failed", received: parsed };

          const okDescribe = typeof rec.ok === "boolean" ? rec.ok : false;
          if (!okDescribe) {
            const errTxt = typeof rec.error === "string" ? rec.error : "describe_failed";
            return { ok: false, error: errTxt, raw: parsed };
          }

          const opUnknown = rec.operation;
          if (!opUnknown || typeof opUnknown !== "object" || Array.isArray(opUnknown)) {
            return { ok: false, error: "operation_missing_after_describe", raw: parsed };
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

          return {
            ok: true,
            path: normalizeOpenApiPathTemplate(p.value.path),
            method: String(p.value.method).toUpperCase(),
            openapiParameterSlots: paramCount,
            openapiRequestBodies: rb,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, error: msg };
        }
      },
    }),

    cloudflare_request: tool({
      description:
        "HTTP relay via MCP execute. **Planner-required:** when OpenAPI is available, call **openapi_describe_operation** first; then pass **operationPathTemplate** (same template as describe), **knownValues** from prior structured results, plus **query** / **body**. The host blocks the call until required schema slots are satisfied — do not retry blindly. If no operation can be cached, legacy degraded relay may still run (see `executionPlannerNote`). Requires `openapi_search` or `tools_describe` discovery gate in the same invocation.",
      inputSchema: cloudflareRequestSchema,
      execute: async (inputUnknown: unknown): Promise<Record<string, unknown>> => {
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
            const raw = await invokeToolExecute(t, { code: inner });
            const parsed = tryParseJsonFromMcpToolResult(raw);
            const unwrapped = unwrapCloudflareApiEnvelope(parsed);
            if (!unwrapped.success) {
              failures.push(`${path}: ${JSON.stringify(unwrapped.errors)}`);
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
            const msg = e instanceof Error ? e.message : String(e);
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
        "Low-level invoke with JSON `{ toolName, input }` only — match tools_describe. Prefer openapi_search / cloudflare_request when possible.",
      inputSchema: toolsCallSchema,
      execute: async (inputUnknown: unknown): Promise<unknown> => {
        const p = parseCodemodeRouterInput(toolsCallSchema, inputUnknown ?? {});
        if (!p.ok) {
          throw new Error(`unknown_helper_argument: invalidKeys=${p.invalidKeys.join(",")}`);
        }
        const { toolName, input } = p.value;
        const t = relay[toolName];
        if (!t) throw new Error(`Unknown wrapped tool "${toolName}"`);
        return invokeToolExecute(t, input);
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
