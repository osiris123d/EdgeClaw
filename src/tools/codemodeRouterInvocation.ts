/**
 * Per-Codemode-invocation Router context (discovery gate + optional retry hints).
 *
 * Wrapped around {@link EdgeClawDynamicWorkerExecutor.execute} via `node:async_hooks`
 * AsyncLocalStorage so sequential `openapi_search` → `cloudflare_request` chains share state.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { normalizeOpenApiPathTemplate } from "./codemodeOpenApiExecutionPlan";

/** Concrete Cloudflare account id segment → OpenAPI `{account_id}` placeholder (cache + planner path). */
export function withAccountIdPlaceholderForPlannerCache(pathNormalized: string): string {
  return pathNormalized.replace(
    /\/accounts\/([a-f0-9]{32})(?=\/|$)/gi,
    "/accounts/{account_id}"
  );
}

/** Distinct normalized path variants that should alias the same planner entry. */
export function openApiPlannerCachePathVariants(pathRaw: string): string[] {
  const norm = normalizeOpenApiPathTemplate(pathRaw);
  const canon = withAccountIdPlaceholderForPlannerCache(norm);
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

export interface OpenApiPlannerCacheHit {
  operation: Record<string, unknown>;
  /** Path template to pass to {@link buildOpenApiExecutionPlan} (includes `{account_id}` placeholders). */
  planningPathTemplate: string;
}

/**
 * Locate a cached OperationObject across path aliases (template vs concrete account id segment).
 */
export function resolveOpenApiPlannerCacheHit(
  method: string,
  pathForLookup: string
): OpenApiPlannerCacheHit | undefined {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return undefined;
  const norm = normalizeOpenApiPathTemplate(pathForLookup);
  const planningPathTemplate = withAccountIdPlaceholderForPlannerCache(norm);
  for (const variant of openApiPlannerCachePathVariants(pathForLookup)) {
    const key = openapiDescribeCacheKey(method, variant);
    const opUnknown = s.openapiOperationsByTemplate[key];
    if (
      opUnknown &&
      typeof opUnknown === "object" &&
      !Array.isArray(opUnknown) &&
      Object.keys(opUnknown).length > 0
    ) {
      return { operation: opUnknown as Record<string, unknown>, planningPathTemplate };
    }
  }
  return undefined;
}

export interface CodemodeRouterInvocationStore {
  /** Stable id for one codemode invocation ALS scope. */
  invocationStoreId: string;
  /** Incremented whenever `openapi_search` is invoked (attempt counts for discovery gate). */
  openapiSearchAttempts: number;
  /** True after `tools_describe` returned a schema for a known wrapped tool. */
  toolsDescribeSuccess: boolean;
  /**
   * Populated after `openapi_describe_operation`: template path (`/pets/{petId}`, …)
   * → sanitized OpenAPI OperationObject JSON.
   */
  openapiOperationsByTemplate: Record<string, Record<string, unknown>>;
  /** Per-key describe invocation state for precise cache-miss diagnostics. */
  openapiDescribeStateByKey: Record<string, OpenApiDescribeState>;
  /** Endpoints confirmed by openapi_search in this invocation (method + normalized path). */
  openapiSearchConfirmedEndpointKeys: Record<string, true>;
}

export interface OpenApiDescribeState {
  attempted: boolean;
  succeeded: boolean;
  error?: string;
  delegatedMcpTool?: string;
}

export interface OpenApiDescribeMissingDiagnostics {
  reason: "never_called" | "called_but_failed" | "cache_key_mismatched";
  cacheKey: string;
  error?: string;
  delegatedMcpTool?: string;
}

export interface CodemodeRouterInvocationDebugSnapshot {
  invocationStorePresent: boolean;
  invocationStoreId?: string;
  openapiSearchAttempts: number;
  describeStateKeys: string[];
}

const codemodeRouterInvocationAls = new AsyncLocalStorage<CodemodeRouterInvocationStore>();

export async function runCodemodeRouterInvocation<T>(fn: () => Promise<T>): Promise<T> {
  const store: CodemodeRouterInvocationStore = {
    invocationStoreId: crypto.randomUUID(),
    openapiSearchAttempts: 0,
    toolsDescribeSuccess: false,
    openapiOperationsByTemplate: Object.create(null) as Record<string, Record<string, unknown>>,
    openapiDescribeStateByKey: Object.create(null) as Record<string, OpenApiDescribeState>,
    openapiSearchConfirmedEndpointKeys: Object.create(null) as Record<string, true>,
  };
  return codemodeRouterInvocationAls.run(store, fn);
}

/**
 * Re-enter an existing invocation store for code that runs outside the original
 * `AsyncLocalStorage` context (e.g. RPC callbacks from the codemode sandbox worker).
 * Returns `fn()` result unchanged. If `store` is `undefined` the function is called
 * without an ALS context (no-op passthrough).
 */
export function enterCodemodeRouterInvocationStore<T>(
  store: CodemodeRouterInvocationStore | undefined,
  fn: () => T
): T {
  if (!store) return fn();
  return codemodeRouterInvocationAls.run(store, fn);
}

function tryParseMaybeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function* iterSearchEndpointCandidates(value: unknown): Generator<unknown> {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || cur === null) continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const parsed = tryParseMaybeJsonString(cur);
    yield parsed;
    if (!parsed || typeof parsed !== "object") continue;
    if (Array.isArray(parsed)) {
      for (const item of parsed) queue.push(item);
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    for (const key of ["result", "results", "data", "payload", "response", "endpoints", "content"]) {
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
}

/** Record endpoints discovered by openapi_search for guarded read-only fallback routing. */
export function recordOpenApiSearchEndpoints(endpointsUnknown: unknown): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return;

  const add = (methodRaw: unknown, pathRaw: unknown): void => {
    if (typeof pathRaw !== "string" || !pathRaw.trim()) return;
    const method = typeof methodRaw === "string" && methodRaw.trim() ? methodRaw.trim().toUpperCase() : "GET";
    for (const variant of openApiPlannerCachePathVariants(pathRaw.trim())) {
      s.openapiSearchConfirmedEndpointKeys[openapiDescribeCacheKey(method, variant)] = true;
    }
  };

  for (const candidate of iterSearchEndpointCandidates(endpointsUnknown)) {
    if (!candidate || typeof candidate !== "object") continue;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        add(rec.method, rec.path);
      }
      continue;
    }
    const rec = candidate as Record<string, unknown>;
    add(rec.method, rec.path);
    if (rec.paths && typeof rec.paths === "object" && !Array.isArray(rec.paths)) {
      for (const pathKey of Object.keys(rec.paths as Record<string, unknown>)) {
        const pathItem = (rec.paths as Record<string, unknown>)[pathKey];
        if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
        for (const methodKey of Object.keys(pathItem as Record<string, unknown>)) {
          if (/^(get|post|put|patch|delete|head|options)$/i.test(methodKey)) {
            add(methodKey, pathKey);
          }
        }
      }
    }
  }
}

/** True when openapi_search confirmed this method/path in the current invocation. */
export function hasOpenApiSearchConfirmedEndpoint(method: string, pathForLookup: string): boolean {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return false;
  for (const variant of openApiPlannerCachePathVariants(pathForLookup)) {
    if (s.openapiSearchConfirmedEndpointKeys[openapiDescribeCacheKey(method, variant)]) {
      return true;
    }
  }
  return false;
}

export function getCodemodeRouterInvocationDebugSnapshot(): CodemodeRouterInvocationDebugSnapshot {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) {
    return {
      invocationStorePresent: false,
      openapiSearchAttempts: 0,
      describeStateKeys: [],
    };
  }
  return {
    invocationStorePresent: true,
    invocationStoreId: s.invocationStoreId,
    openapiSearchAttempts: s.openapiSearchAttempts,
    describeStateKeys: Object.keys(s.openapiDescribeStateByKey).sort(),
  };
}

export function openapiDescribeCacheKey(method: string, operationPathTemplate: string): string {
  return `${method.trim().toUpperCase()} ${normalizeOpenApiPathTemplate(operationPathTemplate)}`;
}

export function setCapturedOpenApiOperation(
  method: string,
  operationPathTemplate: string,
  operation: Record<string, unknown>
): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return;
  for (const variant of openApiPlannerCachePathVariants(operationPathTemplate)) {
    s.openapiOperationsByTemplate[openapiDescribeCacheKey(method, variant)] = operation;
  }
}

export function markOpenApiDescribeSucceeded(args: {
  method: string;
  operationPathTemplate: string;
  delegatedMcpTool?: string;
}): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return;
  for (const variant of openApiPlannerCachePathVariants(args.operationPathTemplate)) {
    const key = openapiDescribeCacheKey(args.method, variant);
    s.openapiDescribeStateByKey[key] = {
      attempted: true,
      succeeded: true,
      delegatedMcpTool: args.delegatedMcpTool,
    };
  }
}

export function markOpenApiDescribeFailed(args: {
  method: string;
  operationPathTemplate: string;
  error: string;
  delegatedMcpTool?: string;
}): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return;
  for (const variant of openApiPlannerCachePathVariants(args.operationPathTemplate)) {
    const key = openapiDescribeCacheKey(args.method, variant);
    s.openapiDescribeStateByKey[key] = {
      attempted: true,
      succeeded: false,
      error: args.error,
      delegatedMcpTool: args.delegatedMcpTool,
    };
  }
}

export function diagnoseMissingOpenApiDescribe(
  method: string,
  pathForLookup: string
): OpenApiDescribeMissingDiagnostics {
  const cacheKey = openapiDescribeCacheKey(method, pathForLookup);
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) {
    return { reason: "never_called", cacheKey };
  }

  const variantKeys = openApiPlannerCachePathVariants(pathForLookup).map((v) =>
    openapiDescribeCacheKey(method, v)
  );
  for (const key of variantKeys) {
    const st = s.openapiDescribeStateByKey[key];
    if (st?.attempted && st.succeeded === false) {
      return {
        reason: "called_but_failed",
        cacheKey,
        error: st.error,
        delegatedMcpTool: st.delegatedMcpTool,
      };
    }
  }

  const methodPrefix = `${method.trim().toUpperCase()} `;
  let sawAnyDescribeAttempt = false;
  let sawMethodSuccess = false;
  let latestMethodFailure: OpenApiDescribeState | undefined;
  for (const [k, st] of Object.entries(s.openapiDescribeStateByKey)) {
    if (!k.startsWith(methodPrefix)) continue;
    sawAnyDescribeAttempt = true;
    if (st.succeeded) sawMethodSuccess = true;
    if (!st.succeeded) latestMethodFailure = st;
  }

  if (latestMethodFailure && !sawMethodSuccess) {
    return {
      reason: "called_but_failed",
      cacheKey,
      error: latestMethodFailure.error,
      delegatedMcpTool: latestMethodFailure.delegatedMcpTool,
    };
  }

  if (sawMethodSuccess || sawAnyDescribeAttempt) {
    return { reason: "cache_key_mismatched", cacheKey };
  }

  return { reason: "never_called", cacheKey };
}

export function getCapturedOpenApiOperation(
  method: string,
  operationPathTemplate: string
): Record<string, unknown> | undefined {
  return resolveOpenApiPlannerCacheHit(method, operationPathTemplate)?.operation;
}

export function tryGetCodemodeRouterInvocationStore(): CodemodeRouterInvocationStore | undefined {
  return codemodeRouterInvocationAls.getStore();
}

export function bumpOpenapiSearchInvocation(): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (s) s.openapiSearchAttempts += 1;
}

export function markToolsDescribeSucceeded(): void {
  const s = codemodeRouterInvocationAls.getStore();
  if (s) s.toolsDescribeSuccess = true;
}

/**
 * Requires `openapi_search` (attempt) OR successful `tools_describe` before HTTP-style relays.
 *
 * Outside a Codemode executor session (tests / direct host callers), discovery is assumed satisfied.
 */
export function schemaLookupGateSatisfied(): boolean {
  const s = codemodeRouterInvocationAls.getStore();
  if (!s) return true;
  return s.openapiSearchAttempts > 0 || s.toolsDescribeSuccess;
}
