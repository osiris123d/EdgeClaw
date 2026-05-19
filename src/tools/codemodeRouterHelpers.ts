/**
 * Host-side helpers for the Codemode meta-tool relay: discovery, validation,
 * and safe construction of inner MCP / Code Mode tool sources (no model-authored nesting).
 */

import type { ToolSet } from "ai";
import type { Env, Variables } from "../lib/env";

/** Cloudflare device inventory GET paths — extend as products expose more list APIs. */
export const DEFAULT_DEVICE_LIST_PATH_TEMPLATES = [
  "/accounts/{account_id}/dex/fleet-status/devices",
  "/accounts/{account_id}/devices",
] as const;

export interface ToolFindMatch {
  name: string;
  score: number;
  description: string;
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\w/+:-]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/**
 * Rank tools whose **descriptions** match the query (names are opaque e.g. tool_xxx_search).
 */
export function toolsFindByDescription(query: string, relay: ToolSet): ToolFindMatch[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hayFor = (name: string, description: string) => `${name}\n${description}`.toLowerCase();

  const scored: ToolFindMatch[] = [];
  for (const name of Object.keys(relay)) {
    const def = relay[name];
    const desc =
      def && typeof def === "object" && "description" in def && typeof (def as { description?: unknown }).description === "string"
        ? (def as { description: string }).description
        : "";
    let score = 0;
    const hay = hayFor(name, desc);
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 3;
    }
    if (score > 0) scored.push({ name, score, description: desc });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

export function pickWrappedToolName(
  relay: ToolSet,
  kind: "search" | "execute"
): string | undefined {
  const suffix = kind === "search" ? "_search" : "_execute";
  const keys = Object.keys(relay).sort();
  const exact = keys.find((k) => k.startsWith("tool_") && k.endsWith(suffix));
  if (exact) return exact;
  return keys.find((k) => k.includes(suffix));
}

/**
 * Require a single async arrow expression (what MCP Code Mode evaluates).
 */
export function assertValidAsyncArrowSource(src: string): string {
  const t = src.trim();
  if (
    !/^\s*async\s*(\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*/.test(t)
  ) {
    throw new Error(
      "code must be one async arrow function (e.g. async () => { ... } or async () => expr)"
    );
  }
  return t;
}

export function injectAccountIntoApiPath(path: string, accountId: string): string {
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\{account_id\}/g, accountId);
  p = p.replace(/\/accounts\/\{account_id\}\//g, `/accounts/${accountId}/`);
  if (p.includes("{account_id}")) {
    p = p.replace("{account_id}", accountId);
  }
  return p;
}

/** Align with OpenAPI `paths` map keys (`/pets/{petId}`, …). */
function normalizeDescribePath(template: string): string {
  return "/" + template.trim().replace(/^\/+/u, "").replace(/\\/gu, "/");
}

/**
 * Sandbox inner runner: resolves one operation object from injected `spec` (same binding as openapi_search).
 * Marker `EDGECLAW_OPENAPI_DESCRIBE` distinguishes host mocks from openapi_search stubs.
 */
export function buildOpenApiDescribeOperationInnerCode(args: { method: string; path: string }): string {
  const pathLit = JSON.stringify(normalizeDescribePath(args.path));
  const methodLit = JSON.stringify(args.method.trim().toUpperCase());
  return `async () => {
/*EDGECLAW_OPENAPI_DESCRIBE*/
  const tpl = ${pathLit};
  const methodUpper = ${methodLit};
  const method = String(methodUpper || "GET").toLowerCase();
  const entry = spec.paths && spec.paths[tpl];
  if (!entry || typeof entry !== "object") {
    return { ok: false, error: "operation_not_found", operation: { method: methodUpper, path: tpl } };
  }
  const op = entry[method];
  if (!op || typeof op !== "object") {
    return { ok: false, error: "operation_not_found", operation: { method: methodUpper, path: tpl } };
  }
  // Return a compact summary only — omit deep response schemas which can exceed
  // the tool output token limit and produce truncated, unparseable JSON.
  const compact = {
    summary: op.summary,
    description: op.description,
    tags: op.tags,
    parameters: op.parameters,
    requestBody: op.requestBody,
    responses: op.responses
      ? Object.fromEntries(
          Object.entries(op.responses).map(([code, resp]) => [
            code,
            { description: resp && typeof resp === "object" ? resp.description : undefined },
          ])
        )
      : undefined,
  };
  return { ok: true, operation: compact };
}`;
}

export function buildOpenapiSearchInnerCode(filters: {
  product?: string;
  tag?: string;
  pathIncludes?: string;
  summaryIncludes?: string;
}): string {
  const f = JSON.stringify(filters);
  return `async () => {
  const filters = ${f};
  const out = [];
  const http = new Set(["get", "post", "put", "patch", "delete"]);
  const product = filters.product && String(filters.product).toLowerCase();
  const tag = filters.tag && String(filters.tag).toLowerCase();
  const pathIncludes = filters.pathIncludes && String(filters.pathIncludes).toLowerCase();
  const summaryIncludes = filters.summaryIncludes && String(filters.summaryIncludes).toLowerCase();
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!http.has(String(method).toLowerCase())) continue;
      if (typeof op !== "object" || !op) continue;
      const o = op;
      const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).toLowerCase()) : [];
      const summary = String(o.summary || "") + " " + String(o.description || "");
      if (product && !tags.some((t) => t === product || t.includes(product))) continue;
      if (tag && !tags.some((t) => t.includes(tag))) continue;
      if (pathIncludes && !String(path).toLowerCase().includes(pathIncludes)) continue;
      if (summaryIncludes && !summary.toLowerCase().includes(summaryIncludes)) continue;
      out.push({
        method: String(method).toUpperCase(),
        path,
        summary: o.summary,
        tags: o.tags,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}`;
}

export function buildCloudflareRequestInnerCode(options: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** When provided, the sandbox applies reduction before the response crosses the wire. */
  reduction?: {
    select?: string[];
    filterByPrefix?: {
      field: string;
      value?: string;
      prefix?: string;
      caseInsensitive?: boolean;
      trim?: boolean;
    };
    compactResultCap?: number;
  };
}): string {
  const { reduction, ...rest } = options;
  const payload = JSON.stringify(rest);

  if (!reduction) {
    return `async () => {
  const o = ${payload};
  return cloudflare.request({
    method: o.method,
    path: o.path,
    ...(o.query && Object.keys(o.query).length ? { query: o.query } : {}),
    ...(o.body !== undefined ? { body: o.body } : {}),
  });
}`;
  }

  // Inline the reduction plan so it runs inside the sandbox.
  // The response crosses the wire as a compact object instead of the full API payload.
  const reductionJson = JSON.stringify(reduction);
  return `async () => {
  const o = ${payload};
  const _r = ${reductionJson};
  const raw = await cloudflare.request({
    method: o.method,
    path: o.path,
    ...(o.query && Object.keys(o.query).length ? { query: o.query } : {}),
    ...(o.body !== undefined ? { body: o.body } : {}),
  });
  // Parse raw if it is a JSON string (provider may double-encode).
  let data = raw;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
  if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
  if (!data || typeof data !== "object") return { _reduced: true, items: [], scannedCount: 0, matchedCount: 0 };
  // Unwrap Cloudflare envelope.
  const rec = data;
  if (typeof rec.success === "boolean" && rec.success === false) {
    return { _reduced: true, _apiError: true, errors: rec.errors };
  }
  const payload2 = rec.result !== undefined ? rec.result : data;
  // Extract result_info for pagination.
  const resultInfo = rec.result_info || undefined;
  // Find the collection array.
  let items = [];
  if (Array.isArray(payload2)) { items = payload2; }
  else if (payload2 && typeof payload2 === "object") {
    for (const k of ["result","results","items","data","records","entries","objects"]) {
      if (Array.isArray(payload2[k])) { items = payload2[k]; break; }
    }
  }
  if (!items.length) return { _reduced: true, items: [], scannedCount: 0, matchedCount: 0, resultInfo };
  // Apply reduction.
  const sel = Array.isArray(_r.select) && _r.select.length > 0 ? _r.select : null;
  const pfx = _r.filterByPrefix;
  const pfxVal = pfx ? (pfx.value || pfx.prefix || "") : "";
  const cap = _r.compactResultCap || 50;
  const matched = [];
  let scannedCount = 0;
  let matchedCount = 0;
  for (const it of items) {
    scannedCount++;
    if (!it || typeof it !== "object") continue;
    if (pfx && pfxVal) {
      let fv = it[pfx.field];
      if (typeof fv !== "string") continue;
      const useTrim = pfx.trim !== false;
      const useCaseInsensitive = pfx.caseInsensitive !== false;
      if (useTrim) fv = fv.trim();
      const lhs = useCaseInsensitive ? fv.toLowerCase() : fv;
      const rhs = useCaseInsensitive ? pfxVal.toLowerCase() : pfxVal;
      if (!lhs.startsWith(rhs)) continue;
    }
    const row = {};
    const keys = sel || Object.keys(it).slice(0, 8);
    for (const k of keys) { if (k in it) row[k] = it[k]; }
    if (!Object.keys(row).length) continue;
    matchedCount++;
    if (matched.length < cap) matched.push(row);
  }
  return { _reduced: true, items: matched, scannedCount, matchedCount, resultInfo };
}`;
}

/** When true, emit extra codemode/RPC wire diagnostics (no payloads / secrets). */
export function isCodemodeWireDebugEnabled(): boolean {
  try {
    return (globalThis as { EDGECLAW_CODEMODE_WIRE_DEBUG?: unknown }).EDGECLAW_CODEMODE_WIRE_DEBUG === true;
  } catch {
    return false;
  }
}

function readWorkerVarString(env: Env, key: keyof Variables): string | undefined {
  const nested = env.Variables?.[key];
  if (typeof nested === "string") return nested;
  const top = env[key as keyof Env];
  return typeof top === "string" ? top : undefined;
}

function isEnvExplicitTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = value.trim().toLowerCase();
  return n === "true" || n === "1" || n === "yes" || n === "on";
}

/**
 * Reads `EDGECLAW_CODEMODE_WIRE_DEBUG` from Worker env into `globalThis` for
 * {@link isCodemodeWireDebugEnabled}. Durable Objects run in separate isolates — call from
 * MainAgent / ToolAgent constructors (and optionally Worker `fetch`) so diagnostics match env.
 */
export function syncCodemodeWireDebugFromEnv(env: Env): void {
  const raw =
    readWorkerVarString(env, "EDGECLAW_CODEMODE_WIRE_DEBUG") ??
    (typeof env.EDGECLAW_CODEMODE_WIRE_DEBUG === "string" ? env.EDGECLAW_CODEMODE_WIRE_DEBUG : undefined);
  (globalThis as { EDGECLAW_CODEMODE_WIRE_DEBUG?: boolean }).EDGECLAW_CODEMODE_WIRE_DEBUG =
    isEnvExplicitTrue(raw);
}

function logCodemodeWireReplacement(path: string, ctorName: string | undefined, v: object): void {
  if (!isCodemodeWireDebugEnabled()) return;
  let ownKeysCount = 0;
  let prototypeConstructor: string | undefined;
  try {
    ownKeysCount = Object.keys(v).length;
    prototypeConstructor = Object.getPrototypeOf(v)?.constructor?.name;
  } catch {
    /* ignore */
  }
  console.log("[EdgeClaw][codemode-wire]", {
    kind: "replaced_non_wire_value",
    path,
    constructorName: ctorName ?? "(anonymous)",
    ownKeysCount,
    prototypeConstructor,
  });
}

/** True for Workers host prototypes that must not cross Agents RPC / structuredClone. */
export function codemodeWireBlockedConstructorName(name: string | undefined): boolean {
  if (!name) return false;
  return (
    name.includes("DurableObject") ||
    name === "Fetcher" ||
    name === "RpcTarget" ||
    name === "Headers" ||
    name === "Request" ||
    name === "Response" ||
    name === "ReadableStream" ||
    name === "WritableStream" ||
    name === "TransformStream" ||
    name === "CompressionStream" ||
    name === "WebSocket" ||
    name === "MessagePort" ||
    name === "MessageChannel" ||
    name === "Blob" ||
    name === "FormData" ||
    name === "URLSearchParams"
  );
}

/**
 * Non-neutralized error chain for DEBUG logs only (may mention DurableObject / RpcTarget).
 */
export function codemodeWireRawErrorMessage(err: unknown, depth = 0): string {
  if (depth > 6) return "(cause depth limit)";
  if (err instanceof Error) {
    try {
      const m = (err.message?.trim() || err.name || "Error").slice(0, 4000);
      if ("cause" in err && err.cause !== undefined) {
        return `${m} | cause: ${codemodeWireRawErrorMessage(err.cause, depth + 1)}`.slice(0, 8000);
      }
      return m;
    } catch {
      return "Error";
    }
  }
  if (typeof err === "string") return err.slice(0, 8000);
  try {
    return String(err).slice(0, 8000);
  } catch {
    return "unknown_error";
  }
}

/** DEBUG-only: delegated MCP / codemode mirror boundary (no payloads). */
export function logCodemodeWireDelegatedBoundary(args: {
  boundaryLabel: string;
  helperMethod?: string;
  delegatedMcpToolName?: string;
  rawExecuteResolved?: boolean;
  rawConstructorName?: string;
  sanitizedConstructorName?: string;
  jsonStringifyRoundTripOk?: boolean;
  structuredCloneOk?: boolean;
  convertedByCodemodeWireSafeErrorMessage?: boolean;
  errorBeforeNeutralize?: string;
  /** When MainAgent returns `resultWire` (JSON string) across Rpc */
  resultWireByteLength?: number;
}): void {
  if (!isCodemodeWireDebugEnabled()) return;
  console.log("[EdgeClaw][codemode-wire-delegated]", args);
}

/** True when a Workers Agents RPC / structured-clone error should be softened for user-facing surfaces. */
export function codemodeWireIsInternalSerializationNoise(message: string): boolean {
  // Host-wrapped diagnostics often quote the underlying Rpc clone error in parentheses.
  // Substring checks would incorrectly collapse them to the generic neutral string.
  if (message.trimStart().startsWith("[EdgeClaw]")) return false;
  if (/serialize object of type\s*"[^"]+"/i.test(message)) return true;
  if (/Could not serialize/i.test(message) && /does not support serialization/i.test(message)) return true;
  if (/Could not serialize[\s\S]{0,160}DurableObject/i.test(message)) return true;
  if (/structured\s+clone[\s\S]{0,240}(DurableObject|RpcTarget|Fetcher)/i.test(message)) return true;
  return false;
}

/**
 * Deep-clone a meta-tool return value into JSON-safe data so
 * {@link EdgeClawToolDispatcher} can `JSON.stringify({ result })` without hitting
 * `DurableObjectStub` / Fetcher / RpcTarget (Workers structured-clone rejects those).
 */
export function toCodemodeWireSerializable(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(v: unknown, path: string): unknown {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      return v;
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "undefined") return null;
    if (typeof v === "function") return "[Function]";
    if (typeof v !== "object") return String(v);

    if (seen.has(v as object)) return "[Circular]";
    seen.add(v as object);

    if (v instanceof Error) {
      let msg: string;
      try {
        const raw = String(v.message ?? "").trim();
        msg = raw.length > 0 ? raw.slice(0, 8000) : typeof v.name === "string" && v.name ? v.name : "Error";
        if (codemodeWireIsInternalSerializationNoise(msg)) {
          msg = "Delegated tool returned a non-serializable value (internal).";
        }
      } catch {
        msg = "Error";
      }
      const outErr: Record<string, unknown> = {
        name: typeof v.name === "string" ? v.name : "Error",
        message: msg,
      };
      if ("cause" in v && v.cause !== undefined) {
        outErr.cause = walk(v.cause, `${path}.cause`);
      }
      return outErr;
    }

    const ctorName = (v as { constructor?: { name?: string } }).constructor?.name;
    if (codemodeWireBlockedConstructorName(ctorName)) {
      logCodemodeWireReplacement(path, ctorName, v as object);
      return `[${ctorName}]`;
    }

    if (Array.isArray(v)) {
      const arr = v.map((x, i) => walk(x, `${path}[${i}]`));
      seen.delete(v as object);
      return arr;
    }

    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      if (v instanceof Date) return v.toISOString();
      try {
        return walk(JSON.parse(JSON.stringify(v)) as unknown, path);
      } catch {
        logCodemodeWireReplacement(path, ctorName, v as object);
        return ctorName ? `[${ctorName}]` : "[Object]";
      }
    }

    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(v as object);
    } catch {
      logCodemodeWireReplacement(path, ctorName, v as object);
      return ctorName ? `[${ctorName}]` : "[Object]";
    }
    for (const k of keys) {
      try {
        let ev: unknown;
        try {
          ev = (v as Record<string, unknown>)[k];
        } catch {
          out[k] = "[Unreadable]";
          continue;
        }
        out[k] = walk(ev, `${path}.${k}`);
      } catch {
        out[k] = "[Unserializable]";
      }
    }
    seen.delete(v as object);
    return out;
  }

  try {
    return walk(value, "$");
  } catch {
    return { _serializationWalkFailed: true };
  }
}

/** JSON.parse(JSON.stringify(...)) after {@link toCodemodeWireSerializable} — Rpc/codemode-friendly values only. */
export function ensureJsonSafeForCodemodeRelay(value: unknown): unknown {
  return jsonParseStringifyRpcSafe(toCodemodeWireSerializable(value));
}

/** Always logs (Workers console) — no payloads; openapi mirror triage only. */
export function logCodemodeOpenapiRelayFailure(args: {
  boundaryLabel: string;
  helper: string;
  delegatedMcpTool?: string;
  failureKind: string;
  errorPreviewRaw: string;
}): void {
  const preview =
    typeof args.errorPreviewRaw === "string"
      ? args.errorPreviewRaw.slice(0, 500)
      : "(no_preview)";
  try {
    console.warn(
      "[EdgeClaw][openapi-relay-failure]",
      JSON.stringify({
        boundaryLabel: args.boundaryLabel,
        helper: args.helper,
        delegatedMcpTool: args.delegatedMcpTool,
        failureKind: args.failureKind,
        errorPreviewRaw: preview,
      })
    );
  } catch {
    /* ignore logging failures */
  }
}

/** Return shape for openapi_search / openapi_describe_operation failures — always `[EdgeClaw]` in `error`. */
export function edgeClawOpenapiRelayToolFailure(parts: {
  helper: string;
  boundarySuffix: string;
  delegatedMcpTool?: string;
  failureKind: string;
  err: unknown;
}): Record<string, unknown> {
  const preview = codemodeWireRawErrorMessage(parts.err).slice(0, 480);
  const error = `[EdgeClaw][${parts.boundarySuffix}] helper=${parts.helper} delegated=${parts.delegatedMcpTool ?? "?"} kind=${parts.failureKind}: ${preview}`;
  logCodemodeOpenapiRelayFailure({
    boundaryLabel: parts.boundarySuffix,
    helper: parts.helper,
    delegatedMcpTool: parts.delegatedMcpTool,
    failureKind: parts.failureKind,
    errorPreviewRaw: preview,
  });
  return {
    ok: false,
    error,
    boundary: parts.boundarySuffix,
    helper: parts.helper,
    ...(parts.delegatedMcpTool !== undefined ? { delegatedMcpTool: parts.delegatedMcpTool } : {}),
    failureKind: parts.failureKind,
    errorPreviewRaw: preview,
  };
}

/** MainAgent {@link rpcExecuteDelegatedMcpTool} — labeled so ToolAgent mirror never maps to generic neutral text. */
export function edgeClawRpcDelegatedMcpError(label: string, err: unknown, toolName?: string): string {
  const raw = codemodeWireRawErrorMessage(err).slice(0, 6000);
  const tool = toolName ? ` tool=${toolName}` : "";
  return `[EdgeClaw][rpcExecuteDelegatedMcpTool:${label}]${tool}: ${raw}`;
}

function jsonParseStringifyRpcSafe(sanitized: unknown): unknown {
  const json = JSON.stringify(sanitized, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v !== null && typeof v === "object") {
      const ctor = (v as object).constructor?.name;
      if (codemodeWireBlockedConstructorName(ctor)) {
        logCodemodeWireReplacement("jsonRpcSafeReplacer", ctor, v as object);
        return `[${ctor}]`;
      }
    }
    return v;
  });
  return JSON.parse(json) as unknown;
}

function probeStructuredClone(value: unknown): boolean {
  if (typeof structuredClone !== "function") return true;
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repeated JSON-freeze until `structuredClone(value)` succeeds — for raw payloads that cross
 * Agents RPC hops where only the `{ ok, result }` envelope was hardened before (ToolAgent mirrors).
 */
export function coerceStandaloneStructuredClonePortable(value: unknown): unknown {
  if (typeof structuredClone !== "function") return value;
  let cur = value;
  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    try {
      structuredClone(cur);
      return cur;
    } catch {
      try {
        cur = jsonParseStringifyRpcSafe(toCodemodeWireSerializable(cur));
      } catch {
        throw new Error("[EdgeClaw] coerceStandaloneStructuredClonePortable: json_freeze_failed");
      }
    }
  }
  throw new Error(
    `[EdgeClaw] coerceStandaloneStructuredClonePortable: clone_failed_after_${maxRounds}_rounds`
  );
}

/**
 * Agents RPC serializes `{ ok: true, result }` via structured clone. Rarely `result`
 * survives {@link toDelegatedMcpRpcWireValue} standalone but still fails when nested in
 * that envelope — then the RPC marshal throws noise that becomes the neutral delegation error.
 * Applies {@link coerceStandaloneStructuredClonePortable} plus a full-envelope probe.
 */
export function coerceDelegatedRpcOkEnvelopeResult(result: unknown): unknown {
  const portable = coerceStandaloneStructuredClonePortable(result);
  if (typeof structuredClone !== "function") return portable;
  try {
    structuredClone({ ok: true as const, result: portable });
    return portable;
  } catch (eEnvelope) {
    const again = coerceStandaloneStructuredClonePortable(portable);
    try {
      structuredClone({ ok: true as const, result: again });
      return again;
    } catch {
      throw new Error(
        `[EdgeClaw] coerceDelegatedRpcOkEnvelopeResult: envelope_clone_failed (${codemodeWireRawErrorMessage(eEnvelope)})`
      );
    }
  }
}

/**
 * Reduce delegated MCP tool output to plain JSON values safe for Workers **Agents RPC**
 * (`structuredClone` on the wire). Host-side sanitization alone can still leave values
 * that JSON would normalize but clone rejects; this applies {@link toCodemodeWireSerializable}
 * then a guarded `JSON.parse(JSON.stringify(...))` (replacer catches host constructors
 * encountered during stringify, e.g. getters / toJSON) so only JSON types cross the stub boundary.
 */
export function toDelegatedMcpRpcWireValue(value: unknown): unknown {
  const dbg = isCodemodeWireDebugEnabled();
  const sanitized = toCodemodeWireSerializable(value);
  const rawCtor =
    value !== null && value !== undefined && typeof value === "object"
      ? ((value as object).constructor?.name ?? "Object")
      : typeof value;
  const sanitizedCtor =
    sanitized !== null && sanitized !== undefined && typeof sanitized === "object"
      ? ((sanitized as object).constructor?.name ?? "Object")
      : typeof sanitized;

  let jsonSafe: unknown;
  try {
    jsonSafe = jsonParseStringifyRpcSafe(sanitized);
  } catch (e) {
    if (dbg) {
      logCodemodeWireDelegatedBoundary({
        boundaryLabel: "toDelegatedMcpRpcWireValue:json_roundtrip_failed",
        rawConstructorName: rawCtor,
        sanitizedConstructorName: sanitizedCtor,
        jsonStringifyRoundTripOk: false,
        structuredCloneOk: undefined,
        errorBeforeNeutralize: codemodeWireRawErrorMessage(e),
      });
    }
    throw new Error(
      `[EdgeClaw] delegated_mcp_rpc_wire_roundtrip_failed: ${codemodeWireSafeErrorMessage(e)}`
    );
  }

  let cloneOk = probeStructuredClone(jsonSafe);
  if (!cloneOk) {
    if (dbg) {
      logCodemodeWireDelegatedBoundary({
        boundaryLabel: "toDelegatedMcpRpcWireValue:structured_clone_failed_before_emergency",
        rawConstructorName: rawCtor,
        sanitizedConstructorName:
          jsonSafe !== null && jsonSafe !== undefined && typeof jsonSafe === "object"
            ? ((jsonSafe as object).constructor?.name ?? "Object")
            : typeof jsonSafe,
        jsonStringifyRoundTripOk: true,
        structuredCloneOk: false,
      });
    }
    try {
      const emergency = toCodemodeWireSerializable(jsonSafe);
      jsonSafe = jsonParseStringifyRpcSafe(emergency);
      cloneOk = probeStructuredClone(jsonSafe);
    } catch (e2) {
      if (dbg) {
        logCodemodeWireDelegatedBoundary({
          boundaryLabel: "toDelegatedMcpRpcWireValue:emergency_json_roundtrip_failed",
          rawConstructorName: rawCtor,
          jsonStringifyRoundTripOk: true,
          structuredCloneOk: false,
          errorBeforeNeutralize: codemodeWireRawErrorMessage(e2),
        });
      }
      throw new Error(
        `[EdgeClaw] delegated_mcp_rpc_wire_roundtrip_failed: ${codemodeWireSafeErrorMessage(e2)}`
      );
    }
    if (!cloneOk) {
      if (dbg) {
        logCodemodeWireDelegatedBoundary({
          boundaryLabel: "toDelegatedMcpRpcWireValue:structured_clone_failed_after_emergency",
          rawConstructorName: rawCtor,
          jsonStringifyRoundTripOk: true,
          structuredCloneOk: false,
        });
      }
      throw new Error(
        "[EdgeClaw] delegated_mcp_rpc_wire_roundtrip_failed: structured_clone_unsafe_after_emergency_pass"
      );
    }
    if (dbg) {
      logCodemodeWireDelegatedBoundary({
        boundaryLabel: "toDelegatedMcpRpcWireValue:recovered_after_emergency_pass",
        rawConstructorName: rawCtor,
        sanitizedConstructorName:
          jsonSafe !== null && jsonSafe !== undefined && typeof jsonSafe === "object"
            ? ((jsonSafe as object).constructor?.name ?? "Object")
            : typeof jsonSafe,
        jsonStringifyRoundTripOk: true,
        structuredCloneOk: true,
      });
    }
  }

  return jsonSafe;
}

/** Optional fields merged into one JSON-safe `result` key for Codemode Rpc `JSON.parse(wire).result`. */
export type CodemodeToolWireEnvelope = {
  result?: unknown;
  error?: unknown;
  logs?: unknown;
  meta?: unknown;
  ok?: boolean;
  tool?: string;
  details?: unknown;
};

function stringifyCodemodeWireOuterResult(safe: unknown, previewSource: unknown): string {
  try {
    return JSON.stringify({ result: safe });
  } catch (stringifyErr) {
    const fallback = {
      ok: false,
      error: "codemode_result_json_stringify_failed",
      stringifyDetail: codemodeWireSafeErrorMessage(stringifyErr),
      receivedPreview: truncateCodemodeDebugJson(previewSource, 1200),
    };
    try {
      return JSON.stringify({ result: toCodemodeWireSerializable(fallback) });
    } catch {
      return '{"result":{"ok":false,"error":"codemode_wire_fatal"}}';
    }
  }
}

/**
 * Stringify a merged Codemode tool payload as `{ result: <sanitized plain JSON> }`.
 * Never throws during stringify; sanitizes `error` / nested values.
 */
export function codemodeWireStringifyToolEnvelope(env: CodemodeToolWireEnvelope): string {
  const merged: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(env)) {
    if (val === undefined) continue;
    if (k === "error") merged[k] = codemodeWireSafeErrorMessage(val);
    else merged[k] = val;
  }
  let safe: unknown;
  try {
    safe = toCodemodeWireSerializable(merged);
  } catch (e) {
    safe = {
      ok: false,
      error: "codemode_serializable_walk_failed",
      detail: codemodeWireSafeErrorMessage(e),
    };
  }
  return stringifyCodemodeWireOuterResult(safe, merged);
}

/** Wire envelope `{ result }` for Rpc dispatcher — never throws; nested stringify failures become `{ ok:false }` payloads. */
export function codemodeWireStringifyToolResult(result: unknown): string {
  let safe: unknown;
  try {
    safe = toCodemodeWireSerializable(result);
  } catch (e) {
    safe = {
      ok: false,
      error: "codemode_serializable_walk_failed",
      detail: codemodeWireSafeErrorMessage(e),
    };
  }
  return stringifyCodemodeWireOuterResult(safe, result);
}

/** Safe short message from any thrown/captured value (never rethrows). */
export function codemodeWireSafeErrorMessage(err: unknown, depth = 0, boundaryLabel?: string): string {
  if (depth > 8) return "(cause depth limit)";
  if (err instanceof Error) {
    try {
      let m = err.message?.trim();
      let base = m && m.length > 0 ? m.slice(0, 8000) : err.name || "Error";
      if (codemodeWireIsInternalSerializationNoise(base)) {
        if (boundaryLabel && depth === 0 && isCodemodeWireDebugEnabled()) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel,
            convertedByCodemodeWireSafeErrorMessage: true,
            errorBeforeNeutralize: base.slice(0, 2000),
          });
        }
        base = "Delegated tool returned a non-serializable value (internal).";
      }
      if ("cause" in err && err.cause !== undefined) {
        const causeStr = codemodeWireSafeErrorMessage(err.cause, depth + 1);
        return `${base} | cause: ${causeStr}`.slice(0, 8000);
      }
      return base;
    } catch {
      return "Error";
    }
  }
  if (typeof err === "string") return err.slice(0, 8000);
  try {
    const s = JSON.stringify(toCodemodeWireSerializable(err));
    return s.length > 8000 ? `${s.slice(0, 8000)}…` : s;
  } catch {
    try {
      return String(err).slice(0, 8000);
    } catch {
      return "unknown_error";
    }
  }
}

/** Compact JSON preview for error diagnostics (never passes Rpc/DO stubs through). */
export function truncateCodemodeDebugJson(parsed: unknown, maxChars = 2500): string {
  try {
    const s = JSON.stringify(toCodemodeWireSerializable(parsed));
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
  } catch {
    return "(unavailable)";
  }
}

/** Unwrap MCP tool results (content[].text) and parse JSON when possible. */
export function tryParseJsonFromMcpToolResult(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "content" in raw) {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") {
            const trimmed = text.trim();
            try {
              return JSON.parse(trimmed);
            } catch {
              return trimmed;
            }
          }
        }
      }
    }
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function extractResultArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const r = (data as { result?: unknown }).result;
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object" && Array.isArray((r as { devices?: unknown }).devices)) {
      return (r as { devices: unknown[] }).devices;
    }
  }
  return null;
}

function rowScore(row: Record<string, unknown>, needle: string): number {
  const n = needle.toLowerCase();
  let s = 0;
  const keys = ["serial_number", "serial", "name", "hostname", "device_name", "device_id", "id"];
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.toLowerCase().includes(n)) s += 5;
    if (typeof v === "string" && v.toLowerCase() === n) s += 10;
  }
  return s;
}

export function pickDeviceRowsFromCloudflarePayload(data: unknown): Record<string, unknown>[] {
  const arr = extractResultArray(data);
  if (!arr) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

export interface DeviceCandidate {
  deviceId: string;
  score: number;
  serial?: string;
  name?: string;
  hostname?: string;
  raw: Record<string, unknown>;
}

export function matchDeviceNeedle(
  rows: Record<string, unknown>[],
  hostnameOrSerial: string
): DeviceCandidate[] {
  const needle = hostnameOrSerial.trim();
  if (!needle) return [];
  const candidates: DeviceCandidate[] = [];
  for (const row of rows) {
    const idRaw =
      row.device_id ?? row.id ?? row.deviceId ?? row.uuid;
    const deviceId = typeof idRaw === "string" ? idRaw : idRaw != null ? String(idRaw) : "";
    if (!deviceId) continue;
    const score = rowScore(row, needle);
    if (score <= 0) continue;
    candidates.push({
      deviceId,
      score,
      serial: typeof row.serial_number === "string" ? row.serial_number : typeof row.serial === "string" ? row.serial : undefined,
      name: typeof row.name === "string" ? row.name : undefined,
      hostname: typeof row.hostname === "string" ? row.hostname : typeof row.device_name === "string" ? row.device_name : undefined,
      raw: row,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.deviceId.localeCompare(b.deviceId));
  return candidates;
}

/**
 * True if a path accidentally uses a hostname-like token where a UUID is expected
 * (e.g. .../devices/MEMHQ.../...).
 */
export function pathUsesHostnameAsDeviceIdSegment(apiPath: string, hostnameOrSerial: string): boolean {
  const h = hostnameOrSerial.trim();
  if (!h || h.length < 4) return false;
  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(h);
  if (uuidLike) return false;
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`/devices/${esc}(/|$)`, "i");
  return re.test(apiPath);
}

/** True when `/devices/{segment}` uses a non-UUID token (likely hostname/serial mistaken for id). */
export function pathUsesLikelyHostnameAsDeviceSegment(apiPath: string): boolean {
  const m = apiPath.match(/\/devices\/([^/?#]+)/i);
  if (!m) return false;
  const seg = decodeURIComponent(m[1]!);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
    return false;
  }
  return /^[a-zA-Z0-9._-]{4,}$/.test(seg);
}
