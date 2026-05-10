/**
 * Generic Codemode turn guard: nested `ok:false` extraction, stable failure families,
 * repeated-failure cutoff, and a visible markdown summary — provider-agnostic.
 *
 * Separate from router **plumbing** — see codemodeRouterPlumbing.ts.
 */

import type { GenericCodemodeFailureFamily } from "./codemodeFailureNormalizer";
import {
  normalizeCodemodePayloadFailureSnippet,
  normalizeStructuredOkFalseNode,
} from "./codemodeFailureNormalizer";
import { isCodemodeRouterPlumbingFailureMessage } from "./codemodeRouterPlumbing";

/** Visible banner / anchor for substitute notes. */
export const CODEMODE_API_STOP_HEADING = "## Codemode stopped — validation budget exhausted";

/** When any normalized failure family reaches this tally (cumulative, nested leaves), Codemode is blocked this turn. */
export const CODEMODE_API_VALIDATION_STOP_COUNT = 3;

const UUID_RE =
  /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;

const UUID_STRICT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Loose id-style keys whose string values often hold stable opaque identifiers (schemas vary). */
const IDENTIFIER_KEYS = /^(_?id|uuid|resource_?id|identifier)$/i;

/** Typical OpenAPI temporal field naming — avoids vendor payloads. */
const TIMESTAMP_KEY_HINT =
  /(_at\b|^at\b|(^|_|)timestamp\b|(^|_|)time\b|(^|_|)updated\b|(^|_|)created\b|^date\b|(?:\.|^_)?Seen(?:At)?$)/i;

function isTemporalLikeFieldKey(fieldKey: string): boolean {
  if (TIMESTAMP_KEY_HINT.test(fieldKey)) return true;
  const k = fieldKey.replace(/^[_]+/, "").replace(/-/g, "_");
  return /(^|_|\.|[a-z0-9])[a-z0-9]+_?(at|stamp|Seen|seen)(?:_|at)?$/i.test(k);
}

function looksLikeTemporalValue(s: string): boolean {
  const t = s.trim();
  if (t.length < 10 || t.length > 80) return false;
  return /\d{4}-\d{2}-\d{2}|T\d{2}:|UTC|GMT|^\d+$/.test(t);
}

function collectStrictUuidStringsFromRecord(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const val of Object.values(row)) {
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (UUID_STRICT.test(trimmed)) out.push(trimmed);
  }
  return out;
}

/** @deprecated Use GenericCodemodeFailureFamily from codemodeFailureNormalizer */
export type ApiValidationNormalizedFamily = GenericCodemodeFailureFamily;

export function shouldForceCodemodeApiStopFinalVisibleAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (/^done\.?$/i.test(t)) return true;
  if (/^(let me|now let me|i['']ll|i will)\b/im.test(t)) return true;
  if (t.length < 220 && !/[.!?]["']?\s*$/.test(t)) return true;
  return false;
}

export interface CodemodeApiFailureAssistantInput {
  successfulFindings: string[];
  /** Sample lines (endpoint path + excerpt). */
  failedCalls: string[];
  /** Aggregated `{ family → count }` for the turn after normalization. */
  familyCounts: Array<{ family: string; count: number }>;
  nextStep: string;
}

export function formatCodemodeApiFailureAssistantMarkdown(args: CodemodeApiFailureAssistantInput): string {
  const findingsLines =
    args.successfulFindings.length > 0
      ? args.successfulFindings.map((line) => `- ${line}`)
      : ["- _(No successes were inferred from tool output snippets.)_"];

  const familyLines =
    args.familyCounts.length > 0
      ? args.familyCounts.map((fc) => `- **${fc.family}** × ${fc.count}`)
      : ["- _(No normalized failure buckets.)_"];

  const failSamples =
    args.failedCalls.length > 0
      ? args.failedCalls.map((line) => {
          const capped = line.replace(/`/g, "'").slice(0, 520);
          const ellipsis = line.length > 520 ? "…" : "";
          return `- \`${capped}${ellipsis}\``;
        })
      : ["- _(none captured)_"];

  return [
    CODEMODE_API_STOP_HEADING,
    "",
    "Codemode hit **repeated normalized failures** (including nested tool payloads with **`ok:false`**). Router helper calls (`tools_find`, `openapi_search`, `tools_describe`, HTTP relay) require **argument shapes that match their schemas**. Further `codemode` executions **this turn** are blocked to avoid blind retries.",
    "",
    "### Partial results",
    "",
    ...findingsLines,
    "",
    "### What failed",
    "",
    "_Normalized buckets (counts):_",
    "",
    ...familyLines,
    "",
    "_Examples (recent payloads, trimmed):_",
    "",
    ...failSamples,
    "",
    "### Next step",
    "",
    args.nextStep,
  ].join("\n");
}

export const CODEMODE_API_VALIDATION_BLOCKED_SUBSTITUTE_NOTE =
  "Codemode is blocked for the rest of this turn after repeated tool/API validation failures. " +
  "Review the assistant message **Codemode stopped — validation budget exhausted** (Partial results / What failed / Next step).";

export const CODEMODE_API_VALIDATION_NEXT_STEP_GENERIC =
  "Follow **`openapi_search` → `openapi_describe_operation` → `cloudflare_request`** (same invocation). After describe, call **`cloudflare_request`** with **`operationPathTemplate`** matching the OpenAPI path template, **`knownValues`** filled from prior structured results, plus **`query`** / **`body`** only as the schema allows — do not retry HTTP blindly until required parameters are satisfied.";

export function stringifyCodemodeThinkPayload(value: unknown, maxChars = 60_000): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return cap(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return cap(
      JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      maxChars
    );
  } catch {
    try {
      return cap(String(value), maxChars);
    } catch {
      return "(unprintable)";
    }
  }
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

/** Try to parse Codemode output as JSON objects for nested walks. */
export function unwrapCodemodeStructuredPayload(value: unknown): unknown {
  let v = value;
  while (typeof v === "string") {
    const t = v.trim();
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

export interface RecoverableApiValidationMatch {
  signature: GenericCodemodeFailureFamily;
  preview: string;
  pathHint?: string;
}

/**
 * Fallback matcher for unstructured blobs (whole Codemode result string).
 */
export function matchRecoverableApiValidationInCodemodeText(raw: string): RecoverableApiValidationMatch | null {
  if (!raw.trim()) return null;

  if (isCodemodeRouterPlumbingFailureMessage(raw)) return null;

  const low = raw.toLowerCase();
  if (
    /\bsyntaxerror\b/.test(low) ||
    /\bunexpected token\b/.test(low) ||
    /\bunexpected end\b/.test(low)
  ) {
    return null;
  }

  const n = normalizeCodemodePayloadFailureSnippet(raw);
  if (!n) return null;

  return {
    signature: n.family,
    preview: (n.providerMetadataHint ?? n.preview).slice(0, 440),
  };
}

const MAX_STRUCTURE_DEPTH = 14;
const MAX_STRUCTURE_NODES = 400;

interface NestedExtractStats {
  nodes: number;
}

function classifyOkFalseNode(obj: Record<string, unknown>, pathParts: string[]): RecoverableApiValidationMatch | null {
  let nodeRaw: string;
  try {
    nodeRaw = stringifyCodemodeThinkPayload(obj, 64_000);
  } catch {
    nodeRaw = String(obj);
  }

  if (isCodemodeRouterPlumbingFailureMessage(nodeRaw)) return null;

  let norm = normalizeStructuredOkFalseNode(obj);
  if (!norm) norm = normalizeCodemodePayloadFailureSnippet(nodeRaw);
  if (!norm) {
    norm = {
      family: "provider_specific_error",
      preview: cap(nodeRaw.replace(/\s+/g, " ").trim(), 400),
      providerMetadataHint: cap(nodeRaw, 960),
    };
  }

  return {
    signature: norm.family,
    preview: (norm.providerMetadataHint ?? norm.preview).slice(0, 440),
    pathHint: pathParts.length > 0 ? pathParts.join(".") : "(root)",
  };
}

function accumulateNestedValidationFailuresFromValue(
  value: unknown,
  pathParts: string[],
  depth: number,
  stats: NestedExtractStats,
  out: RecoverableApiValidationMatch[]
): void {
  if (stats.nodes >= MAX_STRUCTURE_NODES) return;
  stats.nodes += 1;
  if (depth > MAX_STRUCTURE_DEPTH) return;

  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      accumulateNestedValidationFailuresFromValue(value[i], [...pathParts, String(i)], depth + 1, stats, out);
      if (stats.nodes >= MAX_STRUCTURE_NODES) return;
    }
    return;
  }

  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  const okKnown = typeof obj.ok === "boolean";

  if (okKnown && obj.ok === false) {
    const classified = classifyOkFalseNode(obj, pathParts);
    if (classified) out.push(classified);
    return;
  }

  const keys = Object.keys(obj).slice(0, 120);
  for (const key of keys) {
    accumulateNestedValidationFailuresFromValue(obj[key], [...pathParts, key], depth + 1, stats, out);
    if (stats.nodes >= MAX_STRUCTURE_NODES) return;
  }
}

/** Gather every qualifying failure under `ok:false` leaves (siblings counted separately). */
export function extractNestedApiValidationFailures(payload: unknown): RecoverableApiValidationMatch[] {
  const root = unwrapCodemodeStructuredPayload(payload);
  const out: RecoverableApiValidationMatch[] = [];
  accumulateNestedValidationFailuresFromValue(root, [], 0, { nodes: 0 }, out);
  return out;
}

export function summarizeFailedCodemodeEndpointLine(m: RecoverableApiValidationMatch): string {
  const where = m.pathHint ?? "?";
  return `${where} · **${m.signature}** — ${m.preview.slice(0, 240)}`;
}

function accumulateSuccessHints(value: unknown, pathParts: string[], depth: number, stats: NestedExtractStats, types: Set<string>, linesOut: string[]): void {
  if (stats.nodes >= MAX_STRUCTURE_NODES) return;
  stats.nodes += 1;
  if (depth > MAX_STRUCTURE_DEPTH) return;
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 48); i += 1)
      accumulateSuccessHints(value[i], [...pathParts, String(i)], depth + 1, stats, types, linesOut);
    return;
  }
  if (typeof value !== "object") return;

  const o = value as Record<string, unknown>;

  const candidatesUnknown = o.candidates;
  if (Array.isArray(candidatesUnknown) && candidatesUnknown.length > 0) {
    types.add("inventory_matches");
    const uuidPreview = new Set<string>();
    for (const row of candidatesUnknown.slice(0, 20)) {
      if (!row || typeof row !== "object") continue;
      for (const u of collectStrictUuidStringsFromRecord(row as Record<string, unknown>)) {
        uuidPreview.add(u.toLowerCase());
        if (uuidPreview.size >= 12) break;
      }
      if (uuidPreview.size >= 12) break;
    }
    const uuidList = [...uuidPreview];
    const hint =
      uuidList.length > 0
        ? uuidList.slice(0, 6).map((id) => `\`${id}\``).join(", ")
        : `${candidatesUnknown.length} row(s)`;
    linesOut.push(`**inventory_matches** (${candidatesUnknown.length}): ${hint}`);
    if (uuidList.length > 0) types.add("resource_identifiers");
  }

  for (const [fieldKey, val] of Object.entries(o)) {
    if (typeof val !== "string" || !val.trim()) continue;
    const trimmed = val.trim();
    if (IDENTIFIER_KEYS.test(fieldKey) && UUID_STRICT.test(trimmed)) {
      types.add("resource_identifiers");
      linesOut.push(`**resource_identifiers** (\`${fieldKey}\`): \`${trimmed}\``);
    }
    if (isTemporalLikeFieldKey(fieldKey) && looksLikeTemporalValue(trimmed)) {
      types.add("timestamps");
      linesOut.push(`**timestamps** (\`${fieldKey}\`): ${trimmed.slice(0, 200)}`);
    }
  }

  const testsUnknown = o.tests;
  if (Array.isArray(testsUnknown) && testsUnknown.length > 0) {
    types.add("aggregated_metrics");
    linesOut.push(`**tests aggregate:** ${testsUnknown.length} entries`);
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    /** OpenAPI-ish aggregates: keys ending with `total` (`uniqueDevicesTotal`, `grand_total`, …). */
    if (!/total$/i.test(k.replace(/^_/, ""))) continue;
    types.add("aggregated_metrics");
    linesOut.push(`**aggregated_metrics** (\`${k}\`): ${v}`);
  }

  const keys = Object.keys(o).slice(0, 120);
  for (const key of keys) {
    accumulateSuccessHints(o[key], [...pathParts, key], depth + 1, stats, types, linesOut);
    if (stats.nodes >= MAX_STRUCTURE_NODES) return;
  }
}

export function extractStructuredSuccessFindings(payload: unknown): { lines: string[]; findingTypes: string[] } {
  const root = unwrapCodemodeStructuredPayload(payload);
  const types = new Set<string>();
  const linesOut: string[] = [];
  accumulateSuccessHints(root, [], 0, { nodes: 0 }, types, linesOut);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const ln of linesOut) {
    const k = ln.toLowerCase().replace(/\s+/g, " ");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    lines.push(ln.trim());
    if (lines.length > 28) lines.shift();
  }
  return { lines, findingTypes: [...types].sort() };
}

/** String-level heuristics (UUIDs / openapi snippets) augment structured extraction. */
export function extractSuccessfulPartialFindingsFromCodemodePayload(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const uuids = raw.match(UUID_RE);
  if (uuids) {
    for (const id of uuids) {
      const k = id.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(`**Resource identifier** \`${id}\``);
      }
    }
  }

  const low = raw.toLowerCase();
  if (/["']candidates["']/.test(raw) && /\[[\s\n\r]*\{/.test(raw)) {
    out.push("**inventory_matches** fragment (**candidates** array present).");
  }

  if (/"ok"\s*:\s*true/i.test(raw) && low.includes("openapi")) {
    out.push("OpenAPI **`openapi_search`** success fragment spotted.");
  }

  return out.slice(0, 14);
}

export interface CodemodeApiTurnStopState {
  validationEvents: RecoverableApiValidationMatch[];
  normalizedFamilyCounts: Record<string, number>;
  failedEndpointSummaries: string[];
  successfulFindingsDeduped: string[];
  successfulFindingTypes: Set<string>;
  stoppedFurtherCodemode: boolean;
}

export function createEmptyCodemodeApiTurnStopState(): CodemodeApiTurnStopState {
  return {
    validationEvents: [],
    normalizedFamilyCounts: Object.create(null) as Record<string, number>,
    failedEndpointSummaries: [],
    successfulFindingsDeduped: [],
    successfulFindingTypes: new Set(),
    stoppedFurtherCodemode: false,
  };
}

function mergeDedupLines(target: string[], incoming: string[]): void {
  const seen = new Set(target.map((s) => s.toLowerCase().replace(/\s+/g, " ")));
  for (const line of incoming) {
    const k = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    target.push(line.trim());
    if (target.length > 38) target.shift();
  }
}

export function dominantNormalizedFamilyFromCounts(counts: Record<string, number>): string {
  let dom = "";
  let bestCt = 0;
  for (const [sig, n] of Object.entries(counts)) {
    if (n > bestCt) {
      bestCt = n;
      dom = sig;
    }
  }
  return dom;
}

/** True when **any** normalized family count reaches threshold (equiv. to max-count check). */
export function anyNormalizedFailureFamilyReachedThreshold(
  counts: Record<string, number>,
  threshold: number
): boolean {
  for (const n of Object.values(counts)) {
    if (n >= threshold) return true;
  }
  return false;
}

function sortedFamilyCountsRecord(counts: Record<string, number>): Array<{ family: string; count: number }> {
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

export function buildCodemodeApiFailureMarkdownFromTurnState(
  state: CodemodeApiTurnStopState,
  nextStep: string = CODEMODE_API_VALIDATION_NEXT_STEP_GENERIC
): string | null {
  if (!state.stoppedFurtherCodemode || state.validationEvents.length === 0) return null;

  const familyCountsSorted = sortedFamilyCountsRecord(state.normalizedFamilyCounts);

  const failedCalls =
    state.failedEndpointSummaries.length > 0
      ? [...state.failedEndpointSummaries].slice(-12).reverse()
      : [...state.validationEvents.map((ev) => summarizeFailedCodemodeEndpointLine(ev))].reverse();

  return formatCodemodeApiFailureAssistantMarkdown({
    successfulFindings: [...state.successfulFindingsDeduped],
    failedCalls,
    familyCounts: familyCountsSorted,
    nextStep,
  });
}

export function recordCodemodeInvocationForApiValidationStop(params: {
  state: CodemodeApiTurnStopState;
  success: boolean;
  output: unknown;
  error: unknown;
  routerPlumbingEmergency: boolean;
  threshold?: number;
}): { justCrossedThreshold: boolean } {
  if (params.routerPlumbingEmergency || params.state.stoppedFurtherCodemode) {
    return { justCrossedThreshold: false };
  }

  const threshold = params.threshold ?? CODEMODE_API_VALIDATION_STOP_COUNT;

  const rawPayload = params.success ? params.output : params.error;

  const rawForPlumbingProbe = stringifyCodemodeThinkPayload(rawPayload);
  const plumbingProbe = params.success
    ? ""
    : isCodemodeRouterPlumbingFailureMessage(rawForPlumbingProbe)
      ? rawForPlumbingProbe
      : "";
  if (plumbingProbe) {
    return { justCrossedThreshold: false };
  }

  const rawStringBlob = stringifyCodemodeThinkPayload(rawPayload);

  mergeDedupLines(
    params.state.successfulFindingsDeduped,
    extractSuccessfulPartialFindingsFromCodemodePayload(rawStringBlob)
  );

  {
    const { lines: structLines, findingTypes } = extractStructuredSuccessFindings(rawPayload);
    mergeDedupLines(params.state.successfulFindingsDeduped, structLines);
    for (const t of findingTypes) params.state.successfulFindingTypes.add(t);
  }

  const nestedFailures = extractNestedApiValidationFailures(rawPayload);
  const failuresToApply =
    nestedFailures.length > 0 ? nestedFailures : (() => {
      const fallback = matchRecoverableApiValidationInCodemodeText(rawStringBlob);
      return fallback ? [fallback] : [];
    })();

  let justCrossed = false;
  for (const matched of failuresToApply) {
    params.state.validationEvents.push(matched);
    const fam = matched.signature as string;
    params.state.normalizedFamilyCounts[fam] = (params.state.normalizedFamilyCounts[fam] ?? 0) + 1;
    params.state.failedEndpointSummaries.push(summarizeFailedCodemodeEndpointLine(matched));
    if (params.state.failedEndpointSummaries.length > 48) params.state.failedEndpointSummaries.shift();
  }

  if (!params.state.stoppedFurtherCodemode && failuresToApply.length > 0) {
    if (anyNormalizedFailureFamilyReachedThreshold(params.state.normalizedFamilyCounts, threshold)) {
      params.state.stoppedFurtherCodemode = true;
      justCrossed = true;
    }
  }

  return { justCrossedThreshold: justCrossed };
}

/** @deprecated Prefer normalizeCodemodePayloadFailureSnippet from codemodeFailureNormalizer */
export function normalizeApiValidationFamily(raw: string): GenericCodemodeFailureFamily {
  const n = normalizeCodemodePayloadFailureSnippet(raw);
  return n?.family ?? "provider_specific_error";
}
