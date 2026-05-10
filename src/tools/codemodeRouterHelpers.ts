/**
 * Host-side helpers for the Codemode meta-tool relay: discovery, validation,
 * and safe construction of inner MCP / Code Mode tool sources (no model-authored nesting).
 */

import type { ToolSet } from "ai";

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
  return { ok: true, operation: op };
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
}): string {
  const payload = JSON.stringify(options);
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

/**
 * Unwrap MCP tool results (content[].text) and parse JSON when possible.
 */
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
