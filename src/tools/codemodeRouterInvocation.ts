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
  /** Incremented whenever `openapi_search` is invoked (attempt counts for discovery gate). */
  openapiSearchAttempts: number;
  /** True after `tools_describe` returned a schema for a known wrapped tool. */
  toolsDescribeSuccess: boolean;
  /**
   * Populated after `openapi_describe_operation`: template path (`/pets/{petId}`, …)
   * → sanitized OpenAPI OperationObject JSON.
   */
  openapiOperationsByTemplate: Record<string, Record<string, unknown>>;
}

const codemodeRouterInvocationAls = new AsyncLocalStorage<CodemodeRouterInvocationStore>();

export async function runCodemodeRouterInvocation<T>(fn: () => Promise<T>): Promise<T> {
  const store: CodemodeRouterInvocationStore = {
    openapiSearchAttempts: 0,
    toolsDescribeSuccess: false,
    openapiOperationsByTemplate: Object.create(null) as Record<string, Record<string, unknown>>,
  };
  return codemodeRouterInvocationAls.run(store, fn);
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
