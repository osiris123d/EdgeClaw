/**
 * Schema-aware HTTP request planning for Codemode (provider-agnostic).
 *
 * Merges explicit values only. Prefers resolved `knownValues` over `proposed*` maps.
 * Ignores prose fields — never parses userInput for identifiers.
 */

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface PlannedMissingSlot {
  name: string;
  inLocation: Exclude<ParameterLocation, "cookie"> | "body";
  schema?: Record<string, unknown>;
}

export interface OpenApiExecutionPlanOk {
  ok: true;
  method: string;
  operationPathTemplate: string;
  pathParams: Record<string, string>;
  /** Path with `{segment}` placeholders URL-encoded where filled; unfilled `{}` retained. */
  renderedPath: string;
  query: Record<string, string | number | boolean | undefined>;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export type ValidateOpenApiExecutionPlanIssue = { message: string; path?: string };

export type ValidateOpenApiExecutionPlanResult =
  | { ok: true }
  | { ok: false; issues: ValidateOpenApiExecutionPlanIssue[] };

export type BuildOpenApiExecutionPlanResult =
  | OpenApiExecutionPlanOk
  | {
      ok: false;
      error: "missing_required_parameter";
      details: {
        missing: PlannedMissingSlot[];
        operation: { method: string; path: string };
      };
    };

export interface BuildOpenApiExecutionPlanArgs {
  method: string;
  path: string;
  intent?: string;
  knownValues?: Record<string, unknown>;
  userInput?: string;
  proposedQuery?: Record<string, string | number | boolean | undefined>;
  proposedHeaders?: Record<string, string>;
  proposedBody?: unknown;
  operation?: Record<string, unknown> | null;
}

const UUID_REGEX =
  /\b(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i;

/** Path segments the MCP host substitutes before execute (e.g. `{account_id}` placeholders). */
export function isHostInjectedPathOrAccountSlot(rawName: string): boolean {
  const n =
    rawName.trim().replace(/^[{\s]+/, "").replace(/\s+[\}:].*$/u, "").replace(/^["']+|["']+$/gu, "").trim();
  const low = n.toLowerCase();
  return low === "account_id" || low === "account-id" || low === "accountid" || low === "acct_id";
}

/** Proposal first then known overlay — resolved partials beat raw request literals. */
function mergeScalarMaps(
  known: Record<string, unknown> | undefined,
  proposal?: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const src of [{ ...(proposal ?? {}) }, { ...(known ?? {}) }]) {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
      else out[k] = JSON.stringify(v);
    }
  }
  return out;
}

function mergePlainHeaders(
  known: Record<string, unknown> | undefined,
  proposal: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(proposal ?? {}), ...(known ?? {}) })) {
    if (typeof v !== "string" || !v.trim()) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

export function unwrapOpenApiSchemaNode(original: Record<string, unknown>): Record<string, unknown> {
  let cur: Record<string, unknown> = original;
  for (let i = 0; i < 6; i += 1) {
    const allOf = cur.allOf;
    if (Array.isArray(allOf) && allOf.length === 1 && allOf[0] && typeof allOf[0] === "object") {
      cur = allOf[0] as Record<string, unknown>;
      continue;
    }
    break;
  }
  return cur;
}

function readBodyProp(body: Record<string, unknown>, name: string): unknown {
  const direct = body[name];
  if (direct !== undefined) return direct;
  if (!name.includes(".")) return undefined;
  let cur: unknown = body;
  for (const p of name.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** OpenAPI `{param}` placeholders in ascending path visit order */
export function pathnameTemplateParams(template: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  for (;;) {
    m = re.exec(template);
    if (!m) break;
    const raw = String(m[1]).trim();
    const key = raw.split(/[:=]/)[0]?.trim();
    if (key) names.push(key);
  }
  return names;
}

function interpolateOpenApiPath(templatePath: string, pathParams: Record<string, string>): string {
  return templatePath.replace(/\{([^}]+)\}/g, (_whole, inner: string) => {
    const key = String(inner).trim().split(/[:=]/)[0]?.trim() ?? "";
    const v = pathParams[key];
    return v !== undefined ? v : `{${String(inner)}}`;
  });
}

/** Normal cache key suffix for router ALS. */
export function normalizeOpenApiPathTemplate(template: string): string {
  return "/" + template.trim().replace(/^\/+/u, "").replace(/\\/gu, "/");
}

/** Case/shape tolerant lookup inside prior partial payloads. */
export function lookupKnown(knownValues: Record<string, unknown> | undefined, rawName: string): unknown {
  if (!knownValues) return undefined;
  const trimmed = rawName.trim();
  const candidates = new Set<string>(
    [
      trimmed,
      trimmed.replace(/-/gu, "_"),
      trimmed.replace(/_/gu, ""),
      trimmed.toLowerCase(),
    ].filter(Boolean)
  );
  for (const entry of Object.entries(knownValues)) {
    const gk = entry[0]?.toLowerCase() ?? "";
    for (const c of candidates)
      if (gk === c.toLowerCase()) return entry[1];
  }
  return knownValues[trimmed];
}

function stringifyUnified(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function firstCandidate(candidates: (string | null)[]): string | null {
  for (const c of candidates)
    if (c !== null && String(c).trim() !== "") return String(c).trim();
  return null;
}

function dedupeMissing(slots: PlannedMissingSlot[]): PlannedMissingSlot[] {
  const seen = new Set<string>();
  const out: PlannedMissingSlot[] = [];
  for (const s of slots) {
    const k = `${s.inLocation}:${s.name}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * When `operation` is null/undefined, returns **null** (caller skips strict routing).
 */
export function buildOpenApiExecutionPlan(
  args: BuildOpenApiExecutionPlanArgs
): BuildOpenApiExecutionPlanResult | null {
  void args.intent;
  void args.userInput;

  const rawOp = args.operation;
  if (rawOp === undefined || rawOp === null || typeof rawOp !== "object" || Array.isArray(rawOp))
    return null;

  const op = rawOp as Record<string, unknown>;

  const methodUpper = args.method.trim().toUpperCase();
  const pathTemplate = normalizeOpenApiPathTemplate(args.path);

  const hasOperationalShape =
    (Array.isArray(op.parameters) && op.parameters.length > 0) ||
    (typeof op.requestBody === "object" &&
      op.requestBody !== null &&
      typeof (op.requestBody as Record<string, unknown>).content === "object");
  /** Skip when describe returned `{}` stubs */
  if (!hasOperationalShape) return null;

  const operationRef = { method: methodUpper, path: pathTemplate };

  const paramsRaw = Array.isArray(op.parameters)
    ? (op.parameters.filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[])
    : [];

  let mergedScalars = mergeScalarMaps(args.knownValues, args.proposedQuery);
  const mergedHeaders = mergePlainHeaders(args.knownValues, args.proposedHeaders);

  let bodyObj: Record<string, unknown> =
    args.proposedBody !== undefined &&
    typeof args.proposedBody === "object" &&
    !Array.isArray(args.proposedBody)
      ? { ...(args.proposedBody as Record<string, unknown>) }
      : {};

  const tplSegNames = pathnameTemplateParams(pathTemplate);
  const tplSegNorm = new Set(tplSegNames.map((x) => x.toLowerCase()));

  if (args.knownValues && typeof args.knownValues === "object") {
    for (const [k, v] of Object.entries(args.knownValues)) {
      if (tplSegNorm.has(k.toLowerCase())) continue;
      if (mergedScalars[k] !== undefined) continue;
      if (typeof v !== "object" || v === null) mergedScalars[k] = v as string | number | boolean;
    }
    for (const [k, v] of Object.entries(args.knownValues)) {
      if (readBodyProp(bodyObj, k) !== undefined) continue;
      if (typeof v === "object" && v !== null) continue;
      if (tplSegNorm.has(k.toLowerCase())) continue;
      bodyObj[k] = v as unknown;
    }
  }

  const pathParams: Record<string, string> = {};
  for (const pname of tplSegNames) {
    if (isHostInjectedPathOrAccountSlot(pname)) continue;
    const kn = lookupKnown(args.knownValues, pname);
    const pq = mergedScalars[pname];
    const bo = readBodyProp(bodyObj, pname);
    const chosen =
      typeof pq === "string" || typeof pq === "number" || typeof pq === "boolean"
        ? String(pq).trim()
        : firstCandidate([stringifyUnified(kn), stringifyUnified(bo)]);
    if (chosen !== null && chosen !== "") pathParams[pname] = chosen;
  }

  const missing: PlannedMissingSlot[] = [];

  for (const p of paramsRaw) {
    const name = typeof p.name === "string" ? p.name : "";
    const whereRaw = typeof p.in === "string" ? p.in.toLowerCase() : "";
    if (!name || whereRaw === "cookie") continue;
    const where = whereRaw as ParameterLocation;
    const schemaNode =
      typeof p.schema === "object" && p.schema !== null
        ? unwrapOpenApiSchemaNode(p.schema as Record<string, unknown>)
        : ({} as Record<string, unknown>);

    const required = Boolean(p.required) || where === "path";

    if (required && isHostInjectedPathOrAccountSlot(name)) continue;

    if (where === "path") {
      if (required && (!(name in pathParams) || pathParams[name] === ""))
        missing.push({ name, inLocation: "path", schema: schemaNode });
      continue;
    }

    const kn = lookupKnown(args.knownValues, name);
    if (!required) continue;

    if (where === "query") {
      const pq = mergedScalars[name];
      const val =
        pq !== undefined ? pq : kn !== undefined && kn !== null && kn !== "" ? kn : readBodyProp(bodyObj, name);
      const empty =
        val === undefined || val === null || val === "" || (typeof val === "string" && val.trim() === "");
      if (empty) missing.push({ name, inLocation: "query", schema: schemaNode });
      continue;
    }

    if (where === "header") {
      const hv =
        mergedHeaders[name.toLowerCase()] ??
        mergedHeaders[`x-${name.toLowerCase()}`] ??
        stringifyUnified(kn)?.trim();
      if (!hv) missing.push({ name, inLocation: "header", schema: schemaNode });
      continue;
    }
  }

  const rbUnknown = op.requestBody;
  if (rbUnknown && typeof rbUnknown === "object") {
    const rb = rbUnknown as {
      required?: boolean;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    };
    if (
      typeof rb.required === "boolean" &&
      rb.required &&
      rb.content?.["application/json"]?.schema &&
      typeof rb.content["application/json"].schema === "object"
    ) {
      const bodySchemaRaw = rb.content["application/json"].schema as Record<string, unknown>;
      const bodySchema = unwrapOpenApiSchemaNode(bodySchemaRaw);

      const props =
        typeof bodySchema.properties === "object" && bodySchema.properties !== null
          ? (bodySchema.properties as Record<string, Record<string, unknown>>)
          : {};
      const rq = Array.isArray(bodySchema.required)
        ? bodySchema.required.filter((x): x is string => typeof x === "string")
        : [];
      for (const pname of rq) {
        const sub = props[pname] ?? {};
        const val = readBodyProp(bodyObj, pname) ?? lookupKnown(args.knownValues, pname);
        const empty =
          val === undefined || val === null || val === "" || (typeof val === "string" && val.trim() === "");
        if (empty) missing.push({ name: pname, inLocation: "body", schema: sub });
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: "missing_required_parameter",
      details: {
        missing: dedupeMissing(missing),
        operation: operationRef,
      },
    };
  }

  const dedupScalar: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(mergedScalars))
    if (v !== undefined && v !== "" && String(v).trim() !== "" && !tplSegNorm.has(k.toLowerCase()))
      dedupScalar[k] = v;

  const headersOut = { ...mergedHeaders };

  const bodyOutKeys = Object.keys(bodyObj).length > 0 ? bodyObj : undefined;

  let renderedPath = interpolateOpenApiPath(pathTemplate, pathParams);
  if (!renderedPath.startsWith("/")) renderedPath = `/${renderedPath}`;

  return {
    ok: true,
    method: methodUpper,
    operationPathTemplate: pathTemplate,
    pathParams,
    renderedPath,
    query: dedupScalar,
    headers: headersOut,
    body: bodyOutKeys,
  };
}

function validateAgainstSchemaSnippet(
  name: string,
  schemaFrag: Record<string, unknown>,
  value: unknown
): ValidateOpenApiExecutionPlanIssue[] {
  const issues: ValidateOpenApiExecutionPlanIssue[] = [];
  if (value === undefined || value === null || value === "") return issues;

  const base = unwrapOpenApiSchemaNode(schemaFrag);

  if (Array.isArray(base.enum) && base.enum.length > 0) {
    const allowed = base.enum.map((x: unknown) =>
      typeof x === "string" || typeof x === "number" ? x : JSON.stringify(x)
    );
    const vv =
      typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value);
    if (!allowed.some((e) => e === vv || String(e) === String(vv)))
      issues.push({ message: `value not permitted by enum (${name})`, path: name });
  }

  const fmt =
    typeof base.format === "string" ? (base.format as string).toLowerCase() : "";
  if (fmt === "uuid" && typeof value === "string" && !UUID_REGEX.test(value.trim()))
    issues.push({ message: `expected uuid (${name})`, path: name });

  return issues;
}

/**
 * Validates plan fields against enums / coarse formats declared on the cached operation object.
 */
export function validateOpenApiExecutionPlan(params: {
  plan: OpenApiExecutionPlanOk;
  operation?: Record<string, unknown> | null;
}): ValidateOpenApiExecutionPlanResult {
  const issues: ValidateOpenApiExecutionPlanIssue[] = [];
  const opUnknown = params.operation;
  const plan = params.plan;

  if (!opUnknown || typeof opUnknown !== "object") return { ok: true };

  const op = opUnknown as Record<string, unknown>;
  const paramsRaw = Array.isArray(op.parameters)
    ? (op.parameters.filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[])
    : [];

  for (const p of paramsRaw) {
    const name = typeof p.name === "string" ? p.name : "";
    const where = typeof p.in === "string" ? p.in.toLowerCase() : "";
    const schemaFrag =
      typeof p.schema === "object" && p.schema !== null
        ? unwrapOpenApiSchemaNode(p.schema as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    let valUnknown: unknown;
    if (!name || where === "cookie") continue;

    if (where === "path") valUnknown = plan.pathParams[name];
    else if (where === "query") valUnknown = plan.query[name];
    else if (where === "header") valUnknown = plan.headers[name.toLowerCase()];
    else continue;

    issues.push(...validateAgainstSchemaSnippet(name, schemaFrag, valUnknown));
  }

  const rbUnknown = op.requestBody;
  if (
    rbUnknown &&
    typeof rbUnknown === "object" &&
    plan.body &&
    typeof plan.body === "object" &&
    !Array.isArray(plan.body)
  ) {
    const rb = rbUnknown as { content?: Record<string, { schema?: Record<string, unknown> }> };
    const js = rb.content?.["application/json"]?.schema;
    if (js && typeof js === "object") {
      const bodySchema = unwrapOpenApiSchemaNode(js as Record<string, unknown>);
      const props =
        typeof bodySchema.properties === "object" && bodySchema.properties !== null
          ? (bodySchema.properties as Record<string, Record<string, unknown>>)
          : {};
      for (const [pname, sub] of Object.entries(props)) {
        const pv = pname in plan.body ? plan.body[pname] : readBodyProp(plan.body as Record<string, unknown>, pname);
        if (pv === undefined || pv === null) continue;
        issues.push(...validateAgainstSchemaSnippet(`${pname} (body)`, sub ?? {}, pv));
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true };
}
